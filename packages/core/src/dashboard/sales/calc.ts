// Cálculos puros do dashboard de vendas (T55; fórmulas fechadas em docs/kpis.md).
// Datas `YYYY-MM-DD` são dias de calendário no fuso da empresa; a aritmética usa UTC só como calendário.

const DAY_MS = 86_400_000
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const toUtc = (d: string) => Date.parse(`${d}T00:00:00Z`)
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function isValidDate(d: string): boolean {
  return DATE_RE.test(d) && !Number.isNaN(toUtc(d)) && fromUtc(toUtc(d)) === d
}

export function addDays(d: string, n: number): string {
  return fromUtc(toUtc(d) + n * DAY_MS)
}

/** Dias de `a` a `b`, inclusivos (0 se b < a). */
export function daysInclusive(a: string, b: string): number {
  return Math.max(0, Math.round((toUtc(b) - toUtc(a)) / DAY_MS) + 1)
}

/** Hoje (YYYY-MM-DD) no fuso. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Período anterior: mesma duração, terminando no dia anterior ao início (AC-T55-02). */
export function previousRange(start: string, end: string): { start_date: string; end_date: string } {
  const days = daysInclusive(start, end)
  const prevEnd = addDays(start, -1)
  return { start_date: addDays(prevEnd, -(days - 1)), end_date: prevEnd }
}

/** Dias da lista inclusiva. */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

export type TrendDirection = 'up' | 'down' | 'neutral'
export interface Trend {
  direction: TrendDirection
  delta_pct: number | null
}

/** Neutra quando o anterior é 0/nulo ou |Δ| < 0,05% (AC-T55-02). */
export function trendOf(current: number | null, previous: number | null): Trend {
  if (current === null || previous === null || previous === 0) return { direction: 'neutral', delta_pct: null }
  const delta = (current - previous) / Math.abs(previous)
  const delta_pct = Math.round(delta * 10_000) / 100
  if (Math.abs(delta) < 0.0005) return { direction: 'neutral', delta_pct }
  return { direction: delta > 0 ? 'up' : 'down', delta_pct }
}

// ---------------------------------------------------------------- despesas

export type ExpensePeriod = 'day' | 'week' | 'month'
export type ExpenseBase = 'revenue' | 'spend' | 'profit_pre'
export const EXPENSE_PERIOD_DAYS: Readonly<Record<ExpensePeriod, number>> = { day: 1, week: 7, month: 30 }

export interface ExpenseRuleLike {
  id: string
  name: string
  kind: 'fixed' | 'percent'
  amount_cents: number | null
  percent: number | null
  percent_base: ExpenseBase | null
  period: ExpensePeriod
  active_from: string | null
  active_to: string | null
}

export interface ExpenseLine {
  rule_id: string
  name: string
  kind: 'fixed' | 'percent'
  period: ExpensePeriod
  percent_base: ExpenseBase | null
  value_cents: number
}

/**
 * Despesas das regras vigentes no intervalo (02 §3.5). `fixed`: valor × (overlap ÷ dias do período);
 * `percent`: base × % × (overlap ÷ dias do intervalo). Lucro antes das taxas negativo vira base 0.
 * Cada regra é arredondada para centavos; regras sem overlap ficam de fora.
 */
export function computeExpenses(
  rules: readonly ExpenseRuleLike[],
  range: { start: string; end: string },
  totals: { revenue_cents: number; spend_cents: number },
): { lines: ExpenseLine[]; total_cents: number } {
  const days = daysInclusive(range.start, range.end)
  const lines: ExpenseLine[] = []
  for (const r of rules) {
    const from = r.active_from && r.active_from > range.start ? r.active_from : range.start
    const to = r.active_to && r.active_to < range.end ? r.active_to : range.end
    const overlap = daysInclusive(from, to)
    if (!overlap || !days) continue
    let value: number
    if (r.kind === 'fixed') value = ((r.amount_cents ?? 0) * overlap) / EXPENSE_PERIOD_DAYS[r.period]
    else {
      const base =
        r.percent_base === 'spend' ? totals.spend_cents : r.percent_base === 'profit_pre' ? Math.max(0, totals.revenue_cents - totals.spend_cents) : totals.revenue_cents
      value = base * ((r.percent ?? 0) / 100) * (overlap / days)
    }
    lines.push({ rule_id: r.id, name: r.name, kind: r.kind, period: r.period, percent_base: r.kind === 'percent' ? r.percent_base : null, value_cents: Math.round(value) })
  }
  return { lines, total_cents: lines.reduce((a, l) => a + l.value_cents, 0) }
}

// ---------------------------------------------------------------- KPIs

export interface SalesKpis {
  new_leads: number
  sales_count: number
  revenue_cents: number
  avg_ticket_cents: number | null
  conversion_rate: number | null
  spend_cents: number
  roas: number | null
  profit_pre_fees_cents: number
  expenses_cents: number
  profit_cents: number
}

export function computeKpis(input: { new_leads: number; sales_count: number; revenue_cents: number; spend_cents: number; expenses_cents: number }): SalesKpis {
  const { new_leads, sales_count, revenue_cents, spend_cents, expenses_cents } = input
  const profitPre = revenue_cents - spend_cents
  return {
    new_leads,
    sales_count,
    revenue_cents,
    avg_ticket_cents: sales_count ? Math.round(revenue_cents / sales_count) : null,
    conversion_rate: new_leads ? sales_count / new_leads : null,
    spend_cents,
    roas: spend_cents ? revenue_cents / spend_cents : null,
    profit_pre_fees_cents: profitPre,
    expenses_cents,
    profit_cents: profitPre - expenses_cents,
  }
}

export const TREND_KPIS = ['new_leads', 'sales_count', 'revenue_cents', 'avg_ticket_cents', 'conversion_rate', 'spend_cents', 'roas', 'profit_pre_fees_cents', 'expenses_cents', 'profit_cents'] as const

export function trendsOf(current: SalesKpis, previous: SalesKpis): Record<(typeof TREND_KPIS)[number], Trend> {
  const out = {} as Record<(typeof TREND_KPIS)[number], Trend>
  for (const k of TREND_KPIS) out[k] = trendOf(current[k], previous[k])
  return out
}
