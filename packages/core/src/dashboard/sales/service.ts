// Métricas de vendas do dashboard (T55; 02-dashboard.md §3.1–3.2, §5). Venda = `crm.sales` aprovada com `sold_at`
// no intervalo [início 00:00, fim+1 00:00) no fuso da empresa. Fórmulas em docs/kpis.md.
import { and, count, eq, gte, inArray, lt, min, sql, type SQL } from 'drizzle-orm'
import { chats, companies, connections, contacts, expenseRules, messages, products, sales, DEFAULT_TIME_ZONE, type Database } from '@crm/db'
import {
  addDays,
  computeExpenses,
  computeKpis,
  daysInclusive,
  eachDay,
  isValidDate,
  previousRange,
  todayIn,
  trendsOf,
  type ExpenseLine,
  type ExpenseRuleLike,
  type SalesKpis,
  type Trend,
} from './calc'

/** Gasto em anúncios (Meta) no intervalo, em centavos. A T101 registra a implementação real. */
export interface AdSpendProvider {
  getSpend(query: { companyId: string; startDate: string; endDate: string; timeZone: string; connectionIds: string[] }): Promise<number>
}

/** Padrão: sem gasto (0). */
export const zeroAdSpendProvider: AdSpendProvider = { getSpend: async () => 0 }
let registeredAdSpend: AdSpendProvider | null = null
/** Registra o provedor de gasto padrão (T101). */
export function registerAdSpendProvider(p: AdSpendProvider | null): void {
  registeredAdSpend = p
}
export function defaultAdSpendProvider(): AdSpendProvider {
  return registeredAdSpend ?? zeroAdSpendProvider
}

/** Cache do bloco calculado (Redis na API). */
export interface DashboardCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs: number): Promise<void>
}

export const DASHBOARD_CACHE_TTL_MS = 5 * 60_000
export const DASHBOARD_MAX_RANGE_DAYS = 366
export const UNKNOWN_STATE = 'Desconhecido'
export const NO_PRODUCT = 'Sem produto'

export class DashboardQueryError extends Error {
  constructor(readonly fields: { path: string; message: string }[]) {
    super('Filtros inválidos')
    this.name = 'DashboardQueryError'
  }
}

export interface DashboardFilters {
  start_date?: string
  end_date?: string
  connection_ids?: string[]
  product_ids?: string[]
}

export interface SalesBlock {
  kpis: SalesKpis
  previous: SalesKpis
  trends: Record<string, Trend>
  revenue_by_currency: Record<string, number>
  sales_over_time: { bucket_start: string; revenue_cents: number; sales_count: number }[]
  sales_by_hour: { hour: number; sales_count: number; revenue_cents: number }[]
  sales_by_connection: { connection_id: string | null; connection_name: string | null; connection_number: string | null; sales_count: number; revenue_cents: number }[]
  sales_by_state: { state: string; sales_count: number; revenue_cents: number }[]
  sales_by_product: { product_id: string | null; product_name: string; sales_count: number; revenue_cents: number }[]
  expenses_breakdown: ExpenseLine[]
}

export interface DashboardResult {
  range: { start_date: string; end_date: string; time_zone: string; granularity: 'hour' | 'day' }
  previous_range: { start_date: string; end_date: string }
  cached: boolean
  computed_at: string
  sales?: SalesBlock
}

export interface SalesDashboardServiceOptions {
  db: Database
  adSpend?: AdSpendProvider
  cache?: DashboardCache
  cacheTtlMs?: number
  now?: () => Date
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uniq = (a: string[] | undefined) => [...new Set((a ?? []).map((s) => s.trim()).filter(Boolean))].sort()

interface Range {
  start: string
  end: string
  tz: string
}

export class SalesDashboardService {
  constructor(private readonly opts: SalesDashboardServiceOptions) {}

