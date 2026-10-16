// Porta única de LLM (STACK.md Bloco F §F.2). O domínio só conhece estes tipos; os adapters (T12) os implementam.
import type * as z from 'zod'

export const LLM_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const
export type LlmProviderId = (typeof LLM_PROVIDERS)[number]

/** Provedor + modelo. OpenRouter usa o formato `fornecedor/modelo` (ex.: `anthropic/claude-sonnet-5-5`). */
export interface LlmModelRef {
  provider: LlmProviderId
  model: string
}

/** Mídia por URL ou por bytes, sempre com mime. */
export type LlmMediaSource = { url: string; data?: never } | { data: Uint8Array; url?: never }

export type LlmPart =
  | { type: 'text'; text: string }
  | ({ type: 'image'; mime: string } & LlmMediaSource)
  | ({ type: 'audio'; mime: string } & LlmMediaSource)
  | ({ type: 'file'; mime: string; filename?: string } & LlmMediaSource)
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }

export type LlmMessage =
  | { role: 'user'; content: LlmPart[] }
  /** `providerData` é opaco (thoughtSignature, reasoning cifrado): gravar e reenviar exatamente como veio. */
  | { role: 'assistant'; content: LlmPart[]; providerData?: unknown }
  | { role: 'tool'; toolCallId: string; toolName: string; result: unknown; isError?: boolean }

/** Contexto passado às tools: tenant e agente da chamada (nunca por variável global). */
export interface ToolCtx {
  tenantId: string
  agentId: string
  toolCallId: string
  signal?: AbortSignal
}

export interface LlmTool<I = unknown, O = unknown> {
  name: string
  description: string
  /** Schema zod do input: definido uma vez, o adapter converte para o formato do provedor. */
  input: z.ZodType<I>
  execute(input: I, ctx: ToolCtx): Promise<O>
}

/** Ajuda a inferir `I` a partir do schema. */
export function llmTool<I, O>(tool: LlmTool<I, O>): LlmTool<I, O> {
  return tool
}

/** Uso normalizado. `costMicros` (USD × 10⁶) é calculado pela nossa tabela de preços, não pelo SDK. */
export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costMicros: number
}

export function emptyUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costMicros: 0 }
}

/** Soma de usos (o `usage` do resultado soma todos os passos). */
export function addUsage(...items: Partial<LlmUsage>[]): LlmUsage {
  const total = emptyUsage()
  for (const u of items)
    for (const k of Object.keys(total) as (keyof LlmUsage)[]) total[k] += u[k] ?? 0
  return total
}

export interface LlmToolCall {
  toolCallId: string
  toolName: string
  input: unknown
}

export interface LlmToolResult {
  toolCallId: string
  toolName: string
  output: unknown
  isError: boolean
}

export type LlmStepFinishReason = 'stop' | 'tool-calls' | 'length' | 'refusal' | 'error'

export interface LlmStep {
  index: number
  text: string
  toolCalls: LlmToolCall[]
  toolResults: LlmToolResult[]
  usage: LlmUsage
  finishReason: LlmStepFinishReason
  providerData?: unknown
}

export interface LlmRequest<T = unknown> {
  model: LlmModelRef
  instructions: string
  messages: LlmMessage[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tools heterogêneas
  tools?: LlmTool<any, any>[]
  /** Loop de tools controlado (padrão `DEFAULT_MAX_STEPS`). Structured output conta como um passo a mais. */
  maxSteps?: number
  /** Structured output. */
  output?: z.ZodType<T>
  maxOutputTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** Empresa (contabilidade e limites). */
  tenantId: string
  agentId: string
}

export const DEFAULT_MAX_STEPS = 5

export type LlmFinish = 'stop' | 'length' | 'tool-limit' | 'refusal' | 'error'

export type LlmResultErrorCode = 'OUTPUT_VALIDATION' | 'SCRIPT_EXHAUSTED' | 'UPSTREAM' | (string & {})

export interface LlmResult<T = unknown> {
  text: string
  object?: T
  steps: LlmStep[]
  usage: LlmUsage
  finish: LlmFinish
  /** Presente quando `finish === 'error'`. */
  error?: { code: LlmResultErrorCode; message: string }
}

export interface LlmProvider {
  generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>>
  countTokens?(req: LlmRequest): Promise<number>
}
