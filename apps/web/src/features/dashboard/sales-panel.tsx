// Painel Vendas (02 §5.20–5.35): cards de KPI com tendência sobre o período anterior (verde/vermelho, invertida nos
// gastos), lucro negativo destacado e os gráficos (por período, horário, instância, estado e produto) com estado vazio.
import { TrendingDown, TrendingUp } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { DashboardResult, SalesBlock } from './api'
import { KPI_FIELD, KPI_ORDER, formatInt, formatKpi, formatMoney, trendView, type KpiKey } from './format'

export function SalesPanel({ data, loading }: { data: DashboardResult | undefined; loading: boolean }) {
  const t = useT('dashboard')
  const sales = data?.sales
  if (!sales) {
    return (
      <p data-testid="dashboard-sales-loading" className="text-sm text-muted-foreground">
        {loading ? t('sales.loading') : t('common.error')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-4" aria-busy={loading}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {KPI_ORDER.map((key) => (
          <KpiCard key={key} kpi={key} sales={sales} />
        ))}
      </div>
      <Charts sales={sales} granularity={data.range.granularity} />
    </div>
  )
}

function KpiCard({ kpi, sales }: { kpi: KpiKey; sales: SalesBlock }) {
  const t = useT('dashboard')
  const field = KPI_FIELD[kpi] as keyof SalesBlock['kpis']
  const value = sales.kpis[field]
  const trend = trendView(kpi, sales.trends[field] ?? sales.trends[kpi])
  const negative = (kpi === 'profit' || kpi === 'profit_pre_fees') && typeof value === 'number' && value < 0
  const Icon = trend.direction === 'up' ? TrendingUp : trend.direction === 'down' ? TrendingDown : null
  return (
    <div
      data-testid={`dashboard-kpi-${kpi}`}
      data-negative={negative ? 'true' : undefined}
      className={cn('flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3', negative && 'border-destructive/60 bg-destructive/5')}
    >
      <p className="truncate text-xs text-muted-foreground" title={t(`kpis.${kpi}.hint`)}>
        {t(`kpis.${kpi}.label`)}
      </p>
      <p data-testid={`dashboard-kpi-${kpi}-value`} className={cn('truncate text-lg font-semibold tabular-nums', negative && 'text-destructive')}>
        {formatKpi(kpi, value)}
      </p>
      <p
        data-testid={`dashboard-kpi-${kpi}-trend`}
        data-trend={trend.direction}
        data-good={trend.good === null ? undefined : String(trend.good)}
        title={t('kpis.vsPrevious')}
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium tabular-nums',
          trend.good === true && 'text-emerald-600 dark:text-emerald-400',
          trend.good === false && 'text-destructive',
          trend.good === null && 'text-muted-foreground',
        )}
      >
        {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
        {trend.label}
      </p>
    </div>
  )
}

const BAR = 'var(--color-primary, #2563eb)'

function ChartCard({ id, title, empty, actions, children }: { id: string; title: string; empty: boolean; actions?: ReactNode; children: ReactNode }) {
  const t = useT('dashboard')
  return (
    <section data-testid={id} className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {empty ? (
        <p data-testid={`${id}-empty`} className="flex h-56 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          {t('charts.empty')}
        </p>
      ) : (
        <div className="h-56 w-full min-w-0">{children}</div>
      )}
    </section>
  )
}

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })
/** Eixo: `R$ 14 mil` (cabe numa linha). */
const shortMoney = (cents: number) => `R$ ${compact.format(cents / 100)}`

function Charts({ sales, granularity }: { sales: SalesBlock; granularity: 'hour' | 'day' }) {
  const t = useT('dashboard')
  const [metric, setMetric] = useState<'value' | 'count'>('value')
  const empty = sales.kpis.sales_count === 0
  const key = metric === 'value' ? 'revenue_cents' : 'sales_count'
  const tickFmt = (v: number) => (metric === 'value' ? shortMoney(v) : formatInt(v))
  const tip = (v: unknown) => (metric === 'value' ? formatMoney(Number(v)) : formatInt(Number(v)))
  const overTime = sales.sales_over_time.map((b) => ({ ...b, label: granularity === 'hour' ? b.bucket_start.slice(11, 16) : `${b.bucket_start.slice(8, 10)}/${b.bucket_start.slice(5, 7)}` }))
  const byHour = Array.from({ length: 24 }, (_, h) => sales.sales_by_hour.find((x) => x.hour === h) ?? { hour: h, sales_count: 0, revenue_cents: 0 }).map((x) => ({ ...x, label: `${String(x.hour).padStart(2, '0')}h` }))
  const byConnection = sales.sales_by_connection.map((c) => ({ ...c, label: c.connection_name ?? t('charts.noConnection') }))
  const byState = sales.sales_by_state.map((s) => ({ ...s, label: s.state || t('charts.unknownState') }))
  const byProduct = sales.sales_by_product.map((p) => ({ ...p, label: p.product_name }))

  const toggle = (
    <div data-testid="dashboard-chart-over-time-metric" data-value={metric} role="group" className="flex rounded-md border p-0.5 text-xs">
      {(['value', 'count'] as const).map((m) => (
        <button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)} className={cn('rounded px-2 py-0.5', metric === m ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}>
          {t(`charts.${m}`)}
        </button>
      ))}
    </div>
  )

  const bars = (rows: object[], vertical = false) => (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout={vertical ? 'vertical' : 'horizontal'} margin={{ top: 4, right: 8, bottom: 0, left: vertical ? 8 : 0 }}>
        <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.4} />
        {vertical ? (
          <>
            <XAxis type="number" tickFormatter={tickFmt} fontSize={11} />
            <YAxis type="category" dataKey="label" width={96} fontSize={11} />
          </>
        ) : (
          <>
            <XAxis dataKey="label" fontSize={11} interval="preserveStartEnd" />
            <YAxis tickFormatter={tickFmt} width={84} fontSize={11} />
          </>
        )}
        <Tooltip formatter={tip} />
        <Bar dataKey={key} fill={BAR} radius={3} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <ChartCard id="dashboard-chart-over-time" title={t('charts.overTime')} empty={empty} actions={toggle}>
        {bars(overTime)}
      </ChartCard>
      <ChartCard id="dashboard-chart-by-hour" title={t('charts.byHour')} empty={empty}>
        {bars(byHour)}
      </ChartCard>
      <ChartCard id="dashboard-chart-by-connection" title={t('charts.byConnection')} empty={empty || byConnection.length === 0}>
        {bars(byConnection.slice(0, 10), true)}
      </ChartCard>
      <ChartCard id="dashboard-chart-by-state" title={t('charts.byState')} empty={empty || byState.length === 0}>
        {bars(byState.slice(0, 10), true)}
      </ChartCard>
      <ChartCard id="dashboard-chart-by-product" title={t('charts.byProduct')} empty={empty || byProduct.length === 0}>
        {bars(byProduct.slice(0, 10), true)}
      </ChartCard>
    </div>
  )
}
