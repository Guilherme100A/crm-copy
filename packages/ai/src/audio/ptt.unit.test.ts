// Runner injetado: nenhum teste executa o ffmpeg real.
import { describe, expect, it, vi } from 'vitest'
import { AudioConversionError, parseFfmpegSeconds, PTT_MIME, toPttOgg, type FfmpegRunner } from './ptt'

const STDERR = [
  "Input #0, mp3, from 'pipe:0':",
  '  Duration: 00:00:04.20, start: 0.000000, bitrate: 128 kb/s',
  'size=       4kB time=00:00:02.10 bitrate=  15.6kbits/s speed= 40x',
  'size=      17kB time=00:00:04.18 bitrate=  33.3kbits/s speed= 41x',
].join('\n')

describe('toPttOgg', () => {
  it('chama o ffmpeg com Ogg/Opus mono 48 kHz e devolve bytes, mime e duração', async () => {
    const out = new Uint8Array([0x4f, 0x67, 0x67, 0x53])
    const runner = vi.fn<FfmpegRunner>(async () => ({ code: 0, stdout: out, stderr: STDERR }))
    const input = new Uint8Array([1, 2, 3])
    const res = await toPttOgg(input, { runner, ffmpegPath: '/usr/bin/ffmpeg' })
    expect(res).toEqual({ audio: out, mime: PTT_MIME, seconds: 4.18 })
    const [cmd, args, stdin] = runner.mock.calls[0]!
    expect(cmd).toBe('/usr/bin/ffmpeg')
    expect(stdin).toBe(input)
    const joined = args.join(' ')
    expect(joined).toContain('-ac 1')
    expect(joined).toContain('-c:a libopus')
    expect(joined).toContain('-ar 48000')
    expect(joined).toContain('-f ogg')
    expect(args.at(-1)).toBe('pipe:1')
  })

  it('usa FFMPEG_PATH quando não informado', async () => {
    const prev = process.env.FFMPEG_PATH
    process.env.FFMPEG_PATH = 'C:/tools/ffmpeg.exe'
    try {
      const runner = vi.fn<FfmpegRunner>(async () => ({ code: 0, stdout: new Uint8Array([1]), stderr: '' }))
      await toPttOgg(new Uint8Array([1]), { runner })
      expect(runner.mock.calls[0]![0]).toBe('C:/tools/ffmpeg.exe')
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_PATH
      else process.env.FFMPEG_PATH = prev
    }
  })

  it('código de saída ≠ 0, runner que rejeita, saída vazia ou entrada vazia → AudioConversionError', async () => {
    const failing: FfmpegRunner = async () => ({ code: 1, stdout: new Uint8Array(), stderr: 'Invalid data found when processing input' })
    const err = await toPttOgg(new Uint8Array([1]), { runner: failing }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AudioConversionError)
    expect(err).toMatchObject({ code: 'AUDIO_CONVERSION', exitCode: 1, stderr: 'Invalid data found when processing input' })

    const enoent: FfmpegRunner = async () => {
      throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })
    }
    await expect(toPttOgg(new Uint8Array([1]), { runner: enoent })).rejects.toBeInstanceOf(AudioConversionError)
    await expect(toPttOgg(new Uint8Array([1]), { runner: async () => ({ code: 0, stdout: new Uint8Array(), stderr: '' }) })).rejects.toBeInstanceOf(
      AudioConversionError,
    )
    await expect(toPttOgg(new Uint8Array(), { runner: failing })).rejects.toBeInstanceOf(AudioConversionError)
  })

  it('parseFfmpegSeconds: último time=, senão Duration:, senão 0', () => {
    expect(parseFfmpegSeconds(STDERR)).toBe(4.18)
    expect(parseFfmpegSeconds('  Duration: 00:01:02.50, start')).toBe(62.5)
    expect(parseFfmpegSeconds('nada')).toBe(0)
  })
})
