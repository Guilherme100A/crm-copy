// AC-T12-05: toPttOgg chama o ffmpeg com -ac 1 -c:a libopus e saída ogg; runner falhando → erro tipado.
// Nenhum teste executa ffmpeg real: o runner é sempre injetado (e FFMPEG_PATH aponta para um binário inexistente).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { audio } from './support'

let toPttOgg: any
let AudioConversionError: any

beforeAll(async () => {
  ;({ toPttOgg, AudioConversionError } = await audio())
})

afterEach(() => vi.unstubAllEnvs())

const input = new Uint8Array([1, 2, 3, 4, 5])
const ogg = new Uint8Array([79, 103, 103, 83, 9, 9, 9])
const stderrOk = 'Input #0, mp3\n  Duration: 00:00:03.50, start: 0.000000\nsize=  12kB time=00:00:03.48 bitrate= 28.2kbits/s\n'

const okRunner = () => vi.fn(async (_cmd: string, _args: string[], _stdin: Uint8Array) => ({ code: 0, stdout: ogg, stderr: stderrOk }))

const pairAt = (args: string[], flag: string, value: string) => args.some((a, i) => a === flag && args[i + 1] === value)

describe('T12 — toPttOgg', () => {
  it('AC-T12-05 chama o ffmpeg com -ac 1 -c:a libopus e saída ogg, entrada pelo stdin', async () => {
    const runner = okRunner()
    const r = await toPttOgg(input, { runner, ffmpegPath: 'C:/nao/existe/ffmpeg.exe' })
    expect(runner).toHaveBeenCalledTimes(1)
    const [cmd, args, stdin] = runner.mock.calls[0]!
    expect(cmd).toBe('C:/nao/existe/ffmpeg.exe')
    expect(pairAt(args, '-ac', '1'), args.join(' ')).toBe(true)
    expect(pairAt(args, '-c:a', 'libopus'), args.join(' ')).toBe(true)
    expect(pairAt(args, '-f', 'ogg'), args.join(' ')).toBe(true)
    expect(pairAt(args, '-ar', '48000'), 'Ogg/Opus 48 kHz').toBe(true)
    expect(Buffer.from(stdin)).toEqual(Buffer.from(input))
    expect(Buffer.from(r.audio)).toEqual(Buffer.from(ogg))
    expect(r.mime).toContain('audio/ogg')
    expect(r.seconds).toBeGreaterThan(3.4)
    expect(r.seconds).toBeLessThan(3.6)
  })

  it('AC-T12-05 usa FFMPEG_PATH quando ffmpegPath não é informado', async () => {
    vi.stubEnv('FFMPEG_PATH', 'C:/ffmpeg-fake/bin/ffmpeg.exe')
    const runner = okRunner()
    await toPttOgg(input, { runner })
    expect(runner.mock.calls[0]![0]).toBe('C:/ffmpeg-fake/bin/ffmpeg.exe')
  })

  it('AC-T12-05 runner com exit code != 0 → AudioConversionError', async () => {
    const runner = vi.fn(async () => ({ code: 1, stdout: new Uint8Array(), stderr: 'Invalid data found when processing input' }))
    const err: any = await toPttOgg(input, { runner, ffmpegPath: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AudioConversionError)
    expect(err.code).toBe('AUDIO_CONVERSION')
  })

  it('AC-T12-05 runner que rejeita (ffmpeg ausente) → AudioConversionError', async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })
    })
    const err: any = await toPttOgg(input, { runner, ffmpegPath: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AudioConversionError)
    expect(err.code).toBe('AUDIO_CONVERSION')
  })

  it('AC-T12-05 saída vazia → AudioConversionError', async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: new Uint8Array(), stderr: stderrOk }))
    await expect(toPttOgg(input, { runner, ffmpegPath: 'x' })).rejects.toBeInstanceOf(AudioConversionError)
  })
})