  /** Fuso da empresa. */
  async timeZone(companyId: string): Promise<string> {
    const [c] = await this.opts.db.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId)).limit(1)
    return c?.tz || DEFAULT_TIME_ZONE
  }

  /**
   * Dashboard da empresa. `includeSales = false` (sem `dashboard.sales`) devolve só período e metadados.
   * O bloco calculado fica em cache por (empresa, período, filtros) por 5 min; `forceRefresh` recalcula (AC-T55-03).
   */
  async get(companyId: string, filters: DashboardFilters, o: { includeSales: boolean; forceRefresh?: boolean }): Promise<DashboardResult> {
    const tz = await this.timeZone(companyId)
    const today = todayIn(tz, this.now())
    const start = filters.start_date ?? today
    const end = filters.end_date ?? today
    const connectionIds = uniq(filters.connection_ids)
    const productIds = uniq(filters.product_ids)
    const errors: { path: string; message: string }[] = []
    if (!isValidDate(start)) errors.push({ path: 'start_date', message: 'Use YYYY-MM-DD' })
    if (!isValidDate(end)) errors.push({ path: 'end_date', message: 'Use YYYY-MM-DD' })
    if (!errors.length && end < start) errors.push({ path: 'end_date', message: 'O fim é antes do início' })
    if (!errors.length && daysInclusive(start, end) > DASHBOARD_MAX_RANGE_DAYS) errors.push({ path: 'end_date', message: `Intervalo de até ${DASHBOARD_MAX_RANGE_DAYS} dias` })
    if (connectionIds.some((id) => !UUID_RE.test(id))) errors.push({ path: 'connection_ids', message: 'Ids de conexão inválidos' })
    if (productIds.some((id) => !UUID_RE.test(id))) errors.push({ path: 'product_ids', message: 'Ids de produto inválidos' })
    if (errors.length) throw new DashboardQueryError(errors)

    const range: Range = { start, end, tz }
    const prev = previousRange(start, end)
    const base = {
      range: { start_date: start, end_date: end, time_zone: tz, granularity: (start === end ? 'hour' : 'day') as 'hour' | 'day' },
      previous_range: prev,
    }
    if (!o.includeSales) return { ...base, cached: false, computed_at: this.now().toISOString() }

    const key = `crm:dashboard:sales:v1:${companyId}:${start}:${end}:${tz}:c=${connectionIds.join(',')}:p=${productIds.join(',')}`
    const cache = this.opts.cache
    if (cache && !o.forceRefresh) {
      const hit = await cache.get(key).catch(() => null)
      if (hit) {
        const parsed = JSON.parse(hit) as { computed_at: string; sales: SalesBlock }
        return { ...base, cached: true, computed_at: parsed.computed_at, sales: parsed.sales }
      }
    }
    const salesBlock = await this.computeSales(companyId, range, { start: prev.start_date, end: prev.end_date, tz }, connectionIds, productIds)
    const computed_at = this.now().toISOString()
    if (cache) await cache.set(key, JSON.stringify({ computed_at, sales: salesBlock }), this.opts.cacheTtlMs ?? DASHBOARD_CACHE_TTL_MS).catch(() => undefined)
    return { ...base, cached: false, computed_at, sales: salesBlock }
  }

  // ---------------------------------------------------------------- cálculo

  private async computeSales(companyId: string, range: Range, prev: Range, connectionIds: string[], productIds: string[]): Promise<SalesBlock> {
    const rules = await this.rules(companyId)
    const [cur, before] = await Promise.all([this.period(companyId, range, connectionIds, productIds, rules, true), this.period(companyId, prev, connectionIds, productIds, rules, false)])
    return { ...cur.block, kpis: cur.kpis, previous: before.kpis, trends: trendsOf(cur.kpis, before.kpis) } as SalesBlock
  }

  private async period(companyId: string, range: Range, connectionIds: string[], productIds: string[], rules: ExpenseRuleLike[], detailed: boolean) {
    const db = this.opts.db
    const lo = sql`(${range.start}::date)::timestamp at time zone ${range.tz}`
    const hi = sql`(${addDays(range.end, 1)}::date)::timestamp at time zone ${range.tz}`
    const where: SQL[] = [eq(sales.companyId, companyId), eq(sales.status, 'approved'), gte(sales.soldAt, lo), lt(sales.soldAt, hi)]
    if (connectionIds.length) where.push(inArray(sales.connectionId, connectionIds))
    if (productIds.length) where.push(inArray(sales.productId, productIds))
    const hourGranularity = range.start === range.end
    const local = sql`(${sales.soldAt} at time zone ${range.tz})`
    const bucket = hourGranularity ? sql<string>`to_char(${local}, 'YYYY-MM-DD"T"HH24:00')` : sql<string>`to_char(${local}, 'YYYY-MM-DD')`
    const hour = sql<number>`extract(hour from ${local})::int`
    const state = sql<string>`coalesce(nullif(trim(${contacts.state}), ''), ${UNKNOWN_STATE})`

    const rows = await db
      .select({
        bucket,
        hour,
        connectionId: sales.connectionId,
        state,
        productId: sales.productId,
        currency: sales.currency,
        n: count(),
        cents: sql<number>`coalesce(sum(${sales.amountCents}), 0)::bigint`,
      })
      .from(sales)
      .leftJoin(contacts, eq(contacts.id, sales.contactId))
      .where(and(...where))
      // Posicional: o fuso vira parâmetros distintos no SELECT e no GROUP BY, e o Postgres não os casaria.
      .groupBy(sql`1, 2, 3, 4, 5, 6`)

    const num = (v: unknown) => Number(v ?? 0)
    let revenue = 0
    let salesCount = 0
    const byCurrency: Record<string, number> = {}
    for (const r of rows) {
      revenue += num(r.cents)
      salesCount += num(r.n)
      byCurrency[r.currency] = (byCurrency[r.currency] ?? 0) + num(r.cents)
    }

    const [newLeads, spend] = await Promise.all([
      this.newLeads(companyId, lo, hi, connectionIds),
      (this.opts.adSpend ?? defaultAdSpendProvider()).getSpend({ companyId, startDate: range.start, endDate: range.end, timeZone: range.tz, connectionIds }),
    ])
    const spendCents = Math.max(0, Math.round(Number(spend) || 0))
    const expenses = computeExpenses(rules, range, { revenue_cents: revenue, spend_cents: spendCents })
    const kpis = computeKpis({ new_leads: newLeads, sales_count: salesCount, revenue_cents: revenue, spend_cents: spendCents, expenses_cents: expenses.total_cents })
    if (!detailed) return { kpis, block: {} }

    const add = <K>(map: Map<K, { n: number; c: number }>, k: K, n: number, c: number) => {
      const cur = map.get(k) ?? { n: 0, c: 0 }
      cur.n += n
      cur.c += c
      map.set(k, cur)
    }
    const byBucket = new Map<string, { n: number; c: number }>()
    const byHour = new Map<number, { n: number; c: number }>()
    const byConn = new Map<string | null, { n: number; c: number }>()
    const byState = new Map<string, { n: number; c: number }>()
    const byProduct = new Map<string | null, { n: number; c: number }>()
    for (const r of rows) {
      const n = num(r.n)
      const c = num(r.cents)
      add(byBucket, r.bucket, n, c)
      add(byHour, num(r.hour), n, c)
      add(byConn, r.connectionId, n, c)
      add(byState, r.state, n, c)
      add(byProduct, r.productId, n, c)
    }

    const buckets = hourGranularity
      ? Array.from({ length: 24 }, (_, h) => `${range.start}T${String(h).padStart(2, '0')}:00`)
      : eachDay(range.start, range.end)
    const connIds = [...byConn.keys()].filter((k): k is string => k !== null)
    const prodIds = [...byProduct.keys()].filter((k): k is string => k !== null)
    const [connRows, prodRows] = await Promise.all([
      connIds.length
        ? db.select({ id: connections.id, name: connections.name, phone: connections.phoneNumber }).from(connections).where(and(eq(connections.companyId, companyId), inArray(connections.id, connIds)))
        : [],
      prodIds.length ? db.select({ id: products.id, name: products.name }).from(products).where(and(eq(products.companyId, companyId), inArray(products.id, prodIds))) : [],
    ])
    const connInfo = new Map(connRows.map((c) => [c.id, c]))
    const prodName = new Map(prodRows.map((p) => [p.id, p.name]))
    const byRevenue = <T extends { revenue_cents: number; sales_count: number }>(a: T, b: T) => b.revenue_cents - a.revenue_cents || b.sales_count - a.sales_count

    return {
      kpis,
      block: {
        revenue_by_currency: byCurrency,
        sales_over_time: buckets.map((b) => ({ bucket_start: b, revenue_cents: byBucket.get(b)?.c ?? 0, sales_count: byBucket.get(b)?.n ?? 0 })),
        sales_by_hour: Array.from({ length: 24 }, (_, h) => ({ hour: h, sales_count: byHour.get(h)?.n ?? 0, revenue_cents: byHour.get(h)?.c ?? 0 })),
        sales_by_connection: [...byConn.entries()]
          .map(([id, v]) => ({
            connection_id: id,
            connection_name: id ? (connInfo.get(id)?.name ?? null) : null,
            connection_number: id ? (connInfo.get(id)?.phone ?? null) : null,
            sales_count: v.n,
            revenue_cents: v.c,
          }))
          .sort(byRevenue),
        sales_by_state: [...byState.entries()].map(([s, v]) => ({ state: s, sales_count: v.n, revenue_cents: v.c })).sort(byRevenue),
        sales_by_product: [...byProduct.entries()]
          .map(([id, v]) => ({ product_id: id, product_name: id ? (prodName.get(id) ?? NO_PRODUCT) : NO_PRODUCT, sales_count: v.n, revenue_cents: v.c }))
          .sort(byRevenue),
        expenses_breakdown: expenses.lines,
      },
    }
  }

  /** Contatos cuja primeira mensagem recebida cai no intervalo (com conexões: só chats delas). */
  private async newLeads(companyId: string, lo: SQL, hi: SQL, connectionIds: string[]): Promise<number> {
    const db = this.opts.db
    const where: SQL[] = [eq(messages.companyId, companyId), eq(messages.direction, 'inbound')]
    if (connectionIds.length) where.push(inArray(chats.connectionId, connectionIds))
    const first = min(sql<Date>`coalesce(${messages.sentAt}, ${messages.createdAt})`)
    const sub = db
      .select({ contactId: chats.contactId, first: first.as('first') })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(and(...where))
      .groupBy(chats.contactId)
      .as('firsts')
    const [r] = await db
      .select({ n: count() })
      .from(sub)
      .where(and(gte(sub.first, lo), lt(sub.first, hi)))
    return r?.n ?? 0
  }

  private async rules(companyId: string): Promise<ExpenseRuleLike[]> {
    const rows = await this.opts.db.select().from(expenseRules).where(eq(expenseRules.companyId, companyId))
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      amount_cents: r.amountCents,
      percent: r.percent === null ? null : Number(r.percent),
      percent_base: r.percentBase,
      period: r.period,
      active_from: r.activeFrom,
      active_to: r.activeTo,
    }))
  }

  private now = () => this.opts.now?.() ?? new Date()
}
