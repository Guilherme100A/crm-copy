import { describe, expect, it, vi } from 'vitest'
import { LlmUpstreamError } from '../port/errors'
import { ElevenLabsTts } from './tts'

const KEY = 'el-secret-key'

describe('ElevenLabsTts (fetch injetado)', () => {
  it('envia voz, modelo, idioma e formato; devolve bytes, mime e caracteres', async () => {
    const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    const tts = new ElevenLabsTts({ apiKey: KEY, fetch: fetch as unknown as typeof globalThis.fetch })
    const res = await tts.synthesize({ text: 'Olá, tudo bem?', voiceId: 'voz 1', format: 'ogg_opus' })
    expect(res).toEqual({ audio: new Uint8Array([1, 2, 3]), mime: 'audio/ogg', chars: 14 })
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://api.elevenlabs.io/v1/text-to-speech/voz%201?output_format=opus_48000_64')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('xi-api-key')).toBe(KEY)
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Olá, tudo bem?', model_id: 'eleven_flash_v2_5', language_code: 'pt' })
  })

  it('modelo do pedido vence; multilingual_v2 não recebe language_code', async () => {
    const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response(new Uint8Array([9])))
    const tts = new ElevenLabsTts({ apiKey: KEY, fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: 'http://fake/' })
    await tts.synthesize({ text: 'a', voiceId: 'v', format: 'mp3', model: 'eleven_multilingual_v2' })
    expect(String(fetch.mock.calls[0]![0])).toBe('http://fake/v1/text-to-speech/v?output_format=mp3_44100_128')
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ text: 'a', model_id: 'eleven_multilingual_v2' })
  })

  it.each([
    [401, false],
    [429, true],
    [500, true],
    [503, true],
  ])('HTTP %i → LlmUpstreamError (retryable %s) sem a chave', async (status, retryable) => {
    const fetch = async () => new Response(JSON.stringify({ detail: `bad key ${KEY}` }), { status })
    const tts = new ElevenLabsTts({ apiKey: KEY, fetch: fetch as unknown as typeof globalThis.fetch })
    const err = await tts.synthesize({ text: 'a', voiceId: 'v', format: 'ogg_opus' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmUpstreamError)
    expect(err).toMatchObject({ code: 'UPSTREAM_ERROR', details: { provider: 'elevenlabs', status, retryable } })
    expect((err as Error).message).not.toContain(KEY)
  })

  it('falha de rede → LlmUpstreamError sem detalhes crus', async () => {
    const fetch = async () => {
      throw new TypeError(`connect ECONNREFUSED ${KEY}`)
    }
    const tts = new ElevenLabsTts({ apiKey: KEY, fetch: fetch as unknown as typeof globalThis.fetch })
    const err = await tts.synthesize({ text: 'a', voiceId: 'v', format: 'ogg_opus' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmUpstreamError)
    expect(JSON.stringify({ m: (err as Error).message, c: String((err as Error).cause) })).not.toContain(KEY)
  })

  it('exige apiKey', () => {
    expect(() => new ElevenLabsTts({ apiKey: '' })).toThrow()
  })
})
