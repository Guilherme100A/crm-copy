// Só mocks: MockLanguageModelV4 (ai/test) e fetch injetado. Nenhuma chamada a provedor real (SPEC 1.4 nº 10).
import { generateText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { LlmUpstreamError } from '../port/errors'
import { llmTool, type LlmRequest } from '../port/llm'
import {
  buildLanguageModel,
  createAiSdkProvider,
  DEFAULT_FACTORIES,
  InvalidModelRefError,
  normalizeUsage,
  OPENROUTER_MODEL_SETTINGS,
  OPENROUTER_PROVIDER_SETTINGS,
  toModelMessages,
  type ResolveCredentials,
} from './provider'

const usage = (input: number, output: number, cacheRead?: number, reasoning?: number, cacheWrite?: number) => ({
  inputTokens: { total: input, noCache: input - (cacheRead ?? 0), cacheRead, cacheWrite },
  outputTokens: { total: output, text: output - (reasoning ?? 0), reasoning },
})

const toolCall = (id: string, name: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage: usage(100, 10, 40, 5, 7),
  warnings: [],
})

const textResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: usage(120, 20, 60, 8),
  warnings: [],
})

const baseReq = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  instructions: 'Você é um atendente.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Oi' }] }],
  tenantId: 'company-1',
  agentId: 'agent-1',
  ...over,
})

const creds: ResolveCredentials = ({ companyId, provider }) => ({ apiKey: `key-${companyId}-${provider}` })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('createAiSdkProvider com MockLanguageModelV4', () => {
  it('2 tools + output: object validado, steps e usage com cacheRead/reasoning dos details', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCall('c1', 'buscarCliente', { telefone: '+5511999999999' }),
        toolCall('c2', 'moverLead', { leadId: 'L1', etapa: 'proposta' }),
        textResult(JSON.stringify({ intent: 'compra', confidence: 0.9 })),
      ],
    })
    const ctxs: unknown[] = []
    const buscarCliente = llmTool({
      name: 'buscarCliente',
      description: 'Busca o cliente pelo telefone',
      input: z.object({ telefone: z.string() }),
      execute: async (input, ctx) => {
        ctxs.push(ctx)
        return { id: 'L1', telefone: input.telefone }
      },
    })
    const moverLead = llmTool({
      name: 'moverLead',
      description: 'Move o lead de etapa',
      input: z.object({ leadId: z.string(), etapa: z.string() }),
      execute: async ({ leadId, etapa }) => ({ ok: true, leadId, etapa }),
    })
    const provider = createAiSdkProvider({ resolveCredentials: creds, createModel: () => model })
    const res = await provider.generate(
      baseReq({ tools: [buscarCliente, moverLead], maxSteps: 2, output: z.object({ intent: z.string(), confidence: z.number() }) }),
    )
    expect(res.object).toEqual({ intent: 'compra', confidence: 0.9 })
    expect(res.finish).toBe('stop')
    expect(res.steps).toHaveLength(3)
    expect(res.steps[0]).toMatchObject({
      index: 0,
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'c1', toolName: 'buscarCliente', input: { telefone: '+5511999999999' } }],
      toolResults: [{ toolCallId: 'c1', toolName: 'buscarCliente', output: { id: 'L1', telefone: '+5511999999999' }, isError: false }],
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, reasoningTokens: 5, cacheWriteTokens: 7 },
    })
    expect(res.steps[1]!.toolResults[0]).toMatchObject({ toolName: 'moverLead', output: { ok: true, leadId: 'L1', etapa: 'proposta' } })
    expect(res.usage).toEqual({ inputTokens: 320, outputTokens: 40, cacheReadTokens: 140, cacheWriteTokens: 14, reasoningTokens: 18, costMicros: 0 })
    expect(ctxs[0]).toMatchObject({ tenantId: 'company-1', agentId: 'agent-1', toolCallId: 'c1' })
    expect(model.doGenerateCalls).toHaveLength(3)
    // instructions vira mensagem system do spec; sem mensagens system dentro de `messages`.
    expect(model.doGenerateCalls[0]!.prompt[0]).toMatchObject({ role: 'system', content: 'Você é um atendente.' })
  })

  it('stopWhen = isStepCount(maxSteps (+1 com output)): limite de tools vira finish tool-limit', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [toolCall('a', 'eco', { x: 1 }), toolCall('b', 'eco', { x: 2 }), toolCall('c', 'eco', { x: 3 })] })
    const eco = llmTool({ name: 'eco', description: 'eco', input: z.object({ x: z.number() }), execute: async (i) => i })
    const provider = createAiSdkProvider({ resolveCredentials: creds, createModel: () => model })
    const res = await provider.generate(baseReq({ tools: [eco], maxSteps: 2 }))
    expect(res.steps).toHaveLength(2)
    expect(res.finish).toBe('tool-limit')
  })

  it('erro na tool vira toolResult com isError e o loop segue', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [toolCall('e1', 'falha', {}), textResult('desculpe')] })
    const falha = llmTool({
      name: 'falha',
      description: 'sempre falha',
      input: z.object({}),
      execute: async () => {
        throw new Error('crm fora do ar')
      },
    })
    const res = await createAiSdkProvider({ resolveCredentials: creds, createModel: () => model }).generate(baseReq({ tools: [falha] }))
    expect(res.text).toBe('desculpe')
    expect(res.steps[0]!.toolResults).toEqual([{ toolCallId: 'e1', toolName: 'falha', output: 'crm fora do ar', isError: true }])
  })

  it('saída estruturada inválida → finish error OUTPUT_VALIDATION (não lança)', async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textResult('não é json')] })
    const res = await createAiSdkProvider({ resolveCredentials: creds, createModel: () => model }).generate(
      baseReq({ output: z.object({ intent: z.string() }) }),
    )
    expect(res.finish).toBe('error')
    expect(res.error?.code).toBe('OUTPUT_VALIDATION')
    expect(res.object).toBeUndefined()
  })

  it('maxRetries 0 nos provedores; store false só na OpenAI; instructions e stopWhen passados', async () => {
    for (const provider of ['anthropic', 'openai', 'google', 'openrouter'] as const) {
      const generate = vi.fn((o: Parameters<typeof generateText>[0]) => generateText(o))
      const p = createAiSdkProvider({
        resolveCredentials: creds,
        createModel: () => new MockLanguageModelV4({ doGenerate: [textResult('ok')] }),
        generate: generate as unknown as typeof generateText,
      })
      await p.generate(baseReq({ model: { provider, model: provider === 'openrouter' ? 'anthropic/claude-sonnet-5-5' : 'm' } }))
      const opts = generate.mock.calls[0]![0] as Record<string, unknown>
      expect(opts.maxRetries).toBe(0)
      expect(opts.instructions).toBe('Você é um atendente.')
      expect(opts.stopWhen).toBeDefined()
      expect(typeof opts.model).not.toBe('string')
      if (provider === 'openai') expect(opts.providerOptions).toEqual({ openai: { store: false } })
      else expect(opts.providerOptions).toBeUndefined()
    }
  })
})

