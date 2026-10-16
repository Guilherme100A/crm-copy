// Estatísticas do funil (04 §3.6 `hAt`): por etapa o total ACUMULADO (esta + posteriores), a taxa sobre a etapa
// anterior e a largura proporcional; totais (leads, conversão geral com 2 casas, compras e faturamento).
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { columnColor, formatBRL } from '@/features/crms/format'
import { useT } from '@/i18n'
import { statsQuery } from './api'
import type { ApiFilters } from './filters'

const pct = (n: number, decimals: 1 | 2) => `${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Number.isFinite(n) ? n : 0)}%`

export const formatRate = (n: number | null, decimals: 1 | 2 = 1) => (n === null ? '—' : pct(n, decimals))

export function StatsPanel({ crmId, filters, colors = {} }: { crmId: string; filters: ApiFilters; colors?: Record<string, string> }) {
  const t = useT('kanban-tools')
  const q = useQuery(statsQuery(crmId, filters))
  const s = q.data
  return (
    <section data-testid="kt-stats" aria-label={t('stats.title')} className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      <h2 className="text-sm font-semibold">{t('stats.title')}</h2>
      {q.isPending ? (
        <p className="text-sm text-muted-foreground">{t('stats.loading')}</p>
      ) : q.isError || !s ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="flex-1 text-destructive">{t('common.error')}</span>
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <>
          <ol className="flex flex-col gap-2">
            {[...s.stages]
              .sort((a, b) => a.position - b.position)
              .map((st) => (
                <li key={st.column_id} data-testid={`kt-stats-stage-${st.column_id}`} className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-medium">{st.name}</span>
                    <span data-testid={`kt-stats-stage-count-${st.column_id}`} className="font-semibold tabular-nums">
                      {st.count}
                    </span>
                    <span className="text-muted-foreground" title={t('stats.fromPrevious')}>
                      <span data-testid={`kt-stats-stage-rate-${st.column_id}`} className="tabular-nums">
                        {formatRate(st.conversion_rate_from_previous)}
                      </span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${Math.min(100, Math.max(0, st.wave_progress_percent))}%`, backgroundColor: colors[st.column_id] ?? columnColor({ accent_color: null, position: st.position }) }}
                    />
                  </div>
                  <span data-testid={`kt-stats-stage-percent-${st.column_id}`} className="text-[11px] text-muted-foreground tabular-nums">
                    {formatRate(st.wave_progress_percent)}
                  </span>
                </li>
              ))}
          </ol>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Total label={t('stats.leads')} testid="kt-stats-total-leads" value={String(s.totals.total_leads)} />
            <Total label={t('stats.overall')} testid="kt-stats-overall-rate" value={formatRate(s.totals.overall_conversion_rate, 2)} />
            <Total label={t('stats.purchases')} testid="kt-stats-purchases" value={String(s.totals.total_purchases)} />
            <Total label={t('stats.revenue')} testid="kt-stats-revenue" value={formatBRL(s.totals.total_revenue_cents)} />
          </dl>
        </>
      )}
    </section>
  )
}

function Total({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 p-2">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={testid} className="truncate font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  )
}
