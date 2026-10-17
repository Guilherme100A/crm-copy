// Abas de infraestrutura (20 §3.14, §5 item 11; AC-T100-04): Saúde (`checked_at` do servidor) e Sessões WhatsApp
// (hora da última leitura). Somente leitura, com Atualizar. No modo extensão a aba Sessões nem aparece (404).
import { useQuery } from '@tanstack/react-query'
import { useI18n, useT } from '@/i18n'
import { adminHealthQuery, adminWaSessionsQuery } from './api'
import { fmtDateTime, fmtNumber, NS, ReadOnlyHeader, StatusBadge } from './ui'

function ErrorBox({ prefix, onRetry }: { prefix: string; onRetry: () => void }) {
  const t = useT(NS)
  return (
    <div data-testid={`admin-${prefix}-error`} className="flex items-center gap-3 rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
      {t('common.error')}
      <button type="button" className="underline" onClick={onRetry}>
        {t('common.retry')}
      </button>
    </div>
  )
}

const Skeleton = () => <div className="h-32 animate-pulse rounded-lg bg-muted" />

export function HealthTab() {
  const t = useT(NS)
  const { locale } = useI18n()
  const q = useQuery(adminHealthQuery())
  const h = q.data
  const block = (id: string, label: string, status: 'ok' | 'down', lines: [string, string][], error?: string) => (
    <div key={id} data-testid={`admin-health-${id}`} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{label}</h3>
        <StatusBadge ok={status === 'ok'} testId={`admin-health-${id}-status`} label={t(`health.status.${status}`)} />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {lines.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 truncate tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
  return (
    <div data-testid="admin-panel-health" className="flex flex-col gap-4">
      <ReadOnlyHeader
        prefix="health"
        title={t('tabs.health')}
        subtitle={t('health.subtitle')}
        updatedAt={h?.checked_at}
        refreshing={q.isFetching}
        onRefresh={() => void q.refetch()}
      >
        {h ? <StatusBadge ok={h.status === 'ok'} testId="admin-health-overall" label={t(`health.overall.${h.status}`)} /> : null}
      </ReadOnlyHeader>
      {q.isPending ? (
        <Skeleton />
      ) : q.isError && !h ? (
        <ErrorBox prefix="health" onRetry={() => void q.refetch()} />
      ) : h ? (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            {block('postgres', 'PostgreSQL', h.postgres.status, [
              [t('health.connections'), `${fmtNumber(h.postgres.connections, locale)} / ${fmtNumber(h.postgres.max_connections, locale)}`],
              [t('health.dbSize'), h.postgres.database_size_bytes === null ? '—' : `${(h.postgres.database_size_bytes / 1024 / 1024).toFixed(1)} MB`],
            ], h.postgres.error)}
            {block('redis', 'Redis', h.redis.status, [[t('health.memory'), h.redis.used_memory_human ?? '—']], h.redis.error)}
            {block('wa-events', t('health.waEvents'), h.wa_events.status, [
              [t('health.stream'), h.wa_events.stream],
              [t('health.lag'), fmtNumber(h.wa_events.lag, locale)],
              [t('health.pending'), fmtNumber(h.wa_events.pending, locale)],
              [t('health.consumers'), fmtNumber(h.wa_events.consumers, locale)],
            ], h.wa_events.error)}
          </div>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table data-testid="admin-health-queues" className="w-full text-sm">
              <caption className="px-3 py-2 text-left text-sm font-medium">
                {t('health.queues', { prefix: h.queue_prefix })}
              </caption>
              <thead className="border-y bg-muted/40 text-left text-xs text-muted-foreground uppercase">
                <tr>
                  {['queue', 'status', 'waiting', 'active', 'delayed', 'failed'].map((c) => (
                    <th key={c} scope="col" className="px-3 py-2 font-medium">
                      {t(`health.col.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {h.queues.map((x) => (
                  <tr key={x.name} data-testid={`admin-health-queue-${x.name}`}>
                    <td className="px-3 py-2 font-mono text-xs">{x.name}</td>
                    <td className="px-3 py-2">
                      <StatusBadge ok={x.status === 'ok'} label={x.is_paused ? t('health.paused') : t(`health.status.${x.status}`)} />
                    </td>
                    <td className="px-3 py-2 tabular-nums">{fmtNumber(x.waiting, locale)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtNumber(x.active, locale)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtNumber(x.delayed, locale)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtNumber(x.failed, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  )
}

export function SessionsTab() {
  const t = useT(NS)
  const { locale } = useI18n()
  const q = useQuery(adminWaSessionsQuery())
  const items = q.data?.items ?? []
  return (
    <div data-testid="admin-panel-sessions" className="flex flex-col gap-4">
      <ReadOnlyHeader
        prefix="sessions"
        title={t('tabs.sessions')}
        subtitle={t('sessions.subtitle')}
        updatedAt={q.dataUpdatedAt || null}
        refreshing={q.isFetching}
        onRefresh={() => void q.refetch()}
      />
      {q.isPending ? (
        <Skeleton />
      ) : q.isError && !q.data ? (
        <ErrorBox prefix="sessions" onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <p data-testid="admin-sessions-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('sessions.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table data-testid="admin-sessions-table" className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground uppercase">
              <tr>
                {['name', 'phone', 'state', 'company', 'connection', 'lastConnected'].map((c) => (
                  <th key={c} scope="col" className="px-3 py-2 font-medium">
                    {t(`sessions.col.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((s) => (
                <tr key={s.id} data-testid={`admin-sessions-item-${s.id}`}>
                  <td className="px-3 py-2">{s.name}</td>
                  <td className="px-3 py-2 tabular-nums">{s.phone ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs" data-testid={`admin-sessions-item-state-${s.id}`}>
                    {s.state}
                  </td>
                  <td className="px-3 py-2">{s.company?.name ?? <span className="text-muted-foreground">{t('sessions.orphan')}</span>}</td>
                  <td className="px-3 py-2">{s.connection?.name ?? '—'}</td>
                  <td className="px-3 py-2">{fmtDateTime(s.last_connected_at, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
