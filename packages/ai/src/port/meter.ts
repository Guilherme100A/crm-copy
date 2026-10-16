// UsageMeter (STACK F.2 "Limites por empresa"): `before` confere a cota e pode lançar `LlmQuotaExceededError`;
// `after` grava o uso. A implementação real (UsageGuard) fica no core (T24).
import type { LlmProvider, LlmRequest, LlmResult } from './llm'

export interface UsageMeter {
  /** Chamado antes de cada chamada ao provedor. Lançar aqui impede a chamada. */
  before(req: LlmRequest): void | Promise<void>
  /** Chamado depois de cada chamada que devolveu resultado (inclusive `finish: 'error'`). */
  after(req: LlmRequest, result: LlmResult): void | Promise<void>
}

/** Envolve um provedor com o meter: `before` → `generate` → `after`. */
export function withUsageMeter(provider: LlmProvider, meter: UsageMeter): LlmProvider {
  const metered: LlmProvider = {
    async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      await meter.before(req as LlmRequest)
      const result = await provider.generate(req)
      await meter.after(req as LlmRequest, result as LlmResult)
      return result
    },
  }
  if (provider.countTokens) metered.countTokens = (req) => provider.countTokens!(req)
  return metered
}
