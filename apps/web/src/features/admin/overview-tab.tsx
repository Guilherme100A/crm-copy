// Visão geral (20 §3.12, adaptada à T95): período `start_date`/`end_date` (padrão: últimos 7 dias, com botão para
// voltar ao padrão), cartões de novos cadastros e totais e as mensagens por dia. Sem faturamento (não há billing).
import { useQuery } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { inputClass } from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { adminStatisticsQuery } from './api'
import { fmtNumber, NS } from './ui'

function Card({ id, label, value, sub }: { id: string; label: string; value: string; sub?: string }) {
  return (
    <div data-testid={`admin-overview-${id}`} className="flex flex-col gap-1 rounded-xl border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
    </div>
  )
}

export function OverviewTab() {
  const t = useT(NS)
  const { locale } = useI18n()
  // Vazio = padrão do servidor (últimos 7 dias no fuso da plataforma).
  const [range, setRange] = useState({ start: '', end: '' })
  const q = useQuery(adminStatisticsQuery(range.start, range.end))
  const s = q.data
  const max = Math.max(1, ...(s?.messages_per_day.map((d) => d.total) ?? [1]))
  const n = (v: number) => fmtNumber(v, locale)

  return (
    <div data-testid="admin-panel-overview" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end gap-3">
        <div className="mr-auto min-w-0">
          <h2 className="text-xl font-semibold">{t('tabs.overview')}</h2>
          <p className="text-sm text-muted-foreground">{s ? t('overview.period', { start: s.start_date, end: s.end_date }) : t('overview.subtitle')}</p>
        </div>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('overview.start')}
          <input type="date" data-testid="admin-overview-start" className={inputClass} value={range.start || s?.start_date || ''} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('overview.end')}
          <input type="date" data-testid="admin-overview-end" className={inputClass} value={range.end || s?.end_date || ''} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
        </label>
        <Button variant="outline" size="sm" data-testid="admin-overview-reset" onClick={() => setRange({ start: '', end: '' })}>
          <RotateCcw aria-hidden /> {t('overview.reset')}
        </Button>
      </header>
      {q.isPending ? (
        <div className="h-32 animate-pulse rounded-lg bg-muted" />
      ) : q.isError && !s ? (
        <div data-testid="admin-overview-error" className="flex items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
          {t('common.error')}
          <button type="button" className="underline" onClick={() => void q.refetch()}>
            {t('common.retry')}
          </button>
        </div>
      ) : s ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card id="new-companies" label={t('overview.newCompanies')} value={n(s.new_companies)} />
            <Card id="new-users" label={t('overview.newUsers')} value={n(s.new_users)} />
            <Card id="messages" label={t('overview.messages')} value={n(s.messages.total)} sub={t('overview.inOut', { inbound: n(s.messages.inbound), outbound: n(s.messages.outbound) })} />
            <Card
              id="connections"
              label={t('overview.connections')}
              value={`${n(s.totals.connected_connections)} / ${n(s.totals.connections)}`}
              sub={t('overview.connected')}
            />
            <Card id="companies" label={t('overview.companies')} value={n(s.totals.companies)} sub={t('overview.activeCompanies', { count: n(s.totals.active_companies) })} />
            <Card id="users" label={t('overview.users')} value={n(s.totals.users)} />
          </div>
          <section className="rounded-xl border bg-card p-4">
            <h3 className="mb-3 text-sm font-medium">{t('overview.perDay')}</h3>
            <ol data-testid="admin-overview-chart" className="flex flex-col gap-1">
              {s.messages_per_day.map((d) => (
                <li key={d.date} className="grid grid-cols-[6rem_minmax(0,1fr)_4rem] items-center gap-2 text-xs">
                  <span className="text-muted-foreground tabular-nums">{d.date}</span>
                  <span className="h-2 rounded bg-muted">
                    <span className="block h-2 rounded bg-primary" style={{ width: `${(d.total / max) * 100}%` }} />
                  </span>
                  <span className="text-right tabular-nums">{n(d.total)}</span>
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : null}
    </div>
  )
}
