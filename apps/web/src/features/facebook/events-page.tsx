// "Eventos enviados" (revisão 3; docs/integrations/meta-capi.md): diagnóstico por pixel do `capi_event_log` — status
// (aceito pela CAPI com events_received, rejeitado com motivo/fbtrace_id, incerto em retentativa, descartado e motivo),
// modo usado (business_messaging/chat/system_generated), NOMES dos identificadores enviados (nunca os valores) e a
// pontuação estimada de correspondência. Filtros e paginação. "Aceito pela CAPI" não quer dizer "atribuído pela Meta".
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { DataList, Pager, type Column } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { fetchPixelEvents, fetchPixels, pixelEventsKey, pixelsKey, type CapiEventFilters, type CapiEventLogItem } from './api'
import { NS, selectClass, useFacebookSession } from './layout'

const P = 'facebook-events'
export const EVENT_STATUSES = ['sent', 'failed', 'uncertain', 'discarded', 'pending'] as const
export const EVENT_MODES = ['business_messaging', 'chat', 'system_generated'] as const
export const EVENT_NAMES = ['Purchase', 'Lead', 'InitiateCheckout', 'AddToCart', 'CompleteRegistration', 'Contact', 'Schedule', 'Subscribe'] as const
export const EVENT_SOURCES = ['flow', 'sale', 'ad_lead', 'manual'] as const

export interface EventsSearch {
  ev_pixel?: string | undefined
  ev_page?: number | undefined
  ev_status?: string | undefined
  ev_mode?: string | undefined
  ev_event?: string | undefined
  ev_source?: string | undefined
}

const STATUS_CLASS: Record<string, string> = {
  sent: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-destructive/15 text-destructive',
  uncertain: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  discarded: 'bg-muted text-muted-foreground',
  pending: 'bg-muted text-muted-foreground',
}

