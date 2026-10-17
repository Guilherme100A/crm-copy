// Aba Atendimento (02 §5.37–5.42; T87): KPIs com tendência (invertida em "sem resposta" e tempo), atendimentos no
// período, mapa de calor dia×hora com o pico destacado, tempo de resposta, leads por status por conexão, desempenho por
// atendente (tabela ordenável ou pizza) e atendimentos por departamento (lista ou pizza, menores em "Outros").
// Período > 92 dias mostra o aviso sem chamar a API (e o 422 do servidor vira o mesmo aviso).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { DEFAULT_TZ } from '@/features/dashboard/api'
import { periodOf } from '@/features/dashboard/search'
import type { DashboardTabProps } from '@/features/dashboard/tabs'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { attendanceQuery, refreshAttendance, type AttendanceBlock, type AttendanceResult } from './api'
import {
  ATTENDANCE_MAX_DAYS,
  KPI_KEYS,
  USER_SORT_KEYS,
  attendanceParams,
  bucketLabel,
  formatDuration,
  formatKpi,
  groupSlices,
  heatGrid,
  heatLevel,
  isRangeError,
  nextSort,
  peakCells,
  sortUsers,
  tooLong,
  trendOf,
  type AttendanceKpi,
  type Slice,
  type SortDir,
  type UserSortKey,
} from './logic'

const NS = 'dashboard-attendance'
const PRIMARY = 'var(--color-primary, #2563eb)'
/** Paleta das fatias sem cor própria (departamento sem cor, atendentes). */
const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#db2777', '#7c3aed', '#0891b2', '#64748b']
const OTHERS_COLOR = '#94a3b8'
const HEAT = ['bg-muted', 'bg-primary/20', 'bg-primary/40', 'bg-primary/65', 'bg-primary']

