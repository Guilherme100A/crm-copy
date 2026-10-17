// Consultas de consumo de IA (T37) usadas pelas rotas da empresa e da plataforma: extrato com cursor estável
// (`created_at desc, id desc`), resumo agrupado (dia no fuso da empresa, feature, modelo, agente) e DTOs no fio.
import { and, desc, eq, gte, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { aiQuotas, aiUsage, aiWalletEntries, companies, llmPrices, type Database } from '@crm/db'
import type { WalletSnapshot } from '@crm/core'
import { z } from 'zod'
import { ApiError } from '../../lib/errors'

type UsageRow = typeof aiUsage.$inferSelect
type EntryRow = typeof aiWalletEntries.$inferSelect
type PriceRow = typeof llmPrices.$inferSelect
type QuotaRow = typeof aiQuotas.$inferSelect

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const USAGE_PAGE_DEFAULT = 50
export const USAGE_PAGE_MAX = 200
export const SUMMARY_GROUPS = ['day', 'feature', 'model', 'agent'] as const
export type SummaryGroup = (typeof SUMMARY_GROUPS)[number]

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export const walletDto = (w: WalletSnapshot) => ({
  balance_credits: w.balanceCredits,
  low_threshold_credits: w.lowThresholdCredits,
  max_overrun_credits: w.maxOverrunCredits,
  status: w.status,
  lifetime_credited_credits: w.lifetimeCreditedCredits,
  lifetime_spent_credits: w.lifetimeSpentCredits,
})

export const usageDto = (r: UsageRow) => ({
  id: r.id,
  company_id: r.companyId,
  request_id: r.requestId,
  created_at: r.createdAt.toISOString(),
  feature: r.feature,
  agent_id: r.agentId,
  source: r.source,
  source_id: r.sourceId,
  provider: r.provider,
  model: r.model,
  kind: r.kind,
  input_tokens: r.inputTokens,
  output_tokens: r.outputTokens,
  cache_read_tokens: r.cacheReadTokens,
  cache_write_tokens: r.cacheWriteTokens,
  reasoning_tokens: r.reasoningTokens,
  units: r.units,
  cost_micros: r.costMicros,
  billed_micros: r.billedMicros,
  credits: r.credits,
  price_id: r.priceId,
  status: r.status,
  error_code: r.errorCode,
})

/** No fio, a recarga (`credit` no ledger) aparece como `topup`. */
/** Última recarga da empresa (`credit` no ledger; T59, card "Última recarga"): valor e data, ou `null`. */
export async function lastTopup(db: Database, companyId: string): Promise<{ amount_credits: number; created_at: string } | null> {
  const [row] = await db
    .select({ amount: aiWalletEntries.amountCredits, at: aiWalletEntries.createdAt })
    .from(aiWalletEntries)
    .where(and(eq(aiWalletEntries.companyId, companyId), eq(aiWalletEntries.kind, 'credit')))
    .orderBy(desc(aiWalletEntries.createdAt), desc(aiWalletEntries.id))
    .limit(1)
  return row ? { amount_credits: Number(row.amount), created_at: row.at.toISOString() } : null
}

export const entryDto = (r: EntryRow) => ({
  id: r.id,
  company_id: r.companyId,
  kind: r.kind === 'credit' ? 'topup' : r.kind,
  amount_credits: r.amountCredits,
  balance_after_credits: r.balanceAfterCredits,
  usage_id: r.usageId,
  note: r.note,
  actor_user_id: r.actorUserId,
  created_at: r.createdAt.toISOString(),
})

export const priceDto = (r: PriceRow, now: Date = new Date()) => ({
  id: r.id,
  provider: r.provider,
  model: r.model,
  kind: r.kind,
  effective_from: r.effectiveFrom.toISOString(),
  input_per_mtok_micros: r.inputPerMtokMicros,
  output_per_mtok_micros: r.outputPerMtokMicros,
  cache_read_per_mtok_micros: r.cacheReadPerMtokMicros,
  cache_write_per_mtok_micros: r.cacheWritePerMtokMicros,
  reasoning_per_mtok_micros: r.reasoningPerMtokMicros,
  unit_price_micros: r.unitPriceMicros,
  /** Ainda não vigente (pode ser editado). */
  scheduled: r.effectiveFrom.getTime() > now.getTime(),
  created_at: r.createdAt.toISOString(),
})

export const quotaDto = (r: QuotaRow) => ({
  period: r.period,
  max_credits: r.maxCredits,
  max_cost_micros: r.maxCostMicros,
  max_tokens: r.maxTokens,
  hard: r.hard,
  updated_at: iso(r.updatedAt),
})

// ------------------------------------------------------------------ extrato

const dateParam = z.iso.datetime({ offset: true }).optional()

export const usageListQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(USAGE_PAGE_MAX).optional(),
  from: dateParam,
  to: dateParam,
  feature: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  agent_id: z.string().max(64).optional(),
  status: z.enum(['charged', 'refunded', 'error']).optional(),
})
export type UsageListQuery = z.infer<typeof usageListQuery>

