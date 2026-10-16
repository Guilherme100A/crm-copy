// AC-T12-01..03: createAiSdkProvider (AI SDK 7) com MockLanguageModelV4, fábricas e generate espionados.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { aiCore, aiTest, aisdk, finish, llmReq, v4Usage, zodPkg } from './support'

let createAiSdkProvider: any
let MockLanguageModelV4: any
let generateText: any
let z: any

beforeAll(async () => {
  ;({ createAiSdkProvider } = await aisdk())
  ;({ MockLanguageModelV4 } = await aiTest())
  ;({ generateText } = await aiCore())
  z = await zodPkg()
})

const textModel = (text = 'ok') =>
  new MockLanguageModelV4({
    doGenerate: { content: [{ type: 'text', text }], finishReason: finish('stop'), usage: v4Usage({ input: 10, output: 5 }), warnings: [] },
  })

describe('T12 — tools, output e usage (AC-T12-01)', () => {
  it('AC-T12-01 chamada com 2 tools e output devolve object validado, steps e usage com cacheRead/reasoning mapeados', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'buscar_produto', input: JSON.stringify({ sku: 'A1' }) },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'calcular_frete', input: JSON.stringify({ cep: '01001000' }) },
          ],
          finishReason: finish('tool-calls'),
          usage: v4Usage({ input: 100, output: 20, cacheRead: 30, cacheWrite: 7, reasoning: 5 }),
          warnings: [],
        },
        {
          content: [{ type: 'text', text: JSON.stringify({ resposta: 'Produto A1 com frete 12', total: 112 }) }],
          finishReason: finish('stop'),
          usage: v4Usage({ input: 150, output: 40, cacheRead: 50, reasoning: 10 }),
          warnings: [],
        },
      ],
    })
    const ctxs: any[] = []
    const buscar = vi.fn(async (input: { sku: string }, ctx: any) => {
      ctxs.push(ctx)
      return { sku: input.sku, preco: 100 }
    })
    const frete = vi.fn(async (input: { cep: string }, ctx: any) => {
      ctxs.push(ctx)
      return { cep: input.cep, valor: 12 }
    })
    const provider = createAiSdkProvider({
      resolveCredentials: async () => ({ apiKey: 'sk-test' }),
      createModel: () => model,
    })
    const output = z.object({ resposta: z.string(), total: z.number() })
    const res = await provider.generate(
      llmReq({
        tools: [
          { name: 'buscar_produto', description: 'busca produto', input: z.object({ sku: z.string() }), execute: buscar },
          { name: 'calcular_frete', description: 'frete', input: z.object({ cep: z.string() }), execute: frete },
        ],
        output,
        maxSteps: 3,
      }),
    )
    expect(res.finish).toBe('stop')
    expect(res.object).toEqual({ resposta: 'Produto A1 com frete 12', total: 112 })
    expect(buscar).toHaveBeenCalledTimes(1)
    expect(buscar.mock.calls[0]![0]).toEqual({ sku: 'A1' })
    expect(frete.mock.calls[0]![0]).toEqual({ cep: '01001000' })
    // contexto do tenant chega às tools (nunca global)
    for (const c of ctxs) expect(c).toMatchObject({ tenantId: 'company-A', agentId: 'agent-1' })

    expect(res.steps).toHaveLength(2)
    expect(res.steps[0].toolCalls.map((t: any) => t.toolName).sort()).toEqual(['buscar_produto', 'calcular_frete'])
    expect(res.steps[0].toolResults.find((t: any) => t.toolName === 'buscar_produto')?.output).toEqual({ sku: 'A1', preco: 100 })
    expect(res.steps[0].finishReason).toBe('tool-calls')
    expect(res.steps[0].usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 7, reasoningTokens: 5 })

    expect(res.usage).toMatchObject({ inputTokens: 250, outputTokens: 60, cacheReadTokens: 80, cacheWriteTokens: 7, reasoningTokens: 15 })
  })

  it('AC-T12-01 output inválido não lança: finish error com OUTPUT_VALIDATION', async () => {
    const provider = createAiSdkProvider({
      resolveCredentials: async () => ({ apiKey: 'sk-test' }),
      createModel: () => textModel(JSON.stringify({ resposta: 42 })),
    })
    const res = await provider.generate(llmReq({ output: z.object({ resposta: z.string() }) }))
    expect(res.finish).toBe('error')
    expect(res.error?.code).toBe('OUTPUT_VALIDATION')
    expect(res.object).toBeUndefined()
  })

  it('AC-T12-01 instructions vão como instructions (não como mensagem system) e o loop é limitado (+1 com output)', async () => {
    const generate = vi.fn((args: any) => generateText(args))
    const provider = createAiSdkProvider({
      resolveCredentials: async () => ({ apiKey: 'sk-test' }),
      createModel: () => textModel(JSON.stringify({ a: 'x' })),
      generate,
    })
    await provider.generate(llmReq({ output: z.object({ a: z.string() }), maxSteps: 4 }))
    const args = generate.mock.calls[0]![0]
    expect(args.instructions).toBe('Você é um assistente de testes.')
    expect(args.system).toBeUndefined()
    expect((args.messages ?? []).some((m: any) => m.role === 'system')).toBe(false)
    expect(args.stopWhen, 'sem stopWhen (isStepCount)').toBeDefined()
  })
})

