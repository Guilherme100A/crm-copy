import { describe, expect, it } from 'vitest'
import { AiKeysError } from './errors'
import { apiBaseUrl, httpKeyProbe } from './http'

const respond = (status: number) => {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string> })
    return new Response('{}', { status })
  }) as unknown as typeof fetch
  return { fn, seen }
}

describe('httpKeyProbe', () => {
  it.each([
    ['anthropic', 'https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }],
    ['openai', 'https://api.openai.com/v1/models', { authorization: 'Bearer k' }],
    ['google', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': 'k' }],
    ['openrouter', 'https://openrouter.ai/api/v1/key', { authorization: 'Bearer k' }],
    ['elevenlabs', 'https://api.elevenlabs.io/v1/voices', { 'xi-api-key': 'k' }],
    ['groq', 'https://api.groq.com/openai/v1/models', { authorization: 'Bearer k' }],
  ] as const)('%s chama o endpoint autenticado', async (provider, url, headers) => {
    const f = respond(200)
    await httpKeyProbe({ fetch: f.fn, env: {} })({ provider, secret: 'k' })
    expect(f.seen[0]!.url).toBe(url)
    expect(f.seen[0]!.headers).toMatchObject(headers)
  })

  it('status de erro → AiKeysError upstream sem a chave', async () => {
    const err = await httpKeyProbe({ fetch: respond(401).fn, env: {} })({ provider: 'openai', secret: 'sk-SECRET' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AiKeysError)
    expect((err as Error).message).toBe('openai respondeu 401')
  })

  it('falha de rede → mensagem genérica', async () => {
    const boom = (async () => {
      throw new Error('connect ECONNREFUSED sk-SECRET')
    }) as unknown as typeof fetch
    const err = (await httpKeyProbe({ fetch: boom, env: {} })({ provider: 'groq', secret: 'sk-SECRET' }).catch((e: unknown) => e)) as Error
    expect(err.message).toBe('falha de rede ao chamar groq')
  })
})

describe('apiBaseUrl', () => {
  it('env sobrescreve e tira a barra final', () => {
    expect(apiBaseUrl('openrouter', { OPENROUTER_API_URL: 'http://127.0.0.1:9/api/v1/' })).toBe('http://127.0.0.1:9/api/v1')
    expect(apiBaseUrl('openrouter', {})).toBe('https://openrouter.ai/api/v1')
  })
})
