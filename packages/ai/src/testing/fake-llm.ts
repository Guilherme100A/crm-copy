// FakeLlm: provedor determinístico guiado por roteiro (SPEC 3.10 "Fakes oficiais"). Nunca acessa rede.
// Cada item do roteiro é UM passo; o roteiro é uma fila consumida entre chamadas.
import * as z from 'zod'
import {
  DEFAULT_MAX_STEPS,
  addUsage,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type LlmStep,
  type LlmToolCall,
  type LlmToolResult,
  type LlmUsage,
} from '../port/llm'
import type { UsageMeter } from '../port/meter'

/** Uso padrão de cada passo do fake. */
export const FAKE_STEP_USAGE: Readonly<LlmUsage> = Object.freeze({
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costMicros: 0,
})

export interface FakeStepOptions {
  /** Sobrescreve campos do uso do passo (os ausentes vêm de `FAKE_STEP_USAGE`). */
  usage?: Partial<LlmUsage>
  /** Dado opaco do provedor no passo (thoughtSignature, reasoning cifrado), copiado para o `LlmStep` (T68). */
  providerData?: unknown
}

export interface FakeToolCallSpec {
  name: string
  input: unknown
  id?: string
}

export type FakeLlmStep =
  | { kind: 'tool-calls'; calls: FakeToolCallSpec[]; usage?: Partial<LlmUsage>; providerData?: unknown }
  | { kind: 'text'; text: string; usage?: Partial<LlmUsage>; providerData?: unknown }
  | { kind: 'output'; value: unknown; usage?: Partial<LlmUsage>; providerData?: unknown }
  | { kind: 'length'; text: string; usage?: Partial<LlmUsage>; providerData?: unknown }
  | { kind: 'refusal'; text: string; usage?: Partial<LlmUsage>; providerData?: unknown }
  | { kind: 'fail'; error: unknown }

/** Passo em que o modelo chama uma tool. */
export function toolCall(name: string, input: unknown, opts: FakeStepOptions & { id?: string } = {}): FakeLlmStep {
  return { kind: 'tool-calls', calls: [{ name, input, id: opts.id }], usage: opts.usage, ...(opts.providerData !== undefined ? { providerData: opts.providerData } : {}) }
}

/** Passo com várias tool calls em paralelo. */
export function toolCalls(calls: FakeToolCallSpec[], opts: FakeStepOptions = {}): FakeLlmStep {
  return { kind: 'tool-calls', calls, usage: opts.usage, ...(opts.providerData !== undefined ? { providerData: opts.providerData } : {}) }
}

/** Passo final com texto (com `output`, o texto é interpretado como JSON). */
export function text(value: string, opts: FakeStepOptions = {}): FakeLlmStep {
  return { kind: 'text', text: value, usage: opts.usage, ...(opts.providerData !== undefined ? { providerData: opts.providerData } : {}) }
}

/** Passo final de structured output: o valor é validado contra `req.output`. */
export function output(value: unknown, opts: FakeStepOptions = {}): FakeLlmStep {
  return { kind: 'output', value, usage: opts.usage, ...(opts.providerData !== undefined ? { providerData: opts.providerData } : {}) }
}

/** Passo final cortado por `maxOutputTokens`. */
export function length(value = '', opts: FakeStepOptions = {}): FakeLlmStep {
  return { kind: 'length', text: value, usage: opts.usage, ...(opts.providerData !== undefined ? { providerData: opts.providerData } : {}) }
}

/** Passo final em que o modelo recusa. */
export function refusal(value = '', opts: FakeStepOptions = {}): FakeLlmStep {
  return { kind: 'refusal', text: value, usage: opts.usage, ...(opts.providerData !== undefined ? { providerData: opts.providerData } : {}) }
}

/** Faz `generate` rejeitar com o erro (ex.: `LlmUpstreamError`). */
export function fail(error: unknown): FakeLlmStep {
  return { kind: 'fail', error }
}

export interface FakeLlmOptions {
  script?: FakeLlmStep[]
  /** Se presente: `before` antes de contar a chamada, `after` com o resultado. */
  meter?: UsageMeter
}

export class FakeLlm implements LlmProvider {
  /** Requests que chegaram ao fake (depois do `meter.before`). */
  readonly calls: LlmRequest[] = []
  private readonly script: FakeLlmStep[]
  private readonly meter?: UsageMeter