describe('modelo por empresa (nunca string)', () => {
  it('resolveCredentials é chamado por companyId e a chave resolvida vai no header do provedor', async () => {
    const resolve = vi.fn(creds)
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: 'olá' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 },
      }),
    )
    const provider = createAiSdkProvider({ resolveCredentials: resolve, fetch: fetch as unknown as typeof globalThis.fetch })
    const a = await provider.generate(baseReq({ tenantId: 'empresa-a' }))
    await provider.generate(baseReq({ tenantId: 'empresa-b' }))
    expect(a.text).toBe('olá')
    // Anthropic: `input_tokens` não inclui o cache; o AI SDK soma (12 + 4) no total de entrada.
    expect(a.usage).toMatchObject({ inputTokens: 16, outputTokens: 3, cacheReadTokens: 4 })
    expect(resolve.mock.calls.map((c) => c[0])).toEqual([
      { companyId: 'empresa-a', provider: 'anthropic' },
      { companyId: 'empresa-b', provider: 'anthropic' },
    ])
    const headers = fetch.mock.calls.map((c) => new Headers(c[1]?.headers).get('x-api-key'))
    expect(headers).toEqual(['key-empresa-a-anthropic', 'key-empresa-b-anthropic'])
    expect(String(fetch.mock.calls[0]![0])).toMatch(/^https:\/\/api\.anthropic\.com\//)
  })

  it('buildLanguageModel cria instância com as fábricas certas e a chave resolvida', () => {
    const calls: Record<string, unknown> = {}
    const fake = (name: string) => (settings: unknown) => {
      calls[name] = settings
      return (modelId: string) => DEFAULT_FACTORIES.anthropic({ apiKey: 'x' })(modelId)
    }
    const factories = { anthropic: fake('anthropic'), openai: fake('openai'), google: fake('google') }
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      const m = buildLanguageModel({ provider, model: 'm1' }, { apiKey: `k-${provider}`, baseURL: 'https://proxy/v1' }, { factories })
      expect(typeof m).toBe('object')
      expect(calls[provider]).toEqual({ apiKey: `k-${provider}`, baseURL: 'https://proxy/v1' })
    }
    expect(() => buildLanguageModel({ provider: 'openai', model: 'm' }, { apiKey: '' })).toThrow(InvalidModelRefError)
  })

  it('HTTP 401/429/5xx do provedor → LlmUpstreamError sem a chave na mensagem', async () => {
    for (const status of [401, 429, 503]) {
      const fetch = async () => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key key-company-1-anthropic' } }, status)
      const p = createAiSdkProvider({ resolveCredentials: creds, fetch: fetch as unknown as typeof globalThis.fetch })
      const err = await p.generate(baseReq()).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LlmUpstreamError)
      expect(err).toMatchObject({ code: 'UPSTREAM_ERROR', details: { provider: 'anthropic', status } })
      expect((err as Error).message).not.toContain('key-company-1')
      expect((err as LlmUpstreamError).details.retryable).toBe(status !== 401)
    }
  })
})

