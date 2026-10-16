import { describe, expect, it } from 'vitest'
import { ElevenLabsTts, GroqStt } from '@crm/ai'
import { ProviderNotConfiguredError } from './errors'
import { createCompanyLlmProvider, resolveStt, resolveTts } from './providers'

const keys = {
  resolveCredentials: async (companyId: string, provider: string) => {
    if (companyId === 'sem-chave') throw new ProviderNotConfiguredError(provider)
    return { apiKey: `key-${companyId}-${provider}`, source: 'company' as const }
  },
}

describe('createCompanyLlmProvider', () => {
  it('cada generate usa a chave da empresa do tenantId', async () => {
    const seen: unknown[] = []
    const llm = createCompanyLlmProvider({
      keys,
      createModel: ({ companyId, provider, credentials }) => {
        seen.push({ companyId, provider, apiKey: credentials.apiKey })
        throw new Error('parou')
      },
    })
    const req = (tenantId: string) => ({ tenantId, agentId: 'ag', instructions: '', model: { provider: 'openai' as const, model: 'gpt' }, messages: [] })
    await expect(llm.generate(req('co-a'))).rejects.toThrow('parou')
    await expect(llm.generate(req('co-b'))).rejects.toThrow('parou')
    expect(seen).toEqual([
      { companyId: 'co-a', provider: 'openai', apiKey: 'key-co-a-openai' },
      { companyId: 'co-b', provider: 'openai', apiKey: 'key-co-b-openai' },
    ])
    await expect(llm.generate(req('sem-chave'))).rejects.toBeInstanceOf(ProviderNotConfiguredError)
  })
})

describe('resolveTts / resolveStt', () => {
  it('monta ElevenLabs e Groq com a chave da empresa e a URL do env', async () => {
    const seen: string[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      seen.push(`${url} ${JSON.stringify(init?.headers)}`)
      return new Response(new Uint8Array([1]), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const tts = await resolveTts('co', { keys, fetch, env: { ELEVENLABS_API_URL: 'http://el.fake' } })
    expect(tts).toBeInstanceOf(ElevenLabsTts)
    await tts.synthesize({ text: 'oi', voiceId: 'v1', format: 'mp3' }).catch(() => undefined)
    expect(seen[0]).toContain('http://el.fake/')
    expect(seen[0]).toContain('key-co-elevenlabs')
    expect(await resolveStt('co', { keys, env: {} })).toBeInstanceOf(GroqStt)
    await expect(resolveTts('sem-chave', { keys })).rejects.toBeInstanceOf(ProviderNotConfiguredError)
  })
})
