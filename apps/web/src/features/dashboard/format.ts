// Formatos e tendência dos KPIs (T78; docs/kpis.md): dinheiro em centavos, conversão em fração, ROAS com 2 casas.
// A tendência é "boa" quando sobe, exceto nos KPIs em que menor é melhor (gastos e despesas), onde a cor inverte.

const NBSP = /[\u00a0\u202f]/g
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const int = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
const dec = (d: number) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })

export const DASH = '—'
export const MINUS = '\u2212'

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return DASH
  return money.format(cents / 100).replace(NBSP, ' ')
}

export const formatInt = (n: number | null | undefined) => (n === null || n === undefined ? DASH : int.format(n))

/** Fração 0,25 → `25,0%`. */
export const formatRate = (f: number | null | undefined) => (f === null || f === undefined || !Number.isFinite(f) ? DASH : `${dec(1).format(f * 100)}%`)

export const formatRoas = (r: number | null | undefined) => (r === null || r === undefined || !Number.isFinite(r) ? DASH : dec(2).format(r))

export type KpiKey = 'new_leads' | 'revenue' | 'sales_count' | 'roas' | 'conversion_rate' | 'avg_ticket' | 'profit' | 'spend' | 'profit_pre_fees' | 'expenses'

/** Campo de `SalesKpis` de cada card. */
export const KPI_FIELD: Record<KpiKey, string> = {
  new_leads: 'new_leads',
  revenue: 'revenue_cents',
  sales_count: 'sales_count',
  roas: 'roas',
  conversion_rate: 'conversion_rate',
  avg_ticket: 'avg_ticket_cents',
  profit: 'profit_cents',
  spend: 'spend_cents',
  profit_pre_fees: 'profit_pre_fees_cents',
  expenses: 'expenses_cents',
}

export const KPI_ORDER: readonly KpiKey[] = ['new_leads', 'revenue', 'sales_count', 'roas', 'conversion_rate', 'avg_ticket', 'profit', 'spend', 'profit_pre_fees', 'expenses']

/** KPIs em que menor é melhor (tendência com cor invertida). */
export const LOWER_IS_BETTER: ReadonlySet<KpiKey> = new Set(['spend', 'expenses'])

export function formatKpi(key: KpiKey, value: number | null | undefined): string {
  switch (key) {
    case 'new_leads':
    case 'sales_count':
      return formatInt(value)
    case 'roas':
      return formatRoas(value)
    case 'conversion_rate':
      return formatRate(value)
    default:
      return formatMoney(value)
  }
}

export interface TrendView {
  direction: 'up' | 'down' | 'neutral'
  /** `null` no neutro. */
  good: boolean | null
  label: string
}

export function trendView(key: KpiKey, trend: { direction: 'up' | 'down' | 'neutral'; delta_pct: number | null } | undefined): TrendView {
  if (!trend || trend.direction === 'neutral' || trend.delta_pct === null) return { direction: 'neutral', good: null, label: DASH }
  const up = trend.direction === 'up'
  const good = LOWER_IS_BETTER.has(key) ? !up : up
  const abs = dec(1).format(Math.abs(trend.delta_pct))
  return { direction: trend.direction, good, label: `${up ? '+' : MINUS}${abs}%` }
}

/** Hora `HH:MM` de um instante no fuso. */
export const timeIn = (iso: string, tz: string, locale = 'pt-BR') =>
  new Intl.DateTimeFormat(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
