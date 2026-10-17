// Log de eventos da fonte (AC-T90-03): filtro de status (no servidor, estado local — nada de `?status=`, que é do
// /chats), paginação, detalhe (corpo cru, `SaleEvent`, campos faltando) e reprocessar (202; o evento volta a `pending`
// e é reenfileirado). Sem realtime para esses eventos: enquanto houver `pending` na página (ou
// até 30 s depois de um replay, já que o evento reprocessado sai do filtro enquanto está pendente), refaz a busca a cada 2 s.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useI18n, useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { serverMessage } from '@/features/settings-quick-replies/kit'
import { EVENTS_PAGE_SIZE, SALE_SOURCES_KEY, saleEventsQuery, saleSourcesApi, type InboundSaleEventDto } from './api'
import { INBOUND_EVENT_STATUSES, type InboundEventStatus } from './rules'
import { NS, Section } from './ui'

const P = 'sale-events'
export const EVENTS_POLL_MS = 2_000
export const REPLAY_WATCH_MS = 30_000

/** Intervalo do refetch: com pendentes na página ou dentro da janela após um replay; senão, parado. */
export const pollInterval = (
  items: readonly InboundSaleEventDto[] | undefined,
  watchUntil: number,
  now = Date.now(),
) => ((items && hasPending(items)) || now < watchUntil ? EVENTS_POLL_MS : false)

const STATUS_CLASS: Record<InboundEventStatus, string> = {
  processed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  failed: 'bg-destructive/15 text-destructive',
  pending: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
}

export const eventsPages = (total: number, limit = EVENTS_PAGE_SIZE) =>
  Math.max(1, Math.ceil(total / Math.max(1, limit)))
export const hasPending = (items: readonly InboundSaleEventDto[]) => items.some((e) => e.status === 'pending')

export function EventsLog({ sourceId, canReplay }: { sourceId: string; canReplay: boolean }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [status, setStatus] = useState<InboundEventStatus | ''>('')
  const [watchUntil, setWatchUntil] = useState(0)
  const [page, setPage] = useState(1)
  const q = useQuery({
    ...saleEventsQuery(sourceId, status, page),
    refetchInterval: (query) => pollInterval(query.state.data?.items, watchUntil),
  })
  const items = q.data?.items ?? []
  const pages = eventsPages(q.data?.total ?? 0, q.data?.limit)
  const refresh = () => void qc.invalidateQueries({ queryKey: [...SALE_SOURCES_KEY, 'events', sourceId] })

  return (
    <Section title={t('events.title')} hint={t('events.hint')} testid={`${P}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          {t('events.filter')}
          <select
            data-testid={`${P}-filter`}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as InboundEventStatus | '')
              setPage(1)
            }}
            className="h-9 rounded-md border bg-background px-2.5 text-sm"
          >
            <option value="">{t('events.all')}</option>
            {INBOUND_EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`events.status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <span data-testid={`${P}-total`} className="text-xs text-muted-foreground tabular-nums">
          {t('events.total', { n: q.data?.total ?? 0 })}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          data-testid={`${P}-refresh`}
          onClick={refresh}
          disabled={q.isFetching}
        >
          <RefreshCw className={cn(q.isFetching && 'animate-spin')} aria-hidden />{' '}
          <span className="max-sm:sr-only">{t('events.refresh')}</span>
        </Button>
      </div>
      {q.isPending ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : q.isError ? (
        <p className="text-sm text-destructive">{t('common.error')}</p>
      ) : items.length === 0 ? (
        <p
          data-testid={`${P}-empty`}
          className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
        >
          {status ? t('events.emptyFiltered') : t('events.empty')}
        </p>
      ) : (
        <ul data-testid={`${P}-list`} className="flex min-w-0 flex-col divide-y rounded-lg border">
          {items.map((ev) => (
            <EventRow
              key={ev.id}
              ev={ev}
              canReplay={canReplay}
              sourceId={sourceId}
              onReplayed={() => {
                setWatchUntil(Date.now() + REPLAY_WATCH_MS)
                refresh()
              }}
            />
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <nav className="flex items-center justify-end gap-2 text-sm">
          <Button
            variant="outline"
            size="sm"
            data-testid={`${P}-prev`}
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            aria-label={t('events.prev')}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <span data-testid={`${P}-page`} className="text-muted-foreground tabular-nums">
            {t('events.pageOf', { page, pages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            data-testid={`${P}-next`}
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
            aria-label={t('events.next')}
          >
            <ChevronRight aria-hidden />
          </Button>
        </nav>
      ) : null}
    </Section>
  )
}

function EventRow({
  ev,
  canReplay,
  sourceId,
  onReplayed,
}: {
  ev: InboundSaleEventDto
  canReplay: boolean
  sourceId: string
  onReplayed: () => void
}) {
  const t = useT(NS)
  const { locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(
    new Date(ev.created_at),
  )
  const replay = async () => {
    setBusy(true)
    try {
      await saleSourcesApi.replay(sourceId, ev.id)
      notify('sale-events-replayed', t('events.replayed'))
      onReplayed()
    } catch (err) {
      notify('sale-events-error', serverMessage(err) ?? t('common.error'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <li data-testid={`${P}-item-${ev.id}`} data-status={ev.status} className="flex min-w-0 flex-col gap-2 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={`${P}-item-toggle-${ev.id}`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="size-4 shrink-0" aria-hidden />
          )}
          <span
            data-testid={`${P}-item-status-${ev.id}`}
            className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_CLASS[ev.status])}
          >
            {t(`events.status.${ev.status}`)}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{when}</span>
          {ev.sale_event?.external_id ? (
            <span className="min-w-0 truncate font-mono text-xs">{ev.sale_event.external_id}</span>
          ) : null}
          {ev.error ? (
            <span
              data-testid={`${P}-item-error-${ev.id}`}
              className="min-w-0 truncate font-mono text-xs text-destructive"
            >
              {ev.error}
            </span>
          ) : null}
        </button>
        {canReplay ? (
          <Button
            variant="outline"
            size="sm"
            data-testid={`${P}-item-replay-${ev.id}`}
            disabled={busy}
            onClick={() => void replay()}
          >
            <RotateCcw aria-hidden /> <span className="max-sm:sr-only">{t('events.replay')}</span>
          </Button>
        ) : null}
      </div>
      {open ? (
        <div data-testid={`${P}-item-detail-${ev.id}`} className="flex min-w-0 flex-col gap-2 text-xs sm:pl-6">
          <p className="text-muted-foreground">{t('events.attempts', { n: ev.attempts })}</p>
          {ev.missing.length ? (
            <ul className="flex flex-col gap-0.5 font-mono break-all">
              {ev.missing.map((m) => (
                <li key={m.field}>{t('sample.missing', { field: m.field, path: m.path || '—' })}</li>
              ))}
            </ul>
          ) : null}
          {ev.sale_event ? (
            <>
              <span className="font-medium">{t('events.saleEvent')}</span>
              <pre className="max-h-60 min-w-0 overflow-auto rounded-lg border bg-muted/30 p-2 font-mono break-all whitespace-pre-wrap">
                {JSON.stringify(ev.sale_event, null, 2)}
              </pre>
            </>
          ) : null}
          <span className="font-medium">{t('events.rawBody')}</span>
          <pre
            data-testid={`${P}-item-body-${ev.id}`}
            className="max-h-60 min-w-0 overflow-auto rounded-lg border bg-muted/30 p-2 font-mono break-all whitespace-pre-wrap"
          >
            {prettyJson(ev.raw_body)}
          </pre>
        </div>
      ) : null}
    </li>
  )
}

export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