export function AttendancePanel({ connectionIds, period: periodProp, timeZone, search, ready = true, renderFilters }: DashboardTabProps) {
  const t = useT(NS)
  const qc = useQueryClient()
  const period = periodProp ?? periodOf(search ?? {}, timeZone ?? DEFAULT_TZ)
  const params = useMemo(() => attendanceParams(period, connectionIds), [period, connectionIds])
  const blocked = tooLong(period)
  const q = useQuery({ ...attendanceQuery(params), enabled: ready && !blocked })
  const [refreshing, setRefreshing] = useState(false)

  const refresh = async () => {
    if (blocked) return
    setRefreshing(true)
    try {
      qc.setQueryData(attendanceQuery(params).queryKey, await refreshAttendance(params))
    } catch (err) {
      if (!isRangeError(err)) notify('attendance-refresh-error', t('error'))
    } finally {
      setRefreshing(false)
    }
  }

  const rangeWarning = blocked || (q.isError && isRangeError(q.error))
  // Com placeholder de outro período, a resposta ainda é a anterior: só confia nela quando é deste período.
  const data = !rangeWarning ? q.data : undefined

  return (
    <div data-testid="attendance" className="flex min-w-0 flex-col gap-4">
      {renderFilters?.({ computedAt: data?.computed_at ?? null, refreshing, onRefresh: () => void refresh() })}
      {rangeWarning ? (
        <p data-testid="attendance-range-warning" role="alert" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
          {t('rangeWarning', { days: ATTENDANCE_MAX_DAYS })}
        </p>
      ) : q.isError && !data ? (
        <div data-testid="attendance-error" role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 p-6 text-center text-sm">
          <p>{t('error')}</p>
          <Button variant="outline" size="sm" data-testid="attendance-retry" onClick={() => void q.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : !data ? (
        <div data-testid="attendance-loading" aria-busy className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {KPI_KEYS.map((k) => (
            <div key={k} className="h-20 animate-pulse rounded-xl border bg-muted/50" />
          ))}
        </div>
      ) : (
        <Content data={data} loading={q.isFetching} />
      )}
    </div>
  )
}

function Content({ data, loading }: { data: AttendanceResult; loading: boolean }) {
  const t = useT(NS)
  const a = data.attendance
  const granularity = data.range.granularity
  const overTime = a.attendance_over_time.map((b) => ({ ...b, label: bucketLabel(b.bucket_start, granularity) }))
  const responseTime = a.response_time_over_time.map((b) => ({ ...b, label: bucketLabel(b.bucket_start, granularity) }))
  const byStatus = a.leads_by_status_chart.map((c) => ({ ...c, label: c.connection_name ?? t('noConnection') }))
  const status = ['new_leads', 'attended_leads', 'resolved_leads'] as const
  return (
    <div className="flex flex-col gap-4" aria-busy={loading}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {KPI_KEYS.map((k) => (
          <KpiCard key={k} kpi={k} block={a} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card id="attendance-chart-over-time" title={t('charts.overTime')} empty={a.new_leads === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={overTime} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.4} />
              <XAxis dataKey="label" fontSize={11} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} width={40} fontSize={11} />
              <Tooltip formatter={(v) => [String(v), t('charts.chats')]} />
              <Bar dataKey="count" fill={PRIMARY} radius={3} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Heatmap block={a} />
        <Card id="attendance-chart-response-time" title={t('charts.responseTime')} hint={t('charts.responseTimeHint')} empty={a.response_time_seconds === null}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={responseTime} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.4} />
              <XAxis dataKey="label" fontSize={11} interval="preserveStartEnd" />
              <YAxis tickFormatter={(v: number) => formatDuration(v)} width={72} fontSize={11} />
              <Tooltip formatter={(v) => [formatDuration(Number(v)), t('charts.average')]} />
              <Line type="monotone" dataKey="average_seconds" stroke={PRIMARY} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
        <Card id="attendance-chart-by-status" title={t('charts.byStatus')} empty={byStatus.length === 0 || a.new_leads === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byStatus} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.4} />
              <XAxis dataKey="label" fontSize={11} />
              <YAxis allowDecimals={false} width={40} fontSize={11} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {status.map((s, i) => (
                <Bar key={s} dataKey={s} name={t(`status.${s}`)} fill={PALETTE[i]} radius={3} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Users block={a} />
        <Departments block={a} />
      </div>
    </div>
  )
}

function KpiCard({ kpi, block }: { kpi: AttendanceKpi; block: AttendanceBlock }) {
  const t = useT(NS)
  const trend = trendOf(block, kpi)
  const Icon = trend.direction === 'up' ? TrendingUp : trend.direction === 'down' ? TrendingDown : null
  return (
    <div data-testid={`attendance-kpi-${kpi}`} className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3">
      <p className="truncate text-xs text-muted-foreground" title={t(`kpis.${kpi}.hint`)}>
        {t(`kpis.${kpi}.label`)}
      </p>
      <p data-testid={`attendance-kpi-${kpi}-value`} className="truncate text-lg font-semibold tabular-nums">
        {formatKpi(kpi, block[kpi])}
      </p>
      <p
        data-testid={`attendance-kpi-${kpi}-trend`}
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

function Card({ id, title, hint, empty, actions, children, tall }: { id: string; title: string; hint?: string; empty: boolean; actions?: ReactNode; children: ReactNode; tall?: boolean }) {
  const t = useT(NS)
  return (
    <section data-testid={id} className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        {actions}
      </div>
      {empty ? (
        <p data-testid={`${id}-empty`} className="flex h-56 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className={cn('w-full min-w-0', tall ? 'min-h-56' : 'h-56')}>{children}</div>
      )}
    </section>
  )
}

function Heatmap({ block }: { block: AttendanceBlock }) {
  const t = useT(NS)
  const grid = heatGrid(block.attendance_by_weekday_hour)
  const max = Math.max(0, ...grid.flat())
  const peaks = peakCells(block)
  const isPeak = (w: number, h: number) => peaks.some((p) => p.weekday === w && p.hour === h)
  const first = peaks[0]
  const hour = (h: number) => `${String(h).padStart(2, '0')}h`
  return (
    <Card id="attendance-heatmap" title={t('heatmap.title')} empty={max === 0} tall>
      <div className="flex flex-col gap-2">
        {first ? (
          <p data-testid="attendance-peak" data-weekday={first.weekday} data-hour={first.hour} data-count={first.count} className="text-xs font-medium">
            {t('heatmap.peak', { day: t(`weekdays.${first.weekday}`), hour: hour(first.hour), n: first.count })}
            {peaks.length > 1 ? ` ${t('heatmap.ties', { n: peaks.length - 1 })}` : ''}
          </p>
        ) : null}
        <div className="overflow-x-auto">
          {/* Layout fixo: as 24 colunas com a mesma largura (no automático, colunas sem rótulo de hora somem). */}
          <table className="w-full min-w-[28rem] table-fixed border-separate border-spacing-0.5 text-[10px]">
            <thead>
              <tr>
                <th className="w-8" />
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} scope="col" className="font-normal text-muted-foreground">
                    {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row, w) => (
                <tr key={w}>
                  <th scope="row" className="pr-1 text-left font-normal text-muted-foreground">
                    {t(`weekdaysShort.${w}`)}
                  </th>
                  {row.map((count, h) => {
                    const peak = isPeak(w, h)
                    return (
                      <td
                        key={h}
                        data-testid={`attendance-heat-cell-${w}-${h}`}
                        data-count={count}
                        data-peak={peak ? 'true' : undefined}
                        title={t('heatmap.cell', { day: t(`weekdays.${w}`), hour: hour(h), n: count })}
                        className={cn('h-4 rounded-sm', HEAT[heatLevel(count, max)], peak && 'ring-2 ring-amber-500 ring-offset-1 ring-offset-background')}
                      />
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
          {t('heatmap.less')}
          {HEAT.map((c) => (
            <span key={c} className={cn('size-3 rounded-sm', c)} aria-hidden />
          ))}
          {t('heatmap.more')}
        </div>
      </div>
    </Card>
  )
}

function ViewToggle<V extends string>({ testId, views, value, onChange, label }: { testId: string; views: readonly V[]; value: V; onChange: (v: V) => void; label: (v: V) => string }) {
  return (
    <div data-testid={testId} data-value={value} role="group" className="flex rounded-md border p-0.5 text-xs">
      {views.map((v) => (
        <button
          key={v}
          type="button"
          data-testid={`${testId}-${v}`}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn('rounded px-2 py-0.5', value === v ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}
        >
          {label(v)}
        </button>
      ))}
    </div>
  )
}

function SlicesPie({ slices, testPrefix }: { slices: Slice[]; testPrefix: string }) {
  const data = slices.map((s, i) => ({ name: s.label, value: s.value, fill: s.others ? OTHERS_COLOR : (s.color ?? PALETTE[i % PALETTE.length]!) }))
  return (
    <div className="flex h-full min-w-0 flex-col gap-2 sm:flex-row">
      <div className="h-44 min-w-0 flex-1 sm:h-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="80%" isAnimationActive={false} />
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex min-w-0 flex-col justify-center gap-1 text-xs sm:w-44">
        {slices.map((s, i) => (
          <li key={s.key} data-testid={`${testPrefix}-${s.key}`} data-value={s.value} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: data[i]!.fill }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="tabular-nums text-muted-foreground">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Users({ block }: { block: AttendanceBlock }) {
  const t = useT(NS)
  const [view, setView] = useState<'table' | 'chart'>('table')
  const [sort, setSort] = useState<{ key: UserSortKey; dir: SortDir }>({ key: 'answered', dir: 'desc' })
  const rows = sortUsers(block.leads_by_user, sort.key, sort.dir)
  const slices = groupSlices(
    block.leads_by_user.map((u, i) => ({ key: u.user_id ?? `removed-${i}`, label: u.user_name, value: u.answered_chats, color: null })),
    t('others'),
  )
  const idOf = (u: (typeof rows)[number]) => u.user_id ?? 'removed'
  return (
    <Card
      id="attendance-users"
      title={t('users.title')}
      empty={rows.length === 0}
      tall
      actions={<ViewToggle testId="attendance-users-view" views={['table', 'chart'] as const} value={view} onChange={setView} label={(v) => t(`views.${v}`)} />}
    >
      {view === 'chart' ? (
        slices.length ? (
          <div className="h-56">
            <SlicesPie slices={slices} testPrefix="attendance-users-slice" />
          </div>
        ) : (
          <p className="flex h-56 items-center justify-center text-sm text-muted-foreground">{t('empty')}</p>
        )
      ) : (
        <div className="max-h-72 overflow-auto">
          <table data-testid="attendance-users-table" className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr>
                {USER_SORT_KEYS.map((key) => (
                  <th
                    key={key}
                    scope="col"
                    aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={cn('px-2 py-1.5 font-medium', key === 'name' ? 'text-left' : 'text-right')}
                  >
                    <button type="button" data-testid={`attendance-users-sort-${key}`} onClick={() => setSort((s) => nextSort(s, key))} className="inline-flex items-center gap-1 hover:text-foreground">
                      {t(`users.columns.${key}`)}
                      {sort.key === key ? <span aria-hidden>{sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((u, i) => (
                <tr key={`${idOf(u)}-${i}`} data-testid={`attendance-user-item-${idOf(u)}`} className="border-t">
                  <td data-testid={`attendance-user-item-name-${idOf(u)}`} className="max-w-40 truncate px-2 py-1.5">
                    {u.user_name}
                  </td>
                  <td data-testid={`attendance-user-item-answered-${idOf(u)}`} className="px-2 py-1.5 text-right tabular-nums">
                    {u.answered_chats}
                  </td>
                  <td data-testid={`attendance-user-item-attending-${idOf(u)}`} className="px-2 py-1.5 text-right tabular-nums">
                    {u.attending_chats}
                  </td>
                  <td data-testid={`attendance-user-item-resolved-${idOf(u)}`} className="px-2 py-1.5 text-right tabular-nums">
                    {u.resolved_chats}
                  </td>
                  <td data-testid={`attendance-user-item-time-${idOf(u)}`} className="px-2 py-1.5 text-right tabular-nums">
                    {formatDuration(u.average_response_seconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function Departments({ block }: { block: AttendanceBlock }) {
  const t = useT(NS)
  const [view, setView] = useState<'chart' | 'list'>('chart')
  const all = block.attendance_by_department.map((d) => ({ key: d.department_id ?? 'none', label: d.department_name, value: d.chat_count, color: d.color }))
  const slices = groupSlices(all, t('others'))
  const list = [...all].sort((a, b) => b.value - a.value)
  return (
    <Card
      id="attendance-departments"
      title={t('departments.title')}
      empty={slices.length === 0}
      actions={<ViewToggle testId="attendance-departments-view" views={['chart', 'list'] as const} value={view} onChange={setView} label={(v) => t(`views.${v}`)} />}
    >
      {view === 'chart' ? (
        <SlicesPie slices={slices} testPrefix="attendance-department-slice" />
      ) : (
        <ul className="flex h-full flex-col gap-1 overflow-y-auto text-sm">
          {list.map((d, i) => (
            <li key={d.key} data-testid={`attendance-department-item-${d.key}`} data-value={d.value} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: d.color ?? PALETTE[i % PALETTE.length] }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              <span className="tabular-nums text-muted-foreground">{d.value}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