export function EventsPage({ search, onSearch }: { search: EventsSearch; onSearch: (s: EventsSearch) => void }) {
  const t = useT(NS)
  const companyId = useFacebookSession()?.company?.id
  const pixels = useQuery({ queryKey: pixelsKey(companyId), queryFn: fetchPixels })
  const pixelId = search.ev_pixel ?? pixels.data?.[0]?.id ?? ''
  const filters: CapiEventFilters = { page: search.ev_page ?? 1, status: search.ev_status, mode: search.ev_mode, event_name: search.ev_event, source: search.ev_source }
  const events = useQuery({ queryKey: pixelEventsKey(pixelId, filters), queryFn: () => fetchPixelEvents(pixelId, filters), enabled: !!pixelId, placeholderData: keepPreviousData })
  const patch = (p: Partial<EventsSearch>) => onSearch({ ...search, ev_pixel: pixelId || undefined, ev_page: undefined, ...p })

  const columns: Column<CapiEventLogItem>[] = [
    {
      id: 'when',
      header: t('events.columns.when'),
      cell: (e) => <span className="whitespace-nowrap text-xs tabular-nums">{new Date(e.created_at).toLocaleString()}</span>,
    },
    {
      id: 'event',
      header: t('events.columns.event'),
      cell: (e) => (
        <span className="text-sm">
          {t(`events.names.${e.event_name}`)}
          {e.sent_event_name !== e.event_name ? <span className="block font-mono text-xs text-muted-foreground">{e.sent_event_name}</span> : null}
          {e.test_event ? <span className="block text-xs text-amber-700 dark:text-amber-300">{t('events.test')}</span> : null}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('events.columns.status'),
      cell: (e) => (
        <span className="flex flex-col gap-1">
          <span data-testid={`${P}-status-${e.id}`} className={cn('inline-flex w-fit rounded-full px-2 py-0.5 text-xs font-medium', STATUS_CLASS[e.status])}>
            {t(`events.status.${e.status}`)}
          </span>
          {e.status === 'sent' && e.events_received !== null ? <span className="text-xs text-muted-foreground">{t('events.received', { n: e.events_received })}</span> : null}
          {e.error ? <span className="max-w-72 text-xs break-words text-muted-foreground">{e.error}</span> : null}
          {e.fbtrace_id ? <code className="text-[11px] text-muted-foreground">fbtrace_id {e.fbtrace_id}</code> : null}
        </span>
      ),
    },
    {
      id: 'mode',
      header: t('events.columns.mode'),
      cell: (e) => (
        <span className="text-xs">
          {t(`events.modes.${e.mode}`)}
          {e.fallback ? <span className="block text-amber-700 dark:text-amber-300">{t('events.fallback')}</span> : null}
        </span>
      ),
    },
    {
      id: 'identifiers',
      header: t('events.columns.identifiers'),
      cell: (e) => (
        <span className="flex max-w-64 flex-wrap gap-1">
          {e.identifiers.map((f) => (
            <code key={f} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
              {f}
            </code>
          ))}
        </span>
      ),
    },
    {
      id: 'score',
      header: t('events.columns.score'),
      cell: (e) =>
        e.match_score === null ? (
          '—'
        ) : (
          <span data-testid={`${P}-score-${e.id}`} className="text-xs whitespace-nowrap">
            {e.match_score}/{e.match_score_max} · {t(`events.levels.${e.match_level ?? 'low'}`)}
          </span>
        ),
    },
    {
      id: 'value',
      header: t('events.columns.value'),
      cell: (e) => (e.value !== null ? <span className="text-xs tabular-nums">{`${e.currency ?? ''} ${e.value.toFixed(2)}`}</span> : '—'),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{t('events.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('events.subtitle')}</p>
      </div>
      <div data-testid={`${P}-notice`} className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{t('events.notice')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
          {t('events.filters.pixel')}
          <select data-testid={`${P}-pixel`} className={selectClass} value={pixelId} onChange={(e) => patch({ ev_pixel: e.target.value })}>
            {(pixels.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <Filter label={t('events.filters.status')} testId={`${P}-filter-status`} value={search.ev_status} options={EVENT_STATUSES.map((v) => [v, t(`events.status.${v}`)])} onChange={(v) => patch({ ev_status: v })} all={t('events.filters.all')} />
        <Filter label={t('events.filters.mode')} testId={`${P}-filter-mode`} value={search.ev_mode} options={EVENT_MODES.map((v) => [v, t(`events.modes.${v}`)])} onChange={(v) => patch({ ev_mode: v })} all={t('events.filters.all')} />
        <Filter label={t('events.filters.event')} testId={`${P}-filter-event`} value={search.ev_event} options={EVENT_NAMES.map((v) => [v, t(`events.names.${v}`)])} onChange={(v) => patch({ ev_event: v })} all={t('events.filters.all')} />
        <Filter label={t('events.filters.source')} testId={`${P}-filter-source`} value={search.ev_source} options={EVENT_SOURCES.map((v) => [v, t(`events.sources.${v}`)])} onChange={(v) => patch({ ev_source: v })} all={t('events.filters.all')} />
      </div>
      {events.data ? (
        <div data-testid={`${P}-summary`} className="flex flex-wrap gap-2 text-xs">
          {EVENT_STATUSES.filter((s) => events.data.summary[s]).map((s) => (
            <span key={s} className={cn('rounded-full px-2 py-0.5 font-medium', STATUS_CLASS[s])}>
              {t(`events.status.${s}`)}: {events.data.summary[s]}
            </span>
          ))}
        </div>
      ) : null}
      {!pixelId && pixels.isSuccess ? (
        <p className="text-sm text-muted-foreground">{t('events.noPixel')}</p>
      ) : (
        <DataList
          prefix={P}
          rows={events.data?.items ?? []}
          rowId={(e) => e.id}
          columns={columns}
          title={(e) => `${t(`events.names.${e.event_name}`)} · ${t(`events.status.${e.status}`)}`}
          canEdit={() => false}
          canDelete={() => false}
          onEdit={() => undefined}
          status={events.isError ? 'error' : events.data ? 'success' : 'pending'}
          empty={t('events.empty')}
        />
      )}
      <Pager prefix={P} meta={events.data?.page} onPage={(page) => onSearch({ ...search, ev_pixel: pixelId || undefined, ev_page: page })} />
    </div>
  )
}

function Filter({ label, testId, value, options, onChange, all }: { label: string; testId: string; value: string | undefined; options: [string, string][]; onChange: (v: string | undefined) => void; all: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
      {label}
      <select data-testid={testId} className={selectClass} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{all}</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}
