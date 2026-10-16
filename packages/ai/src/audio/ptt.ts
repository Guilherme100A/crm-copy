// Nota de voz do WhatsApp (PTT): sempre Ogg/Opus mono 48 kHz, normalizado com ffmpeg mesmo quando o TTS já
// entrega Opus (container e canais variam entre provedores — STACK E §2.3). O runner é injetável: nenhum teste
// executa o ffmpeg real.
import { spawn } from 'node:child_process'

export const PTT_MIME = 'audio/ogg; codecs=opus'

export interface FfmpegResult {
  code: number
  stdout: Uint8Array
  stderr: string
}

/** Executa `command args…` com `stdin` e devolve código de saída, stdout (bytes) e stderr (texto). */
export type FfmpegRunner = (command: string, args: string[], stdin: Uint8Array) => Promise<FfmpegResult>

export interface PttOptions {
  runner?: FfmpegRunner
  /** Default `FFMPEG_PATH` ou `ffmpeg` no PATH. */
  ffmpegPath?: string
  /** Default `32k` (voz). */
  bitrate?: string
}

export interface PttResult {
  audio: Uint8Array
  mime: typeof PTT_MIME
  /** Duração em segundos (o Baileys usa para o player; 0 deixa "0:00"). */
  seconds: number
}

export class AudioConversionError extends Error {
  readonly code = 'AUDIO_CONVERSION'
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly stderr?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AudioConversionError'
  }
}

/** Argumentos do ffmpeg: stdin → Ogg/Opus mono 48 kHz em stdout. */
export function pttArgs(bitrate = '32k'): string[] {
  return ['-hide_banner', '-loglevel', 'info', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', bitrate, '-f', 'ogg', 'pipe:1']
}

/** Duração a partir do stderr: último `time=HH:MM:SS.xx` (saída), senão `Duration:` (entrada). */
export function parseFfmpegSeconds(stderr: string): number {
  const toSeconds = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s)
  const times = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)]
  const last = times.at(-1)
  if (last) return round2(toSeconds(last[1]!, last[2]!, last[3]!))
  const d = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
  return d ? round2(toSeconds(d[1]!, d[2]!, d[3]!)) : 0
}

const round2 = (n: number) => Math.round(n * 100) / 100

export async function toPttOgg(input: Uint8Array, opts: PttOptions = {}): Promise<PttResult> {
  if (!input || input.byteLength === 0) throw new AudioConversionError('áudio vazio')
  const command = opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg'
  const runner = opts.runner ?? spawnRunner
  let res: FfmpegResult
  try {
    res = await runner(command, pttArgs(opts.bitrate), input)
  } catch (err) {
    throw new AudioConversionError(`ffmpeg não executou: ${err instanceof Error ? err.message : String(err)}`, undefined, undefined, { cause: err })
  }
  const tail = res.stderr.slice(-2000)
  if (res.code !== 0) throw new AudioConversionError(`ffmpeg saiu com código ${res.code}`, res.code, tail)
  if (!res.stdout || res.stdout.byteLength === 0) throw new AudioConversionError('ffmpeg não produziu áudio', res.code, tail)
  return { audio: res.stdout, mime: PTT_MIME, seconds: parseFfmpegSeconds(res.stderr) }
}

/** Runner real: `child_process.spawn`, stdin/stdout em pipe (sem arquivos temporários). */
export const spawnRunner: FfmpegRunner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8')
      if (err.length > 64_000) err = err.slice(-32_000)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: new Uint8Array(Buffer.concat(out)), stderr: err }))
    child.stdin.on('error', () => undefined)
    child.stdin.end(Buffer.from(stdin))
  })
