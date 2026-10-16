// Adapter LlmProvider sobre o Vercel AI SDK 7 (STACK F.2/F.3/F.7/F.8). Único ponto que importa `ai`/`@ai-sdk/*`.
// Regras: provider criado POR EMPRESA com a chave resolvida (nunca `model` como string → Vercel AI Gateway),
// `maxRetries: 0` (retry é do BullMQ), `instructions` (v7), `isStepCount(maxSteps (+1 com output))`,
// `store: false` na OpenAI, usage normalizado e somado nos passos, `providerData` opaco preservado.
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import {
  APICallError,
  generateText,
  isStepCount,
  NoObjectGeneratedError,
  Output,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import { LlmUpstreamError } from '../port/errors'
import {
  addUsage,
  DEFAULT_MAX_STEPS,
  emptyUsage,
  type LlmFinish,
  type LlmMessage,
  type LlmModelRef,
  type LlmPart,
  type LlmProvider,
  type LlmProviderId,
  type LlmRequest,
  type LlmResult,
  type LlmStep,
  type LlmStepFinishReason,
  type LlmUsage,
} from '../port/llm'

export interface ResolvedCredentials {
  apiKey: string
  /** Endpoint alternativo (proxy, região). */
  baseURL?: string
}

/** Chave do provedor para a empresa (BYOK ou chave da plataforma). Chamado a cada `generate`. */
export type ResolveCredentials = (input: { companyId: string; provider: LlmProviderId }) => ResolvedCredentials | Promise<ResolvedCredentials>

type FetchFn = typeof globalThis.fetch

interface FactorySettings {
  apiKey: string
  baseURL?: string
  fetch?: FetchFn
}

/** Fábricas dos providers (injetáveis em testes). */
export interface ProviderFactories {
  anthropic: (settings: FactorySettings) => (modelId: string) => LanguageModel
  openai: (settings: FactorySettings) => (modelId: string) => LanguageModel
  google: (settings: FactorySettings) => (modelId: string) => LanguageModel
  openrouter: (
    settings: FactorySettings & typeof OPENROUTER_PROVIDER_SETTINGS & { appName?: string; appUrl?: string },
  ) => (modelId: string, settings: typeof OPENROUTER_MODEL_SETTINGS) => LanguageModel
}

/** OpenRouter: API oficial (`strict`) e sem fallback silencioso de provedor upstream (STACK F.8 #2 e #6). */
export const OPENROUTER_PROVIDER_SETTINGS = {
  compatibility: 'strict',
  extraBody: { provider: { allow_fallbacks: false } },
} as const satisfies { compatibility: 'strict'; extraBody: Record<string, unknown> }

/** OpenRouter: contabilidade de uso/custo na resposta (`providerMetadata.openrouter.usage.cost`). */
export const OPENROUTER_MODEL_SETTINGS = { usage: { include: true } } as const

export const DEFAULT_FACTORIES: ProviderFactories = {
  anthropic: (s) => createAnthropic(s),
  openai: (s) => createOpenAI(s),
  google: (s) => createGoogle(s),
  openrouter: (s) => {
    const provider = createOpenRouter({ ...s, extraBody: { ...s.extraBody } })
    return (modelId, settings) => provider(modelId, settings)
  },
}

export class InvalidModelRefError extends Error {
  readonly code = 'VALIDATION_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidModelRefError'
  }
}

const OPENROUTER_MODEL = /^[^/\s]+\/[^\s]+$/

export interface BuildModelOptions {
  fetch?: FetchFn
  factories?: Partial<ProviderFactories>
  openRouter?: { appName?: string; appUrl?: string }
}

/** Cria a instância do modelo com as credenciais da empresa. Nunca devolve string (sem Vercel AI Gateway). */
export function buildLanguageModel(ref: LlmModelRef, credentials: ResolvedCredentials, opts: BuildModelOptions = {}): LanguageModel {
  if (!credentials?.apiKey) throw new InvalidModelRefError(`sem chave para o provedor ${ref.provider}`)
  const factories = { ...DEFAULT_FACTORIES, ...opts.factories }
  const settings: FactorySettings = { apiKey: credentials.apiKey }
  if (credentials.baseURL) settings.baseURL = credentials.baseURL
  if (opts.fetch) settings.fetch = opts.fetch
  switch (ref.provider) {
    case 'anthropic':
      return factories.anthropic(settings)(ref.model)
    case 'openai':
      return factories.openai(settings)(ref.model)
    case 'google':
      return factories.google(settings)(ref.model)
    case 'openrouter': {
      if (!OPENROUTER_MODEL.test(ref.model)) {
        throw new InvalidModelRefError(`modelo OpenRouter deve ser "fornecedor/modelo", recebido "${ref.model}"`)
      }
      const provider = factories.openrouter({ ...settings, ...OPENROUTER_PROVIDER_SETTINGS, ...opts.openRouter })
      return provider(ref.model, OPENROUTER_MODEL_SETTINGS)
    }
    default:
      throw new InvalidModelRefError(`provedor desconhecido: ${String((ref as { provider: unknown }).provider)}`)
  }
}

