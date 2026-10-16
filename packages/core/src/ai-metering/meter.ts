// Provedores medidos (T24): toda chamada de LLM, TTS ou STT passa por `reserve` → provedor → `commit`
// (ou `fail`, sem débito, quando o provedor lança ou devolve `finish: 'error'`).
import { randomUUID } from 'node:crypto'
import type { LlmProvider, LlmRequest, LlmResult, SttProvider, SttRequest, TtsProvider, TtsRequest } from '@crm/ai'
import type { UsageGuard } from './guard'

export interface MeterContext {
  guard: UsageGuard
  /** Funcionalidade que consome (ex.: `ai_agent`, `flow_copilot`, `translation`), gravada em `ai_usage.feature`. */
  feature: string
  /** Default: `req.tenantId` (LLM). Obrigatório para TTS/STT. */
  companyId?: string
  /** Default: `req.agentId` (LLM). */
  agentId?: string | null
  /** Estimativa fixa em créditos; sem ela, a reserva precifica uma estimativa pelo pedido. */
  estimateCredits?: number
}

export interface VoiceMeterContext extends MeterContext {
  companyId: string
  /** Provedor para a tabela de preços (default `elevenlabs` no TTS, `groq` no STT). */
  provider?: string
  /** Modelo para a tabela de preços (default: `req.model` no TTS; obrigatório no STT se não houver padrão). */
  model?: string
  /** STT: segundos estimados antes de transcrever (default 60). */
  estimateSeconds?: number
}

export const DEFAULT_OUTPUT_ESTIMATE = 1000
const CHARS_PER_TOKEN = 4

/** Tokens de entrada estimados: caracteres de instruções e mensagens ÷ 4. */
export function estimateInputTokens(req: LlmRequest): number {
  let chars = req.instructions?.length ?? 0
  for (const m of req.messages ?? []) {
    const content = (m as { content?: unknown }).content
    if (typeof content === 'string') chars += content.length
    else if (Array.isArray(content)) for (const p of content) chars += typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text.length : 0
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** LLM medido: `ai_usage` com tokens e créditos do `result.usage`. */
export function meterLlm(provider: LlmProvider, ctx: MeterContext): LlmProvider {
  const metered: LlmProvider = {
    async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const companyId = ctx.companyId ?? req.tenantId
      const agentId = ctx.agentId ?? req.agentId ?? null
      const base = { provider: req.model.provider, model: req.model.model, kind: 'llm' as const, feature: ctx.feature, agentId, companyId }
      const estimate =
        ctx.estimateCredits !== undefined
          ? { credits: ctx.estimateCredits }
          : { provider: base.provider, model: base.model, usage: { inputTokens: estimateInputTokens(req as LlmRequest), outputTokens: req.maxOutputTokens ?? DEFAULT_OUTPUT_ESTIMATE } }
      const r = await ctx.guard.reserve(companyId, estimate, ctx.feature, { agentId, requestId: randomUUID() })
      let result: LlmResult<T>
      try {
        result = await provider.generate(req)
      } catch (err) {
        await ctx.guard.fail({ ...base, requestId: r.requestId, error: err })
        throw err
      }
      if (result.finish === 'error') {
        const code = (result as { error?: { code?: string } }).error?.code ?? 'LLM_ERROR'
        await ctx.guard.fail({ ...base, requestId: r.requestId, usage: result.usage, error: { code } })
        return result
      }
      await ctx.guard.commit({ ...base, requestId: r.requestId, usage: result.usage })
      return result
    },
  }
  if (provider.countTokens) metered.countTokens = (req) => provider.countTokens!(req)
  return metered
}

/** TTS medido: custo por caracteres (`result.chars`). */
export function meterTts(provider: TtsProvider, ctx: VoiceMeterContext): TtsProvider {
  return {
    async synthesize(req: TtsRequest) {
      const base = { provider: ctx.provider ?? 'elevenlabs', model: req.model ?? ctx.model ?? 'default', kind: 'tts' as const, feature: ctx.feature, agentId: ctx.agentId ?? null, companyId: ctx.companyId }
      const estimate = ctx.estimateCredits !== undefined ? { credits: ctx.estimateCredits } : { ...base, usage: { characters: req.text.length } }
      const r = await ctx.guard.reserve(ctx.companyId, estimate, ctx.feature, { agentId: base.agentId, requestId: randomUUID() })
      try {
        const result = await provider.synthesize(req)
        await ctx.guard.commit({ ...base, requestId: r.requestId, usage: { characters: result.chars } })
        return result
      } catch (err) {
        await ctx.guard.fail({ ...base, requestId: r.requestId, error: err }).catch(() => undefined)
        throw err
      }
    },
  }
}

/** STT medido: custo por segundos de áudio (`result.seconds`). */
export function meterStt(provider: SttProvider, ctx: VoiceMeterContext): SttProvider {
  return {
    async transcribe(req: SttRequest) {
      const base = { provider: ctx.provider ?? 'groq', model: ctx.model ?? 'default', kind: 'stt' as const, feature: ctx.feature, agentId: ctx.agentId ?? null, companyId: ctx.companyId }
      const estimate = ctx.estimateCredits !== undefined ? { credits: ctx.estimateCredits } : { ...base, usage: { seconds: ctx.estimateSeconds ?? 60 } }
      const r = await ctx.guard.reserve(ctx.companyId, estimate, ctx.feature, { agentId: base.agentId, requestId: randomUUID() })
      let result
      try {
        result = await provider.transcribe(req)
      } catch (err) {
        await ctx.guard.fail({ ...base, requestId: r.requestId, error: err })
        throw err
      }
      await ctx.guard.commit({ ...base, requestId: r.requestId, usage: { seconds: result.seconds } })
      return result
    },
  }
}

/** Mede o provedor conforme o tipo (LLM `generate`, TTS `synthesize`, STT `transcribe`). */
export function meter(provider: LlmProvider, ctx: MeterContext): LlmProvider
export function meter(provider: TtsProvider, ctx: VoiceMeterContext): TtsProvider
export function meter(provider: SttProvider, ctx: VoiceMeterContext): SttProvider
export function meter(provider: LlmProvider | TtsProvider | SttProvider, ctx: MeterContext | VoiceMeterContext): LlmProvider | TtsProvider | SttProvider {
  if ('generate' in provider) return meterLlm(provider, ctx)
  if ('synthesize' in provider) return meterTts(provider, ctx as VoiceMeterContext)
  if ('transcribe' in provider) return meterStt(provider, ctx as VoiceMeterContext)
  throw new TypeError('meter: provedor desconhecido (esperado generate, synthesize ou transcribe)')
}