describe('T12 — modelo por empresa (AC-T12-02)', () => {
  it('AC-T12-02 resolveCredentials é chamado com o companyId de cada chamada e a chave vira a instância do provedor', async () => {
    const keys: Record<string, string> = { 'company-A': 'sk-A-111', 'company-B': 'sk-B-222' }
    const resolveCredentials = vi.fn(async ({ companyId }: any) => ({ apiKey: keys[companyId] }))
    const created: any[] = []
    const mkFactory = (provider: string) =>
      vi.fn((settings: any) => {
        created.push({ provider, apiKey: settings.apiKey })
        return Object.assign((modelId: string) => textModel(`${provider}:${modelId}`), {
          languageModel: (modelId: string) => textModel(`${provider}:${modelId}`),
          chat: (modelId: string) => textModel(`${provider}:${modelId}`),
          responses: (modelId: string) => textModel(`${provider}:${modelId}`),
        })
      })
    const factories = { anthropic: mkFactory('anthropic'), openai: mkFactory('openai'), google: mkFactory('google'), openrouter: mkFactory('openrouter') }
    const generate = vi.fn((args: any) => generateText(args))
    const provider = createAiSdkProvider({ resolveCredentials, factories, generate })

    await provider.generate(llmReq({ tenantId: 'company-A' }))
    await provider.generate(llmReq({ tenantId: 'company-B' }))
    await provider.generate(llmReq({ tenantId: 'company-A', model: { provider: 'openai', model: 'gpt-6.1-sol' } }))

    expect(resolveCredentials.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ companyId: 'company-A', provider: 'anthropic' }),
      expect.objectContaining({ companyId: 'company-B', provider: 'anthropic' }),
      expect.objectContaining({ companyId: 'company-A', provider: 'openai' }),
    ])
    expect(created).toEqual([
      { provider: 'anthropic', apiKey: 'sk-A-111' },
      { provider: 'anthropic', apiKey: 'sk-B-222' },
      { provider: 'openai', apiKey: 'sk-A-111' },
    ])
    for (const [args] of generate.mock.calls) {
      expect(typeof args.model, 'model passado como string (iria pelo AI Gateway)').toBe('object')
      expect(args.model.specificationVersion).toBe('v4')
    }
  })

  it('AC-T12-02 sem createModel/factories, o modelo é instância do provedor (nunca string) criada com a chave da empresa', async () => {
    const seen: string[] = []
    const generate = vi.fn(async (args: any) => {
      seen.push(typeof args.model)
      throw new Error('parar antes da rede')
    })
    const resolveCredentials = vi.fn(async () => ({ apiKey: 'sk-only-this' }))
    const provider = createAiSdkProvider({ resolveCredentials, generate })
    for (const p of [
      { provider: 'anthropic', model: 'claude-haiku-5-5' },
      { provider: 'openai', model: 'gpt-6-luna' },
      { provider: 'google', model: 'gemini-3.8-flash' },
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-5-5' },
    ]) {
      await provider.generate(llmReq({ model: p })).catch(() => undefined)
    }
    expect(seen).toEqual(['object', 'object', 'object', 'object'])
    expect(resolveCredentials).toHaveBeenCalledTimes(4)
  })
})

describe('T12 — store:false e maxRetries:0 (AC-T12-03)', () => {
  const run = async (provider: string, model: string) => {
    const generate = vi.fn((args: any) => generateText(args))
    const p = createAiSdkProvider({ resolveCredentials: async () => ({ apiKey: 'k' }), createModel: () => textModel(), generate })
    await p.generate(llmReq({ model: { provider, model } }))
    return generate.mock.calls[0]![0]
  }

  it('AC-T12-03 OpenAI: providerOptions.openai.store === false', async () => {
    const args = await run('openai', 'gpt-6.1-sol')
    expect(args.providerOptions?.openai?.store).toBe(false)
  })

  for (const [provider, model] of [
    ['anthropic', 'claude-sonnet-5-5'],
    ['openai', 'gpt-6.1-sol'],
    ['google', 'gemini-3.8-flash'],
  ] as const) {
    it(`AC-T12-03 ${provider}: maxRetries === 0`, async () => {
      const args = await run(provider, model)
      expect(args.maxRetries).toBe(0)
    })
  }
})