export interface AiSdkProviderOptions extends BuildModelOptions {
  resolveCredentials: ResolveCredentials
  /** Substitui a criação do modelo (testes: `MockLanguageModelV4`). */
  createModel?: (input: { provider: LlmProviderId; model: string; credentials: ResolvedCredentials; companyId: string }) => LanguageModel
  /** `generateText` injetável (spy em testes). */
  generate?: typeof generateText
}

// ------------------------------------------------------------------ conversões

function media(part: { url?: string; data?: Uint8Array }): URL | Uint8Array {
  return part.url !== undefined ? new URL(part.url) : part.data!
}

function userPart(part: LlmPart) {
  switch (part.type) {
    case 'text':
      return { type: 'text' as const, text: part.text }
    case 'image':
      return { type: 'image' as const, image: media(part), mediaType: part.mime }
    case 'audio':
      return { type: 'file' as const, data: media(part), mediaType: part.mime }
    case 'file':
      return part.filename !== undefined
        ? { type: 'file' as const, data: media(part), mediaType: part.mime, filename: part.filename }
        : { type: 'file' as const, data: media(part), mediaType: part.mime }
    case 'tool-call':
      throw new InvalidModelRefError('tool-call só em mensagens do assistente')
  }
}

/** LlmMessage (porta) → ModelMessage (AI SDK). `providerData` do assistente volta como `providerOptions`. */
export function toModelMessages(messages: LlmMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === 'user') return { role: 'user', content: m.content.map(userPart) }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            output: m.isError ? { type: 'error-json', value: toJsonValue(m.result) } : { type: 'json', value: toJsonValue(m.result) },
          },
        ],
      }
    }
    const content = m.content.map((p) => {
      if (p.type === 'text') return { type: 'text' as const, text: p.text }
      if (p.type === 'tool-call') return { type: 'tool-call' as const, toolCallId: p.toolCallId, toolName: p.toolName, input: p.input }
      throw new InvalidModelRefError(`parte ${p.type} não é aceita em mensagem do assistente`)
    })
    const msg: ModelMessage = { role: 'assistant', content }
    if (m.providerData && typeof m.providerData === 'object') {
      ;(msg as { providerOptions?: unknown }).providerOptions = m.providerData
    }
    return msg
  })
}

type JsonValue = null | string | number | boolean | JsonValue[] | { [k: string]: JsonValue }

function toJsonValue(value: unknown): JsonValue {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue)
}

/** Usage do AI SDK → LlmUsage (campos ausentes = 0). `costMicros` só com custo informado (OpenRouter). */
export function normalizeUsage(usage: LanguageModelUsage | undefined, providerMetadata?: unknown): LlmUsage {
  const u = emptyUsage()
  if (usage) {
    u.inputTokens = usage.inputTokens ?? 0
    u.outputTokens = usage.outputTokens ?? 0
    u.cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0
    u.cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0
    u.reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0
  }
  const cost = (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost
  if (typeof cost === 'number' && Number.isFinite(cost)) u.costMicros = Math.round(cost * 1_000_000)
  return u
}

function stepFinish(reason: string): LlmStepFinishReason {
  switch (reason) {
    case 'tool-calls':
      return 'tool-calls'
    case 'length':
      return 'length'
    case 'content-filter':
      return 'refusal'
    case 'error':
      return 'error'
    default:
      return 'stop'
  }
}

interface StepLike {
  text: string
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>
  toolResults: ReadonlyArray<{ toolCallId: string; toolName: string; output: unknown }>
  content: ReadonlyArray<{ type: string; toolCallId?: string; toolName?: string; error?: unknown }>
  finishReason: string
  usage: LanguageModelUsage
  providerMetadata: unknown
}

function toStep(step: StepLike, index: number): LlmStep {
  const errors = step.content
    .filter((p) => p.type === 'tool-error')
    .map((p) => ({ toolCallId: p.toolCallId!, toolName: p.toolName!, output: errorText(p.error), isError: true }))
  const out: LlmStep = {
    index,
    text: step.text,
    toolCalls: step.toolCalls.map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })),
    toolResults: [...step.toolResults.map((r) => ({ toolCallId: r.toolCallId, toolName: r.toolName, output: r.output, isError: false })), ...errors],
    usage: normalizeUsage(step.usage, step.providerMetadata),
    finishReason: stepFinish(step.finishReason),
  }
  if (step.providerMetadata !== undefined) out.providerData = step.providerMetadata
  return out
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ------------------------------------------------------------------ provider

