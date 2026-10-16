// UsageGuard (T24; STACK F.2 "Limites por empresa"): antes de cada chamada de IA confere saldo e cotas
// (`reserve`); depois grava o uso e debita (`commit`, idempotente por `request_id`) ou registra a falha (`fail`).
// O consumo do período fica num contador quente no Redis (hash por empresa/período/bucket), reconciliado com o
// Postgres (`reconcile`), que é a fonte da verdade.
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { LlmQuotaExceededError } from '@crm/ai'
import { aiQuotas, aiUsage, aiWallets, companies, type AiPriceKind, type Database, type QuotaPeriod } from '@crm/db'
import type { Redis } from 'ioredis'
import { PricingService, type UsageToPrice } from '../ai-usage/pricing'
import { applyEntry, type WalletSnapshot } from '../ai-usage/wallet'
import { BUCKET_SQL_FORMAT, BUCKET_TTL_SECONDS, periodBucket, QUOTA_PERIOD_LIST } from './period'

export { LlmQuotaExceededError }

/** Publicador realtime injetado (`RealtimePublisher` do T16 ou um espião). */
export interface WalletEventPublisher {
  publish(companyId: string, type: 'ai_wallet.updated' | 'ai_wallet.low', data: Record<string, unknown>, opts?: object): Promise<unknown>
}

export type UsageNumbers = Omit<UsageToPrice, 'provider' | 'model' | 'kind'>

/** Estimativa: créditos diretos ou um uso a precificar. */
export type UsageEstimate = { credits: number; costMicros?: number; tokens?: number } | { provider: string; model: string; kind?: AiPriceKind; usage: UsageNumbers }

export interface Reservation {
  requestId: string
  companyId: string
  feature: string
  agentId: string | null
  estimatedCredits: number
}

export interface CommitInput {
  requestId: string
  companyId: string
  provider: string
  model: string
  kind?: AiPriceKind
  feature: string
  agentId?: string | null
  usage: UsageNumbers
  at?: Date
}

export interface CommitResult {
  usageId: string
  /** `false` quando o `request_id` já existia: nada foi debitado de novo. */
  created: boolean
  credits: number
  wallet: WalletSnapshot | null
}

export interface FailInput extends Omit<CommitInput, 'usage'> {
  usage?: UsageNumbers
  error: unknown
}

export interface PeriodCounters {
  credits: number
  cost_micros: number
  tokens: number
}

const METRICS = ['credits', 'cost_micros', 'tokens'] as const
type Metric = (typeof METRICS)[number]
const QUOTA_COLUMN: Record<Metric, 'maxCredits' | 'maxCostMicros' | 'maxTokens'> = {
  credits: 'maxCredits',
  cost_micros: 'maxCostMicros',
  tokens: 'maxTokens',
}

export interface UsageGuardOptions {
  db: Database
  redis: Redis
  realtime?: WalletEventPublisher
  pricing?: PricingService
  /** Prefixo do contador quente (default `crm:ai:used`). */
  prefix?: string
  now?: () => Date
}

const n = (v: unknown) => Number(v ?? 0) || 0

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown } | null
  if (e && typeof e.code === 'string') return e.code.slice(0, 64)
  if (e && typeof e.name === 'string') return e.name.slice(0, 64)
  return 'UNKNOWN'
}

export class UsageGuard {
  private readonly db: Database
  private readonly redis: Redis
  private readonly realtime?: WalletEventPublisher
  private readonly pricing: PricingService
  private readonly prefix: string
  private readonly now: () => Date

  constructor(opts: UsageGuardOptions) {
    this.db = opts.db
    this.redis = opts.redis
    this.realtime = opts.realtime
    this.pricing = opts.pricing ?? new PricingService({ db: opts.db })
    this.prefix = opts.prefix ?? 'crm:ai:used'
    this.now = opts.now ?? (() => new Date())
  }

  /** Chave do contador quente: `crm:ai:used:<companyId>:<period>:<bucket>`. */
  counterKey(companyId: string, period: QuotaPeriod, bucket: string): string {
    return `${this.prefix}:${companyId}:${period}:${bucket}`
  }

