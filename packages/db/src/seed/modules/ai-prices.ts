// Preços padrão da plataforma para os modelos do STACK.md Bloco F (T37): sem linha em `crm.llm_prices` o UsageGuard
// (T24) recusa a chamada ("sem preço vigente") e o agente não responde num banco novo. Idempotente: só insere o
// (provider, model, kind) que ainda não tem nenhum preço; preços já cadastrados (inclusive pelo admin) não mudam.
// Unidades (`ai-usage/pricing.ts`): LLM em micros de USD por 1M tokens; TTS em micros por 1M caracteres; STT em
// micros por minuto de áudio.
import { llmPrices, type AiPriceKind } from '../../schema/crm/ai-usage.js'
import type { Database } from '../../client.js'
import type { SeedModule } from '../index.js'

/** US$ → micros de US$. */
const usd = (value: number) => Math.round(value * 1_000_000)

export interface DefaultAiPrice {
  provider: string
  model: string
  kind: AiPriceKind
  inputPerMtokMicros?: number
  outputPerMtokMicros?: number
  unitPriceMicros?: number
  /** Vigência fixa (ex.: aumento anunciado); sem ela, a vigência é a data do seed. */
  effectiveFrom?: Date
}

/**
 * Fontes (consultadas em 2026-10-15; STACK.md Bloco F.5 e §2):
 * - Anthropic: https://www.anthropic.com/pricing (claude-haiku-5-5 0,10/0,50 · claude-sonnet-5-5 2/10 · claude-opus-5-5 4/20 US$/MTok)
 * - OpenAI: https://developers.openai.com/api/docs/pricing (gpt-6-luna 0,10/0,50 · gpt-6.1-sol 2/10 · gpt-6-astra 10/50 US$/MTok)
 * - Google: https://ai.google.dev/gemini-api/docs/pricing (gemini-3.5-flash-lite 0,30/2,50 · gemini-3.8-flash 0,75/3,75 ·
 *   gemini-4-argon 2/10 US$/MTok, dobrando para 4/20 em 2026-12-01)
 * - ElevenLabs: https://elevenlabs.io/pricing/api (Flash v2.5 US$ 0,04/1k caracteres; Multilingual v2 US$ 0,08/1k)
 * - Groq: https://groq.com/pricing (whisper-large-v3-turbo US$ 0,04/hora de áudio)
 * OpenRouter (F.8) fica sem preço padrão: não há valor público verificado no STACK; o admin cadastra pela API (T37).
 */
export const DEFAULT_AI_PRICES: readonly DefaultAiPrice[] = [
  { provider: 'anthropic', model: 'claude-haiku-5-5', kind: 'llm', inputPerMtokMicros: usd(0.1), outputPerMtokMicros: usd(0.5) },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', kind: 'llm', inputPerMtokMicros: usd(2), outputPerMtokMicros: usd(10) },
  { provider: 'anthropic', model: 'claude-opus-5-5', kind: 'llm', inputPerMtokMicros: usd(4), outputPerMtokMicros: usd(20) },
  { provider: 'openai', model: 'gpt-6-luna', kind: 'llm', inputPerMtokMicros: usd(0.1), outputPerMtokMicros: usd(0.5) },
  { provider: 'openai', model: 'gpt-6.1-sol', kind: 'llm', inputPerMtokMicros: usd(2), outputPerMtokMicros: usd(10) },
  { provider: 'openai', model: 'gpt-6-astra', kind: 'llm', inputPerMtokMicros: usd(10), outputPerMtokMicros: usd(50) },
  { provider: 'google', model: 'gemini-3.5-flash-lite', kind: 'llm', inputPerMtokMicros: usd(0.3), outputPerMtokMicros: usd(2.5) },
  { provider: 'google', model: 'gemini-3.8-flash', kind: 'llm', inputPerMtokMicros: usd(0.75), outputPerMtokMicros: usd(3.75) },
  { provider: 'google', model: 'gemini-4-argon', kind: 'llm', inputPerMtokMicros: usd(2), outputPerMtokMicros: usd(10) },
  // Aumento anunciado pelo Google: vigência própria (não altera usos anteriores).
  { provider: 'google', model: 'gemini-4-argon', kind: 'llm', inputPerMtokMicros: usd(4), outputPerMtokMicros: usd(20), effectiveFrom: new Date('2026-12-01T00:00:00Z') },
  // TTS: US$ 0,04/1k caracteres = US$ 40 por 1M caracteres.
  { provider: 'elevenlabs', model: 'eleven_flash_v2_5', kind: 'tts', unitPriceMicros: usd(40) },
  { provider: 'elevenlabs', model: 'eleven_multilingual_v2', kind: 'tts', unitPriceMicros: usd(80) },
  // O metering de voz usa `default` quando a chamada não informa o modelo (= o modelo padrão do adapter).
  { provider: 'elevenlabs', model: 'default', kind: 'tts', unitPriceMicros: usd(40) },
  // STT: US$ 0,04/hora = 0,04 / 60 por minuto ≈ 667 micros/min.
  { provider: 'groq', model: 'whisper-large-v3-turbo', kind: 'stt', unitPriceMicros: Math.round(usd(0.04) / 60) },
  { provider: 'groq', model: 'default', kind: 'stt', unitPriceMicros: Math.round(usd(0.04) / 60) },
]

const key = (p: { provider: string; model: string; kind: string }) => `${p.provider}\u0000${p.model}\u0000${p.kind}`

/**
 * Insere os preços padrão dos (provider, model, kind) que ainda não têm preço nenhum. Vigência: a data do seed
 * (ou a fixa do item). Devolve quantas linhas entraram. Seguro para rodar em todo boot e em paralelo (unique da vigência).
 */
export async function ensureDefaultAiPrices(db: Database, opts: { now?: Date; prices?: readonly DefaultAiPrice[] } = {}): Promise<{ inserted: number }> {
  const now = opts.now ?? new Date()
  const prices = opts.prices ?? DEFAULT_AI_PRICES
  const existing = await db.select({ provider: llmPrices.provider, model: llmPrices.model, kind: llmPrices.kind }).from(llmPrices)
  const known = new Set(existing.map(key))
  const rows = prices
    .filter((p) => !known.has(key(p)))
    .map((p) => ({
      provider: p.provider,
      model: p.model,
      kind: p.kind,
      effectiveFrom: p.effectiveFrom ?? now,
      inputPerMtokMicros: p.inputPerMtokMicros ?? 0,
      outputPerMtokMicros: p.outputPerMtokMicros ?? 0,
      unitPriceMicros: p.unitPriceMicros ?? null,
    }))
  if (rows.length === 0) return { inserted: 0 }
  const inserted = await db.insert(llmPrices).values(rows).onConflictDoNothing().returning({ id: llmPrices.id })
  return { inserted: inserted.length }
}

export const aiPricesSeed: SeedModule = {
  name: 'ai-prices',
  order: 10,
  run: async ({ db }) => {
    await ensureDefaultAiPrices(db)
  },
}
