import { describe, expect, it, vi } from 'vitest'
import { LlmUpstreamError } from '../port/errors'
import { GroqStt } from './stt'

const KEY = 'gsk_secret'

describe('GroqStt (fetch injetado)', () => {
  it('envia whisper-large-v3-turbo com language pt e devolve texto e duração', async () => {
    const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      new Response(JSON.stringify({ text: ' Olá, quero comprar. ', duration: 3.4, language: 'portuguese' }), { status: 200 }),
    )
    const stt = new GroqStt({ apiKey: KEY, fetch: fetch as unknown as typeof globalThis.fetch })
    const res = await stt.transcribe({ audio: new Uint8Array([1, 2, 3]), mime: 'audio/ogg; codecs=opus' })
    expect(res).toEqual({ text: 'Olá, quero comprar.', seconds: 3.4, language: 'pt' })
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`)
    const form = init?.body as FormData
    expect(form.get('model')).toBe('whisper-large-v3-turbo')
    expect(form.get('language')).toBe('pt')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('temperature')).toBe('0')
    const file = form.get('file') as File
    expect(file.name).toBe('audio.ogg')
    expect(file.type).toBe('audio/ogg')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('idioma do pedido e modelo configurado', async () => {
    const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response(JSON.stringify({ text: 'hi' })))
    const stt = new GroqStt({ apiKey: KEY, fetch: fetch as unknown as typeof globalThis.fetch, model: 'whisper-large-v3' })
    const res = await stt.transcribe({ audio: new Uint8Array([1]), mime: 'audio/mpeg', language: 'en' })
    expect(res).toEqual({ text: 'hi', seconds: 0, language: 'en' })
    const form = fetch.mock.calls[0]![1]?.body as FormData
    expect(form.get('model')).toBe('whisper-large-v3')
    expect(form.get('language')).toBe('en')
    expect((form.get('file') as File).name).toBe('audio.mp3')
  })

  it.each([
    [401, false],
    [403, false],
    [429, true],
    [502, true],
  ])('HTTP %i → LlmUpstreamError (retryable %s) sem a chave', async (status, retryable) => {
    const fetch = async () => new Response(JSON.stringify({ error: { message: `Invalid API Key ${KEY}` } }), { status })
    const stt = new GroqStt({ apiKey: KEY, fetch: fetch as unknown as typeof globalThis.fetch })
    const err = await stt.transcribe({ audio: new Uint8Array([1]), mime: 'audio/ogg' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmUpstreamError)
    expect(err).toMatchObject({ details: { provider: 'groq', status, retryable } })
    expect((err as Error).message).not.toContain(KEY)
  })

  it('resposta sem texto → LlmUpstreamError', async () => {
    const fetch = async () => new Response(JSON.stringify({}))
    const stt = new GroqStt({ apiKey: KEY, fetch: fetch as unknown as typeof globalThis.fetch })
    await expect(stt.transcribe({ audio: new Uint8Array([1]), mime: 'audio/ogg' })).rejects.toBeInstanceOf(LlmUpstreamError)
  })
})
