// Consulta das vendas internas por anúncio (T105) e ligação no bundle do Gerenciador (opção `internalSales` do
// `MetaBundleService`). Período `since..until` em datas locais da empresa: [since 00:00, until+1 00:00) no fuso de
// `crm.companies.time_zone` (mesmo padrão do dashboard da T55). Só vendas `approved`; `source_id = any(ids)` exato.
import { and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { companies, sales, type Database } from '@crm/db'
import type { BundleRow } from '../structure/account'
import { fxRatesFromEnv, type FxRate } from '../structure/metrics'
import { addDays } from '../structure/params'
import {
  applyInternalMetrics,
  hasSourceId,
  joinInternalSales,
  type InternalSaleAggregate,
  type JoinResult,
  type JoinRows,
} from './join'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** Status de venda que entram no cruzamento (como o dashboard da T55). */
export const INTERNAL_SALE_STATUSES = ['approved'] as const

export class InternalSalesError extends Error {
  constructor(
    readonly field: 'since' | 'until' | 'time_zone' | 'company',
    message: string,
  ) {
    super(message)
    this.name = 'InternalSalesError'
  }
}

export interface InternalSalesQuery {
  companyId: string
  /** `YYYY-MM-DD` no fuso da empresa (inclusive). */
  since: string
  until: string
  /** Ids dos anúncios (Meta). Vazios / só espaços são ignorados. */
  adIds: readonly string[]
  /** Fuso explícito; sem ele, lê `crm.companies.time_zone`. */
  timeZone?: string
}

/** Contrato da opção `internalSales` do `MetaBundleService` (T101): preenche as linhas e devolve avisos. */
export interface SalesJoin {
  apply(
    companyId: string,
    period: { since: string; until: string; displayCurrency: string },
    rows: JoinRows,
  ): Promise<{ warnings: string[] }>
}

export interface InternalSalesServiceOptions {
  db: Database
  fx?: FxRate
}

const validDate = (s: string) =>
  DATE_RE.test(s) &&
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    throw new InternalSalesError('time_zone', `Fuso inválido: ${tz}`)
  }
}

export class InternalSalesService implements SalesJoin {
  private readonly db: Database
  private readonly fx: FxRate

  constructor(opts: InternalSalesServiceOptions) {
    this.db = opts.db
    this.fx = opts.fx ?? fxRatesFromEnv()
  }

  /** Vendas aprovadas do período agregadas por (`source_id`, moeda), só para os anúncios pedidos. */
  async aggregates(q: InternalSalesQuery): Promise<InternalSaleAggregate[]> {
    if (!validDate(q.since)) throw new InternalSalesError('since', 'Data inicial inválida (YYYY-MM-DD)')
    if (!validDate(q.until)) throw new InternalSalesError('until', 'Data final inválida (YYYY-MM-DD)')
    if (q.since > q.until) throw new InternalSalesError('until', 'A data final é anterior à inicial')
    const tz = q.timeZone ?? (await this.companyTimeZone(q.companyId))
    assertTimeZone(tz)
    const ids = [...new Set(q.adIds.filter(hasSourceId))]
    if (ids.length === 0) return []
    const lo = sql`(${q.since}::date)::timestamp at time zone ${tz}`
    const hi = sql`(${addDays(q.until, 1)}::date)::timestamp at time zone ${tz}`
    const rows = await this.db
      .select({
        sourceId: sales.sourceId,
        currency: sales.currency,
        n: count(),
        cents: sql<string>`coalesce(sum(${sales.amountCents}), 0)::bigint`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.companyId, q.companyId),
          inArray(sales.status, [...INTERNAL_SALE_STATUSES]),
          gte(sales.soldAt, lo),
          lt(sales.soldAt, hi),
          inArray(sales.sourceId, ids),
        ),
      )
      .groupBy(sales.sourceId, sales.currency)
    return rows.map((r) => ({
      sourceId: r.sourceId!,
      currency: r.currency,
      count: Number(r.n),
      amountCents: Number(r.cents),
    }))
  }

  /** Consulta + cruzamento (sem gravar nas linhas). */
  async join(
    companyId: string,
    period: { since: string; until: string; displayCurrency: string; timeZone?: string },
    rows: JoinRows,
  ): Promise<JoinResult> {
    const aggregates = await this.aggregates({
      companyId,
      since: period.since,
      until: period.until,
      adIds: rows.ad.map((r: BundleRow) => r.id),
      ...(period.timeZone ? { timeZone: period.timeZone } : {}),
    })
    return joinInternalSales(rows, aggregates, { displayCurrency: period.displayCurrency, fx: this.fx })
  }

  /** Ligação no bundle: cruza e grava `purchases_leona`/`purchase_value_leona(_display)`/`roas_internal` nas linhas. */
  async apply(
    companyId: string,
    period: { since: string; until: string; displayCurrency: string },
    rows: JoinRows,
  ): Promise<{ warnings: string[] }> {
    const result = await this.join(companyId, period, rows)
    applyInternalMetrics(rows, result)
    return { warnings: result.warnings }
  }

  private async companyTimeZone(companyId: string): Promise<string> {
    const [c] = await this.db
      .select({ tz: companies.timeZone })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1)
    if (!c) throw new InternalSalesError('company', 'Empresa não encontrada')
    return c.tz
  }
}
