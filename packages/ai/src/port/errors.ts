// Erros das portas de IA. Os códigos casam com a tabela de erros da API (SPEC 3.5).
import type { LlmProviderId } from './llm'

export abstract class LlmError extends Error {
  abstract readonly code: 'QUOTA_EXCEEDED' | 'UPSTREAM_ERROR'
}

/** Cota de tokens/custo/créditos da empresa esgotada (lançado pelo `UsageMeter.before`). HTTP 429. */
export class LlmQuotaExceededError extends LlmError {
  override readonly name = 'LlmQuotaExceededError'
  readonly code = 'QUOTA_EXCEEDED' as const

  constructor(
    message = 'Cota de IA esgotada',
    readonly details: { tenantId?: string; limit?: number; used?: number } = {},
  ) {
    super(message)
  }
}

/** Provedor externo (LLM, TTS, STT) falhou. A mensagem é sanitizada: nunca inclui chave nem corpo cru. HTTP 502. */
export class LlmUpstreamError extends LlmError {
  override readonly name = 'LlmUpstreamError'
  readonly code = 'UPSTREAM_ERROR' as const

  constructor(
    message: string,
    readonly details: { provider?: LlmProviderId | 'elevenlabs' | 'groq' | (string & {}); status?: number; retryable?: boolean } = {},
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}