  /**
   * Confere saldo e cotas antes da chamada. Saldo − estimativa < −overrun, ou cota `hard` estourada →
   * `LlmQuotaExceededError` (o provedor não é chamado). Cota `soft` estourada só emite `ai_wallet.low`.
   */
  async reserve(companyId: string, estimate: UsageEstimate, feature: string, opts: { agentId?: string | null; requestId?: string } = {}): Promise<Reservation> {
    const at = this.now()
    const est = await this.priceEstimate(companyId, estimate, at)

    const [w] = await this.db.select().from(aiWallets).where(eq(aiWallets.companyId, companyId)).limit(1)
    const balance = w?.balanceCredits ?? 0
    const overrun = w?.maxOverrunCredits ?? 0
    if (balance - est.credits < -overrun)
      throw new LlmQuotaExceededError('Sem créditos de IA suficientes para continuar', { tenantId: companyId, limit: -overrun, used: balance })

    const quotas = await this.db.select().from(aiQuotas).where(eq(aiQuotas.companyId, companyId))
    if (quotas.length) {
      const tz = await this.timeZone(companyId)
      for (const q of quotas) {
        const used = await this.counters(companyId, q.period, periodBucket(q.period, at, tz), tz)
        for (const metric of METRICS) {
          const limit = q[QUOTA_COLUMN[metric]]
          if (limit === null || limit === undefined) continue
          const add = metric === 'credits' ? est.credits : metric === 'cost_micros' ? est.costMicros : est.tokens
          if (used[metric] < limit && used[metric] + add <= limit) continue
          if (q.hard)
            throw new LlmQuotaExceededError('Cota de IA esgotada', { tenantId: companyId, limit, used: used[metric] })
          await this.emit(companyId, 'ai_wallet.low', { reason: 'quota', period: q.period, metric, used: used[metric], limit })
        }
      }
    }
    return { requestId: opts.requestId ?? randomUUID(), companyId, feature, agentId: opts.agentId ?? null, estimatedCredits: est.credits }
  }

