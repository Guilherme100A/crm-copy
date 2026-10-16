// Custo de uma chamada de IA pela nossa tabela de preços (STACK F.2): preço vigente na data, cache e reasoning
// cobrados à parte, markup e conversão em créditos com arredondamento configurado (AC-T18-01).
import { and, desc, eq, isNull, lte } from 'drizzle-orm'
import { aiPricingSettings, llmPrices, type AiPriceKind, type Database, type RoundingMode } from '@crm/db'
import { PriceNotFoundError } from './errors'

/** Padrões sem linha em `ai_pricing_settings` (feature 12 §5.6): markup 3×, 5,40 BRL/USD × 1000 créditos/BRL, ceil. */
export const DEFAULT_PRICING_SETTINGS = { markupBps: 30_000, creditsPerUsd: 5_400, roundingMode: 'ceil' as RoundingMode }

/**
 * Uso a precificar. Semântica do `LlmUsage` (T04 / AI SDK 7): `inputTokens` INCLUI cache read/write e
 * `outputTokens` INCLUI reasoning; cada parte é cobrada pelo seu preço. TTS usa `characters`; STT usa `seconds`.
 */
export interface UsageToPrice {
  provider: string
  model: string
  kind?: AiPriceKind
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  characters?: number
  seconds?: number
}

export interface UsageCost {
  priceId: string
  /** Custo bruto em micro-USD (ceil). */
  costMicros: number
  /** Custo com markup em micro-USD (ceil). */
  billedMicros: number
  /** Créditos debitados: custo × markup × `credits_per_usd`, com `rounding_mode`. */
  credits: number
  markupBps: number
  creditsPerUsd: number
  roundingMode: RoundingMode
}

export interface PricingSettings {
  markupBps: number
  creditsPerUsd: number
  roundingMode: RoundingMode
}

type Price = typeof llmPrices.$inferSelect

const MTOK = 1_000_000n
const BPS = 10_000n
const MICROS_PER_USD = 1_000_000n

const n = (v: number | undefined) => BigInt(Math.max(0, Math.trunc(v ?? 0)))

/** Divisão inteira não negativa com o modo de arredondamento. */
export function divRound(num: bigint, den: bigint, mode: RoundingMode): bigint {
  if (den <= 0n) throw new RangeError('denominador deve ser positivo')
  if (mode === 'floor') return num / den
  if (mode === 'ceil') return (num + den - 1n) / den
  return (2n * num + den) / (2n * den) // meio para cima
}

/** Custo exato em micro-USD como fração `num/den`. */
export function rawCost(usage: UsageToPrice, price: Price): { num: bigint; den: bigint } {
  const kind = usage.kind ?? 'llm'
  if (kind === 'tts') return { num: n(usage.characters) * n(price.unitPriceMicros ?? 0), den: MTOK }
  if (kind === 'stt') return { num: n(usage.seconds) * n(price.unitPriceMicros ?? 0), den: 60n }

  const input = n(usage.inputTokens)
  const output = n(usage.outputTokens)
  const cacheRead = n(usage.cacheReadTokens)
  const cacheWrite = n(usage.cacheWriteTokens)
  const reasoning = n(usage.reasoningTokens)
  const plainInput = input > cacheRead + cacheWrite ? input - cacheRead - cacheWrite : 0n
  const plainOutput = output > reasoning ? output - reasoning : 0n

  const pIn = n(price.inputPerMtokMicros)
  const pOut = n(price.outputPerMtokMicros)
  const num =
    plainInput * pIn +
    cacheRead * n(price.cacheReadPerMtokMicros ?? price.inputPerMtokMicros) +
    cacheWrite * n(price.cacheWritePerMtokMicros ?? price.inputPerMtokMicros) +
    plainOutput * pOut +
    reasoning * n(price.reasoningPerMtokMicros ?? price.outputPerMtokMicros)
  return { num, den: MTOK }
}

/** Aplica markup e conversão em créditos à fração de custo (sem arredondar antes do fim). */
export function priceWith(cost: { num: bigint; den: bigint }, settings: PricingSettings) {
  const markup = BigInt(settings.markupBps)
  return {
    costMicros: Number(divRound(cost.num, cost.den, 'ceil')),
    billedMicros: Number(divRound(cost.num * markup, cost.den * BPS, 'ceil')),
    credits: Number(divRound(cost.num * markup * BigInt(settings.creditsPerUsd), cost.den * BPS * MICROS_PER_USD, settings.roundingMode)),
  }
}

export interface PricingServiceOptions {
  db: Database
}

export class PricingService {
  private readonly db: Database

  constructor(opts: PricingServiceOptions) {
    this.db = opts.db
  }

  /** Preço vigente em `at`: maior `effective_from` <= `at`. */
  async priceAt(provider: string, model: string, kind: AiPriceKind, at: Date): Promise<Price> {
    const [row] = await this.db
      .select()
      .from(llmPrices)
      .where(and(eq(llmPrices.provider, provider), eq(llmPrices.model, model), eq(llmPrices.kind, kind), lte(llmPrices.effectiveFrom, at)))
      .orderBy(desc(llmPrices.effectiveFrom))
      .limit(1)
    if (!row) throw new PriceNotFoundError(provider, model, kind, at)
    return row
  }

  /** Configuração da empresa, senão a global, senão os padrões. */
  async settingsFor(companyId?: string | null): Promise<PricingSettings> {
    const pick = (r: { markupBps: number; creditsPerUsd: number; roundingMode: RoundingMode } | undefined) =>
      r ? { markupBps: r.markupBps, creditsPerUsd: r.creditsPerUsd, roundingMode: r.roundingMode } : undefined
    if (companyId) {
      const [own] = await this.db.select().from(aiPricingSettings).where(eq(aiPricingSettings.companyId, companyId)).limit(1)
      if (own) return pick(own)!
    }
    const [global] = await this.db.select().from(aiPricingSettings).where(isNull(aiPricingSettings.companyId)).limit(1)
    return pick(global) ?? { ...DEFAULT_PRICING_SETTINGS }
  }

  async costOf(usage: UsageToPrice, at: Date = new Date(), opts: { companyId?: string | null } = {}): Promise<UsageCost> {
    const kind = usage.kind ?? 'llm'
    const [price, settings] = await Promise.all([this.priceAt(usage.provider, usage.model, kind, at), this.settingsFor(opts.companyId)])
    return { priceId: price.id, ...priceWith(rawCost({ ...usage, kind }, price), settings), ...settings }
  }
}