  constructor(script?: FakeLlmStep[] | FakeLlmOptions, opts: Omit<FakeLlmOptions, 'script'> = {}) {
    const o: FakeLlmOptions = Array.isArray(script) ? { ...opts, script } : { ...opts, ...script }
    this.script = [...(o.script ?? [])]
    this.meter = o.meter
  }

  get callCount(): number {
    return this.calls.length
  }

  /** Alias de `calls`. */
  get requests(): readonly LlmRequest[] {
    return this.calls
  }

  /** Passos ainda não consumidos. */
  get remaining(): number {
    return this.script.length
  }

  /** Acrescenta passos ao fim do roteiro. */
  enqueue(...steps: FakeLlmStep[]): this {
    this.script.push(...steps)
    return this
  }

  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    if (this.meter) await this.meter.before(req as LlmRequest)
    this.calls.push(req as LlmRequest)
    const result = await this.run(req)
    if (this.meter) await this.meter.after(req as LlmRequest, result as LlmResult)
    return result
  }

  async countTokens(req: LlmRequest): Promise<number> {
    return Math.ceil(JSON.stringify([req.instructions, req.messages]).length / 4)
  }

  private async run<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const maxSteps = req.maxSteps ?? DEFAULT_MAX_STEPS
    const callNo = this.calls.length
    const steps: LlmStep[] = []
    const done = (finish: LlmResult<T>['finish'], extra: Partial<LlmResult<T>> = {}): LlmResult<T> => ({
      text: steps.at(-1)?.text ?? '',
      steps,
      usage: addUsage(...steps.map((s) => s.usage)),
      finish,
      ...extra,
    })

    for (;;) {
      req.signal?.throwIfAborted()
      const item = this.script.shift()
      if (!item) return done('error', { error: { code: 'SCRIPT_EXHAUSTED', message: 'Roteiro do FakeLlm esgotado' } })
      if (item.kind === 'fail') throw item.error
      const index = steps.length
      const usage: LlmUsage = { ...FAKE_STEP_USAGE, ...item.usage }

      if (item.kind === 'tool-calls') {
        const toolCalls: LlmToolCall[] = item.calls.map((c, i) => ({
          toolCallId: c.id ?? `call_${callNo}_${index}_${i}`,
          toolName: c.name,
          input: c.input,
        }))
        const toolResults: LlmToolResult[] = []
        for (const call of toolCalls) toolResults.push(await this.execute(req, call))
        steps.push({ index, text: '', toolCalls, toolResults, usage, finishReason: 'tool-calls', ...(item.providerData !== undefined ? { providerData: item.providerData } : {}) })
        if (steps.length >= maxSteps) return done('tool-limit')
        continue
      }

      const stepText = item.kind === 'output' ? JSON.stringify(item.value) : item.text
      const finishReason = item.kind === 'length' ? 'length' : item.kind === 'refusal' ? 'refusal' : 'stop'
      steps.push({ index, text: stepText, toolCalls: [], toolResults: [], usage, finishReason, ...(item.providerData !== undefined ? { providerData: item.providerData } : {}) })
      if (finishReason !== 'stop') return done(finishReason)
      if (!req.output) return done('stop')

      let candidate: unknown
      if (item.kind === 'output') candidate = item.value
      else {
        try {
          candidate = JSON.parse(stepText)
        } catch {
          return done('error', { error: { code: 'OUTPUT_VALIDATION', message: 'Saída estruturada não é JSON válido' } })
        }
      }
      const parsed = req.output.safeParse(candidate)
      if (!parsed.success) return done('error', { error: { code: 'OUTPUT_VALIDATION', message: z.prettifyError(parsed.error) } })
      return done('stop', { object: parsed.data })
    }
  }

  private async execute(req: LlmRequest<unknown>, call: LlmToolCall): Promise<LlmToolResult> {
    const base = { toolCallId: call.toolCallId, toolName: call.toolName }
    const tool = req.tools?.find((t) => t.name === call.toolName)
    if (!tool) return { ...base, output: `Tool desconhecida: ${call.toolName}`, isError: true }
    const parsed = tool.input.safeParse(call.input)
    if (!parsed.success) return { ...base, output: z.prettifyError(parsed.error), isError: true }
    try {
      const out = await tool.execute(parsed.data, {
        tenantId: req.tenantId,
        agentId: req.agentId,
        toolCallId: call.toolCallId,
        signal: req.signal,
      })
      return { ...base, output: out, isError: false }
    } catch (err) {
      return { ...base, output: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
}
