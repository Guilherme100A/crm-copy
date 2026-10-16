// AC-T12-06: provedor openrouter com fetch mockado — modelo fornecedor/modelo, compatibility 'strict',
// usage { include: true }, sem fallback silencioso, custo da OpenRouter exposto em LlmUsage.costMicros.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { aisdk, fakeFetch, jsonResponse, llmReq, openRouterPkg, zodPkg } from './support'

let mod: any
let createOpenRouter: any

beforeAll(async () => {
  mod = await aisdk()
  ;({ createOpenRouter } = await openRouterPkg())
})

const OR_KEY = 'sk-or-v1-secret-TEST'

/** Resposta de chat completion no formato da OpenRouter, com custo. */
const completion = (cost: number, content = 'Olá!') => ({
  id: `gen-${Math.random().toString(36).slice(2)}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'anthropic/claude-sonnet-5-5',
  provider: 'Anthropic',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    cost,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 4 },
  },
})

const orReq = (extra: Record<string, unknown> = {}) => llmReq({ model: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5-5' }, ...extra })

describe('T12 — OpenRouter', () => {
  it('AC-T12-06 envia o modelo fornecedor/modelo, usage.include e provider.allow_fallbacks=false; custo vai para costMicros', async () => {
    const f = fakeFetch(() => jsonResponse(200, completion(0.001234)))
    const provider = mod.createAiSdkProvider({ resolveCredentials: async () => ({ apiKey: OR_KEY }), fetch: f })
    const res = await provider.generate(orReq())
    expect(f.calls.length).toBeGreaterThanOrEqual(1)
    const c = f.calls[0]!
    expect(new URL(c.url).hostname).toBe('openrouter.ai')
    expect(new URL(c.url).pathname).toMatch(/\/api\/v1\/chat\/completions$/)
    expect(c.headers.get('authorization')).toBe(`Bearer ${OR_KEY}`)
    const body = c.body as any
    expect(body.model).toBe('anthropic/claude-sonnet-5-5')
    expect(body.usage).toEqual({ include: true })
    expect(body.provider?.allow_fallbacks, 'fallback silencioso de provedor não desligado').toBe(false)
    expect(res.text).toBe('Olá!')
    expect(res.usage.costMicros).toBe(1234)
    expect(res.usage).toMatchObject({ inputTokens: 120, outputTokens: 30 })
  })

  it('AC-T12-06 o provider OpenRouter é criado com compatibility strict (configuração e instância)', async () => {
    expect(mod.OPENROUTER_PROVIDER_SETTINGS).toMatchObject({ compatibility: 'strict', extraBody: { provider: { allow_fallbacks: false } } })
    expect(mod.OPENROUTER_MODEL_SETTINGS).toMatchObject({ usage: { include: true } })
    const f = fakeFetch(() => jsonResponse(200, completion(0.0005)))
    const openrouter = vi.fn((settings: any) => createOpenRouter(settings))
    const provider = mod.createAiSdkProvider({ resolveCredentials: async () => ({ apiKey: OR_KEY }), fetch: f, factories: { openrouter } })
    await provider.generate(orReq())
    expect(openrouter).toHaveBeenCalledTimes(1)
    expect(openrouter.mock.calls[0]![0]).toMatchObject({ apiKey: OR_KEY, compatibility: 'strict' })
  })

  it('AC-T12-06 custo somado em vários passos (tool call + resposta)', async () => {
    let n = 0
    const f = fakeFetch(() => {
      n++
      if (n === 1)
        return jsonResponse(200, {
          ...completion(0.001),
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'eco', arguments: JSON.stringify({ v: 'x' }) } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })
      return jsonResponse(200, completion(0.002, 'feito'))
    })
    const z = await zodPkg()
    const provider = mod.createAiSdkProvider({ resolveCredentials: async () => ({ apiKey: OR_KEY }), fetch: f })
    const res = await provider.generate(
      orReq({ tools: [{ name: 'eco', description: 'eco', input: z.object({ v: z.string() }), execute: async (i: any) => i }], maxSteps: 3 }),
    )
    expect(res.text).toBe('feito')
    expect(res.steps).toHaveLength(2)
    expect(res.usage.costMicros).toBe(3000)
  })
})
