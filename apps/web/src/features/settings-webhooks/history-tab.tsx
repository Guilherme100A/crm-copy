// Aba Histórico (09 §2; T72/T81): estatísticas dos requests guardados, filtro por status (local, sobre o carregado)
// e cada request com status, motivo, etapas do processamento e o JSON formatado do corpo.
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useI18n, useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { REQUEST_STATUSES, WEBHOOKS_KEY, webhookKey, webhooksApi, type RequestStatus, type WebhookDto, type WebhookRequestDto } from './api'
import { prettyBody } from './mapping'

const STATUS_CLASS: Record<RequestStatus, string> = {
  processed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  failed: 'bg-destructive/15 text-destructive',
  pending: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  skipped: 'bg-muted text-muted-foreground',
}

export const filterRequests = (items: readonly WebhookRequestDto[], status: RequestStatus | '') => (status ? items.filter((r) => r.processing_status === status) : [...items])

export function HistoryTab({ webhook }: { webhook: WebhookDto }) {
  const t = useT('settings-webhooks')
  const qc = useQueryClient()
  const [status, setStatus] = useState<RequestStatus | ''>('')
  const q = useInfiniteQuery({
    queryKey: [...WEBHOOKS_KEY, 'requests', webhook.id] as const,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => webhooksApi.requests(webhook.id, pageParam),
    getNextPageParam: (last) => (last.page.has_more ? last.page.page + 1 : undefined),
  })
  const all = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data])
  const items = useMemo(() => filterRequests(all, status), [all, status])
  const s = webhook.request_stats

  const refresh = () => {
    void q.refetch()
    void qc.invalidateQueries({ queryKey: webhookKey(webhook.id) })
  }

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {(['total', 'processed', 'failed', 'pending', 'skipped'] as const).map((k) => (
          <div key={k} className="rounded-xl border bg-card p-3">
            <dt className="text-xs text-muted-foreground">{t(`history.stats.${k}`)}</dt>
            <dd data-testid={`webhook-stats-${k}`} className="text-lg font-semibold tabular-nums">
              {s[k]}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          {t('history.filter')}
          <select data-testid="webhook-history-filter" value={status} onChange={(e) => setStatus(e.target.value as RequestStatus | '')} className="h-9 rounded-md border bg-background px-2.5 text-sm">
            <option value="">{t('history.all')}</option>
            {REQUEST_STATUSES.map((st) => (
              <option key={st} value={st}>
                {t(`history.status.${st}`)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted-foreground">{t('history.retention', { n: s.retention_max })}</span>
        <Button variant="outline" size="sm" className="ml-auto" data-testid="webhook-history-refresh" onClick={refresh} disabled={q.isFetching}>
          <RefreshCw className={cn(q.isFetching && 'animate-spin')} aria-hidden /> {t('history.refresh')}
        </Button>
      </div>
      {q.isPending ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p data-testid="webhook-history-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('history.empty')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {items.map((r) => (
            <RequestRow key={r.id} req={r} />
          ))}
        </ul>
      )}
      {q.hasNextPage ? (
        <Button variant="ghost" size="sm" data-testid="webhook-history-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {t('history.more')}
        </Button>
      ) : null}
    </div>
  )
}

function RequestRow({ req }: { req: WebhookRequestDto }) {
  const t = useT('settings-webhooks')
  const { locale } = useI18n()
  const [open, setOpen] = useState(false)
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(req.created_at))
  const reason = req.reason ?? req.error
  return (
    <li data-testid={`webhook-request-${req.id}`} data-status={req.processing_status} className="flex flex-col gap-2 p-3">
      <button
        type="button"
        data-testid={`webhook-request-toggle-${req.id}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 flex-wrap items-center gap-2 text-left"
      >
        {open ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
        <span data-testid={`webhook-request-status-${req.id}`} className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_CLASS[req.processing_status])}>
          {t(`history.status.${req.processing_status}`)}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{when}</span>
        {reason ? (
          <span data-testid={`webhook-request-reason-${req.id}`} className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {reason}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-2 pl-6">
          {req.steps.length ? (
            <ul data-testid={`webhook-request-steps-${req.id}`} className="flex flex-col gap-0.5 text-xs">
              {req.steps.map((st, i) => (
                <li key={i} className="flex flex-wrap gap-1 font-mono">
                  <span>{st.step}</span>·<span className={cn(st.status === 'failed' && 'text-destructive', st.status === 'ok' && 'text-emerald-600 dark:text-emerald-400')}>{st.status}</span>
                  {st.reason ? <span className="text-muted-foreground">· {st.reason}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <pre data-testid={`webhook-request-body-${req.id}`} className="max-h-72 overflow-auto rounded-lg border bg-muted/30 p-2 font-mono text-xs break-all whitespace-pre-wrap">
            {prettyBody(req.raw_body)}
          </pre>
          {req.raw_body_truncated ? <p className="text-[11px] text-muted-foreground">{t('history.truncated')}</p> : null}
        </div>
      ) : null}
    </li>
  )
}