interface Cursor {
  t: string
  id: string
}
const encodeCursor = (r: UsageRow) => Buffer.from(JSON.stringify({ t: r.createdAt.toISOString(), id: r.id } satisfies Cursor)).toString('base64url')
function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor
    if (typeof c.t === 'string' && !Number.isNaN(Date.parse(c.t)) && typeof c.id === 'string' && UUID_RE.test(c.id)) return c
  } catch {
    // cai no erro abaixo
  }
  throw new ApiError('VALIDATION_ERROR', 'Cursor inválido', { fields: [{ path: 'cursor', message: 'Cursor inválido' }] })
}

/** Filtros comuns (sem o cursor). `companyId` nulo = todas as empresas (plataforma). */
function usageFilters(companyId: string | null, q: Omit<UsageListQuery, 'cursor' | 'limit'>): SQL[] {
  const where: SQL[] = []
  if (companyId) where.push(eq(aiUsage.companyId, companyId))
  if (q.from) where.push(gte(aiUsage.createdAt, new Date(q.from)))
  if (q.to) where.push(lt(aiUsage.createdAt, new Date(q.to)))
  if (q.feature) where.push(eq(aiUsage.feature, q.feature))
  if (q.provider) where.push(eq(aiUsage.provider, q.provider))
  if (q.model) where.push(eq(aiUsage.model, q.model))
  if (q.agent_id) where.push(UUID_RE.test(q.agent_id) ? eq(aiUsage.agentId, q.agent_id) : sql`false`)
  if (q.status) where.push(eq(aiUsage.status, q.status))
  return where
}

/** Página do extrato: mais novo primeiro, desempate pelo id (estável mesmo com vários usos no mesmo instante). */
export async function listUsage(db: Database, companyId: string | null, q: UsageListQuery): Promise<{ items: ReturnType<typeof usageDto>[]; next_cursor: string | null }> {
  const limit = q.limit ?? USAGE_PAGE_DEFAULT
  const where = usageFilters(companyId, q)
  if (q.cursor) {
    const c = decodeCursor(q.cursor)
    const t = new Date(c.t)
    where.push(or(lt(aiUsage.createdAt, t), and(eq(aiUsage.createdAt, t), lt(aiUsage.id, c.id)))!)
  }
  const rows = await db
    .select()
    .from(aiUsage)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(aiUsage.createdAt), desc(aiUsage.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  return { items: page.map(usageDto), next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null }
}

// ------------------------------------------------------------------ resumo

export const summaryQuery = z.object({
  group_by: z.enum(SUMMARY_GROUPS).default('day'),
  from: dateParam,
  to: dateParam,
  feature: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  agent_id: z.string().max(64).optional(),
})
export type SummaryQuery = z.infer<typeof summaryQuery>

export interface SummaryItem {
  key: string | null
  count: number
  input_tokens: number
  output_tokens: number
  cost_micros: number
  credits: number
}

async function companyTimeZone(db: Database, companyId: string): Promise<string> {
  const [row] = await db.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId)).limit(1)
  return row?.tz ?? 'America/Sao_Paulo'
}

/**
 * Resumo do consumo (chamadas com erro não entram): `day` no fuso da empresa (`YYYY-MM-DD`), `feature`, `model`
 * (`provider/model`) ou `agent`. Créditos e custo somam só o que ficou cobrado (reembolsado não conta).
 */
export async function usageSummary(db: Database, companyId: string, q: SummaryQuery): Promise<{ group_by: SummaryGroup; time_zone: string; items: SummaryItem[] }> {
  const tz = await companyTimeZone(db, companyId)
  const keyExpr =
    q.group_by === 'day'
      ? sql<string>`to_char(${aiUsage.createdAt} at time zone ${tz}, 'YYYY-MM-DD')`
      : q.group_by === 'feature'
        ? sql<string | null>`${aiUsage.feature}`
        : q.group_by === 'model'
          ? sql<string>`${aiUsage.provider} || '/' || ${aiUsage.model}`
          : sql<string | null>`${aiUsage.agentId}::text`
  const charged = sql`${aiUsage.status} = 'charged'`
  const rows = await db
    .select({
      key: keyExpr,
      count: sql<string>`count(*)`,
      input_tokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
      output_tokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
      cost_micros: sql<string>`coalesce(sum(${aiUsage.costMicros}) filter (where ${charged}), 0)`,
      credits: sql<string>`coalesce(sum(${aiUsage.credits}) filter (where ${charged}), 0)`,
    })
    .from(aiUsage)
    .where(and(...usageFilters(companyId, q), ne(aiUsage.status, 'error')))
    // Pela posição: com o fuso parametrizado, a mesma expressão repetida no GROUP BY vira outro parâmetro ($n) e o
    // Postgres não a reconhece como a do SELECT.
    .groupBy(sql`1`)
    .orderBy(sql`1`)
  return {
    group_by: q.group_by,
    time_zone: tz,
    items: rows.map((r) => ({
      key: r.key,
      count: Number(r.count),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cost_micros: Number(r.cost_micros),
      credits: Number(r.credits),
    })),
  }
}