export function createAiSdkProvider(opts: AiSdkProviderOptions): LlmProvider {
  const generate = opts.generate ?? generateText

  return {
    async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const companyId = req.tenantId
      const credentials = await opts.resolveCredentials({ companyId, provider: req.model.provider })
      const model = opts.createModel
        ? opts.createModel({ provider: req.model.provider, model: req.model.model, credentials, companyId })
        : buildLanguageModel(req.model, credentials, opts)

      const tools: ToolSet = {}
      for (const t of req.tools ?? []) {
        tools[t.name] = tool({
          description: t.description,
          inputSchema: t.input,
          execute: (input: unknown, o: { toolCallId: string; abortSignal?: AbortSignal }) =>
            t.execute(input, { tenantId: companyId, agentId: req.agentId, toolCallId: o.toolCallId, ...(o.abortSignal ? { signal: o.abortSignal } : {}) }),
        })
      }
      const maxSteps = req.maxSteps ?? DEFAULT_MAX_STEPS
      const stepLimit = maxSteps + (req.output ? 1 : 0)

      const call: Record<string, unknown> = {
        model,
        instructions: req.instructions,
        messages: toModelMessages(req.messages),
        stopWhen: isStepCount(stepLimit),
        maxRetries: 0,
      }
      if (req.tools?.length) call.tools = tools
      if (req.output) call.output = Output.object({ schema: req.output })
      if (req.signal) call.abortSignal = req.signal
      if (req.maxOutputTokens !== undefined) call.maxOutputTokens = req.maxOutputTokens
      if (req.temperature !== undefined) call.temperature = req.temperature
      // Dados de cliente não ficam 30 dias na OpenAI; o histórico vem do nosso Postgres.
      if (req.model.provider === 'openai') call.providerOptions = { openai: { store: false } }

      let result: Awaited<ReturnType<typeof generateText>>
      try {
        result = await generate(call as Parameters<typeof generateText>[0])
      } catch (err) {
        if (NoObjectGeneratedError.isInstance(err)) {
          return {
            text: err.text ?? '',
            steps: [],
            usage: normalizeUsage(err.usage as LanguageModelUsage | undefined),
            finish: 'error',
            error: { code: 'OUTPUT_VALIDATION', message: 'saída estruturada inválida' },
          }
        }
        throw toUpstreamError(err, req.model.provider)
      }

      const steps = (result.steps as unknown as StepLike[]).map(toStep)
      const usage = steps.length ? addUsage(...steps.map((s) => s.usage)) : normalizeUsage(result.usage, result.providerMetadata)
      const last = steps.at(-1)
      let finish: LlmFinish = 'stop'
      if (last?.finishReason === 'tool-calls' && steps.length >= stepLimit) finish = 'tool-limit'
      else if (last?.finishReason === 'length') finish = 'length'
      else if (last?.finishReason === 'refusal') finish = 'refusal'
      else if (last?.finishReason === 'error') finish = 'error'

      const out: LlmResult<T> = { text: result.text, steps, usage, finish }
      if (req.output) out.object = result.output as T
      if (finish === 'error') out.error = { code: 'UPSTREAM', message: 'o provedor encerrou com erro' }
      return out
    },
  }
}

/** Erro do provedor → LlmUpstreamError com mensagem sanitizada (sem chave, sem corpo cru). */
export function toUpstreamError(err: unknown, provider: LlmProviderId): Error {
  if (err instanceof LlmUpstreamError || err instanceof InvalidModelRefError) return err
  if (err instanceof Error && err.name === 'AbortError') return err
  if (APICallError.isInstance(err)) {
    const status = err.statusCode
    return new LlmUpstreamError(
      `${provider} respondeu ${status ?? 'sem status'}`,
      { provider, ...(status !== undefined ? { status } : {}), retryable: err.isRetryable },
      { cause: err },
    )
  }
  return new LlmUpstreamError(`falha ao chamar ${provider}`, { provider, retryable: true }, { cause: err })
}