  /** Grava o uso precificado e debita, numa transação; idempotente por `request_id` (AC-T24-03). */
  async commit(input: CommitInput): Promise<CommitResult> {
    const kind = input.kind ?? 'llm'
    const at = input.at ?? this.now()
    const existing = await this.findUsage(input.requestId)
    if (existing) return { usageId: existing.id, created: false, credits: existing.credits, wallet: null }

    const cost = await this.pricing.costOf({ ...input.usage, provider: input.provider, model: input.model, kind }, at, { companyId: input.companyId })
    const u = input.usage
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(aiUsage)
        .values({
          ...this.usageColumns(input, kind, at),
          costMicros: cost.costMicros,
          billedMicros: cost.billedMicros,
          credits: cost.credits,
          priceId: cost.priceId,
          status: 'charged',
          units: kind === 'tts' ? n(u.characters) : kind === 'stt' ? n(u.seconds) : null,
        })
        .onConflictDoNothing({ target: aiUsage.requestId })
        .returning({ id: aiUsage.id, credits: aiUsage.credits })
      if (!row) return null
      const op = await applyEntry(tx, { companyId: input.companyId, kind: 'debit', amount: -row.credits, usageId: row.id, requestId: input.requestId })
      return { usageId: row.id, credits: row.credits, wallet: op.wallet }
    })
    if (!result) {
      const other = (await this.findUsage(input.requestId))!
      return { usageId: other.id, created: false, credits: other.credits, wallet: null }
    }

    await this.bump(input.companyId, at, { credits: cost.credits, cost_micros: cost.costMicros, tokens: n(u.inputTokens) + n(u.outputTokens) })
    const w = result.wallet
    await this.emit(input.companyId, 'ai_wallet.updated', {
      balance_credits: w.balanceCredits,
      status: w.status,
      low_threshold_credits: w.lowThresholdCredits,
      max_overrun_credits: w.maxOverrunCredits,
    })
    if (w.status !== 'ok') await this.emit(input.companyId, 'ai_wallet.low', { reason: 'balance', balance_credits: w.balanceCredits, status: w.status })
    return { usageId: result.usageId, created: true, credits: result.credits, wallet: w }
  }

  /** Falha do provedor: grava `status = 'error'` sem custo nem débito (AC-T24-04). Idempotente por `request_id`. */
  async fail(input: FailInput): Promise<{ usageId: string; created: boolean }> {
    const kind = input.kind ?? 'llm'
    const [row] = await this.db
      .insert(aiUsage)
      .values({
        ...this.usageColumns({ ...input, usage: input.usage ?? {} }, kind, input.at ?? this.now()),
        costMicros: 0,
        billedMicros: 0,
        credits: 0,
        status: 'error',
        errorCode: errorCode(input.error),
      })
      .onConflictDoNothing({ target: aiUsage.requestId })
      .returning({ id: aiUsage.id })
    if (row) return { usageId: row.id, created: true }
    return { usageId: (await this.findUsage(input.requestId))!.id, created: false }
  }

  /** Recalcula do Postgres os contadores do dia e do mês correntes e sobrescreve o Redis (AC-T24-05). */
  async reconcile(companyId: string, at: Date = this.now()): Promise<Record<QuotaPeriod, { before: PeriodCounters; after: PeriodCounters }>> {
    const tz = await this.timeZone(companyId)
    const out = {} as Record<QuotaPeriod, { before: PeriodCounters; after: PeriodCounters }>
    for (const period of QUOTA_PERIOD_LIST) {
      const key = this.counterKey(companyId, period, periodBucket(period, at, tz))
      const before = toCounters(await this.redis.hgetall(key))
      const after = await this.fromPostgres(companyId, period, periodBucket(period, at, tz), tz)
      await this.write(key, period, after)
      out[period] = { before, after }
    }
    return out
  }

  // ---------- internos ----------

  private usageColumns(input: Omit<CommitInput, 'usage'> & { usage: UsageNumbers }, kind: AiPriceKind, at: Date) {
    const u = input.usage
    return {
      companyId: input.companyId,
      requestId: input.requestId,
      provider: input.provider,
      model: input.model,
      kind,
      inputTokens: n(u.inputTokens),
      outputTokens: n(u.outputTokens),
      cacheReadTokens: n(u.cacheReadTokens),
      cacheWriteTokens: n(u.cacheWriteTokens),
      reasoningTokens: n(u.reasoningTokens),
      feature: input.feature,
      agentId: input.agentId ?? null,
      createdAt: at,
    }
  }

  private async priceEstimate(companyId: string, estimate: UsageEstimate, at: Date) {
    if ('credits' in estimate) return { credits: n(estimate.credits), costMicros: n(estimate.costMicros), tokens: n(estimate.tokens) }
    const cost = await this.pricing.costOf({ ...estimate.usage, provider: estimate.provider, model: estimate.model, kind: estimate.kind ?? 'llm' }, at, { companyId })
    return { credits: cost.credits, costMicros: cost.costMicros, tokens: n(estimate.usage.inputTokens) + n(estimate.usage.outputTokens) }
  }

  private async findUsage(requestId: string) {
    const [row] = await this.db.select({ id: aiUsage.id, credits: aiUsage.credits }).from(aiUsage).where(eq(aiUsage.requestId, requestId)).limit(1)
    return row ?? null
  }

  private async timeZone(companyId: string): Promise<string> {
    const [c] = await this.db.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId)).limit(1)
    return c?.tz ?? 'America/Sao_Paulo'
  }

  /** Contador quente do período; ausente → carregado do Postgres. */
  private async counters(companyId: string, period: QuotaPeriod, bucket: string, tz: string): Promise<PeriodCounters> {
    const key = this.counterKey(companyId, period, bucket)
    const raw = await this.redis.hgetall(key)
    if (raw && Object.keys(raw).length) return toCounters(raw)
    const fresh = await this.fromPostgres(companyId, period, bucket, tz)
    await this.write(key, period, fresh)
    return fresh
  }

  private async bump(companyId: string, at: Date, add: PeriodCounters): Promise<void> {
    const tz = await this.timeZone(companyId)
    for (const period of QUOTA_PERIOD_LIST) {
      const bucket = periodBucket(period, at, tz)
      const key = this.counterKey(companyId, period, bucket)
      // Sem a chave, recarrega do Postgres (que já inclui este uso) em vez de começar do zero.
      if (!(await this.redis.exists(key))) {
        await this.write(key, period, await this.fromPostgres(companyId, period, bucket, tz))
        continue
      }
      const m = this.redis.multi()
      for (const metric of METRICS) m.hincrby(key, metric, add[metric])
      m.expire(key, BUCKET_TTL_SECONDS[period])
      await m.exec()
    }
  }

  private async write(key: string, period: QuotaPeriod, c: PeriodCounters): Promise<void> {
    const m = this.redis.multi()
    m.hset(key, 'credits', String(c.credits), 'cost_micros', String(c.cost_micros), 'tokens', String(c.tokens))
    m.expire(key, BUCKET_TTL_SECONDS[period])
    await m.exec()
  }

  private async fromPostgres(companyId: string, period: QuotaPeriod, bucket: string, tz: string): Promise<PeriodCounters> {
    const [r] = await this.db
      .select({
        credits: sql<string>`coalesce(sum(${aiUsage.credits}), 0)`,
        cost: sql<string>`coalesce(sum(${aiUsage.costMicros}), 0)`,
        tokens: sql<string>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)`,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.companyId, companyId),
          eq(aiUsage.status, 'charged'),
          sql`to_char(${aiUsage.createdAt} at time zone ${tz}, ${BUCKET_SQL_FORMAT[period]}) = ${bucket}`,
        ),
      )
    return { credits: n(r?.credits), cost_micros: n(r?.cost), tokens: n(r?.tokens) }
  }

  private async emit(companyId: string, type: 'ai_wallet.updated' | 'ai_wallet.low', data: Record<string, unknown>): Promise<void> {
    if (!this.realtime) return
    try {
      await this.realtime.publish(companyId, type, data)
    } catch {
      // Aviso em tempo real é melhor-esforço: nunca derruba a chamada de IA.
    }
  }
}

function toCounters(raw: Record<string, string> | null | undefined): PeriodCounters {
  return { credits: n(raw?.credits), cost_micros: n(raw?.cost_micros), tokens: n(raw?.tokens) }
}