describe('OpenRouter', () => {
  const completion = (cost?: number) =>
    jsonResponse({
      id: 'gen-1',
      object: 'chat.completion',
      created: 1760000000,
      model: 'anthropic/claude-sonnet-5-5',
      provider: 'Anthropic',
      choices: [{ index: 0, message: { role: 'assistant', content: 'oi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, ...(cost !== undefined ? { cost } : {}) },
    })

  it('modelo fornecedor/modelo, usage include, sem fallback e custo exposto em costMicros', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => completion(0.0012))
    const p = createAiSdkProvider({ resolveCredentials: creds, fetch: fetch as unknown as typeof globalThis.fetch })
    const res = await p.generate(baseReq({ model: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5-5' } }))
    expect(res.text).toBe('oi')
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costMicros: 1200 })
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer key-company-1-openrouter')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', usage: { include: true }, provider: { allow_fallbacks: false } })
  })

  it('compatibility strict na fábrica; modelo sem "fornecedor/" é recusado', () => {
    expect(OPENROUTER_PROVIDER_SETTINGS.compatibility).toBe('strict')
    expect(OPENROUTER_MODEL_SETTINGS).toEqual({ usage: { include: true } })
    const spy = vi.fn(DEFAULT_FACTORIES.openrouter)
    buildLanguageModel({ provider: 'openrouter', model: 'openai/gpt-6-luna' }, { apiKey: 'k' }, { factories: { openrouter: spy }, openRouter: { appName: 'CRM' } })
    expect(spy.mock.calls[0]![0]).toMatchObject({ apiKey: 'k', compatibility: 'strict', extraBody: { provider: { allow_fallbacks: false } }, appName: 'CRM' })
    expect(() => buildLanguageModel({ provider: 'openrouter', model: 'claude-sonnet-5-5' }, { apiKey: 'k' })).toThrow(InvalidModelRefError)
  })

  it('sem custo informado → costMicros 0', () => {
    expect(normalizeUsage(undefined, { openrouter: { usage: {} } }).costMicros).toBe(0)
    expect(normalizeUsage(undefined, { openrouter: { usage: { cost: 0.5 } } }).costMicros).toBe(500_000)
  })
})

describe('toModelMessages', () => {
  it('converte texto, imagem, arquivo, tool-call, tool result e preserva providerData', () => {
    const msgs = toModelMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'veja' },
          { type: 'image', mime: 'image/png', url: 'https://x/y.png' },
          { type: 'file', mime: 'application/pdf', data: new Uint8Array([1]), filename: 'a.pdf' },
          { type: 'audio', mime: 'audio/ogg', data: new Uint8Array([2]) },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'f', input: { a: 1 } }], providerData: { google: { thoughtSignature: 'sig' } } },
      { role: 'tool', toolCallId: 't1', toolName: 'f', result: { ok: true } },
      { role: 'tool', toolCallId: 't2', toolName: 'f', result: 'falhou', isError: true },
    ])
    expect(msgs[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'veja' },
        { type: 'image', mediaType: 'image/png' },
        { type: 'file', mediaType: 'application/pdf', filename: 'a.pdf' },
        { type: 'file', mediaType: 'audio/ogg' },
      ],
    })
    expect((msgs[0] as { content: { image?: unknown }[] }).content[1]!.image).toBeInstanceOf(URL)
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'f', input: { a: 1 } }],
      providerOptions: { google: { thoughtSignature: 'sig' } },
    })
    expect(msgs[2]).toMatchObject({ role: 'tool', content: [{ type: 'tool-result', output: { type: 'json', value: { ok: true } } }] })
    expect(msgs[3]).toMatchObject({ content: [{ output: { type: 'error-json', value: 'falhou' } }] })
  })
})
