// Modais dos disparos (10 §2, AC-T83-04): "Preparando disparo em massa" (fases da preparação, vindas do SSE
// `mass_dispatch.updated` com polling de reserva) e "Ver detalhes" (configuração, agenda, progresso, A/B, alvos e
// Cancelar). Também as peças visuais comuns à lista: selo de status, barra de progresso e formatação.
import { Dialog } from '@base-ui/react/dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Circle, Loader2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { serverMessage } from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  MASS_DISPATCH_KEY,
  PREPARATION_PHASES,
  massDispatchApi,
  massDispatchQuery,
  quotaKey,
  type CreateWarning,
  type MassDispatchDto,
  type MassDispatchStatus,
} from './api'
import { canCancel, phaseStates, preparationDone, shortId, type PhaseState } from './logic'

export const NS = 'mass-dispatch'
export const P = 'mass-dispatch'

const STATUS_TONE: Record<MassDispatchStatus, string> = {
  preparing: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  scheduled: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  running: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  paused: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  completed: 'bg-muted text-foreground',
  cancelled: 'bg-muted text-muted-foreground',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-300',
}

export function useFormat() {
  const { locale } = useI18n()
  const t = useT(NS)
  // 7 de janeiro de 2024 foi um domingo (dia 0).
  const weekday = (d: number) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(2024, 0, 7 + d)).replace('.', '')
  const days = (list: readonly number[]) =>
    list.length === 7 ? t('schedule.everyDay') : list.map((d) => weekday(d)).join(', ')
  return {
    date: (iso: string | null) =>
      iso ? new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '—',
    weekday,
    days,
    name: (d: Pick<MassDispatchDto, 'id' | 'name'>) => d.name || t('unnamed', { id: shortId(d.id) }),
    schedule: (d: Pick<MassDispatchDto, 'weekdays' | 'window_start' | 'window_end'>) =>
      `${days(d.weekdays)} · ${d.window_start}–${d.window_end}`,
  }
}

export function StatusBadge({ d, testId }: { d: Pick<MassDispatchDto, 'status'>; testId: string }) {
  const t = useT(NS)
  return (
    <span
      data-testid={testId}
      data-status={d.status}
      className={cn(
        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_TONE[d.status],
      )}
    >
      {t(`status.${d.status}`)}
    </span>
  )
}

export function ProgressBar({ d, testId }: { d: MassDispatchDto; testId: string }) {
  const t = useT(NS)
  const pct = Math.min(100, Math.max(0, d.progress_percent))
  return (
    <div data-testid={testId} data-percent={pct} className="flex min-w-32 flex-col gap-1">
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t('cols.progress')}
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {t('progress.short', { sent: d.sent_count, total: d.total_count, failed: d.failed_count })}
      </span>
    </div>
  )
}

/** Casca comum dos modais (Base UI Dialog). */
export function Modal({
  testId,
  open,
  title,
  onClose,
  footer,
  wide,
  children,
}: {
  testId: string
  open: boolean
  title: string
  onClose: () => void
  footer?: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  const t = useT(NS)
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid={testId}
          className={cn(
            'fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background shadow-xl outline-none',
            wide ? 'w-[min(44rem,calc(100vw-2rem))]' : 'w-[min(30rem,calc(100vw-2rem))]',
          )}
        >
          <div className="flex items-start gap-3 border-b px-5 py-4">
            <Dialog.Title className="min-w-0 flex-1 text-lg font-semibold break-words">{title}</Dialog.Title>
            <Dialog.Close
              data-testid={`${testId}-x`}
              aria-label={t('common.close')}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent"
            >
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">{footer}</div> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const PHASE_ICON: Record<PhaseState, ReactNode> = {
  done: <Check className="size-4 text-emerald-600" aria-hidden />,
  current: <Loader2 className="size-4 animate-spin text-primary" aria-hidden />,
  pending: <Circle className="size-4 text-muted-foreground" aria-hidden />,
  failed: <AlertTriangle className="size-4 text-destructive" aria-hidden />,
}

/** Lista das fases da preparação com o estado de cada uma. */
export function PhaseList({ d }: { d: MassDispatchDto }) {
  const t = useT(NS)
  const states = phaseStates(d.status, d.preparation_progress)
  const scheduled = Number(d.preparation_progress?.scheduled_count ?? 0)
  const target = Number(d.preparation_progress?.target_count ?? 0)
  return (
    <div className="flex flex-col gap-3">
      <ol data-testid={`${P}-phases`} data-phase={d.preparation_progress?.phase ?? ''} className="flex flex-col gap-2">
        {PREPARATION_PHASES.map((p) => (
          <li
            key={p}
            data-testid={`${P}-phase-${p}`}
            data-state={states[p]}
            aria-current={states[p] === 'current' ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 text-sm',
              states[p] === 'pending' && 'text-muted-foreground',
              states[p] === 'current' && 'font-medium',
            )}
          >
            {PHASE_ICON[states[p]]}
            <span>{t(`phases.${p}`)}</span>
          </li>
        ))}
      </ol>
      {target > 0 ? (
        <p data-testid={`${P}-preparing-count`} className="text-sm text-muted-foreground tabular-nums">
          {t('preparing.count', { scheduled, target })}
        </p>
      ) : null}
      {d.status === 'failed' ? (
        <p
          data-testid={`${P}-preparing-error`}
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {d.preparation_error || t('preparing.failed')}
        </p>
      ) : null}
    </div>
  )
}

export function WarningList({ warnings }: { warnings: readonly CreateWarning[] }) {
  if (!warnings.length) return null
  return (
    <ul className="flex flex-col gap-2">
      {warnings.map((w) => (
        <li
          key={w.code}
          data-testid={`${P}-warning-${w.code}`}
          role="status"
          className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <span>{w.message}</span>
        </li>
      ))}
    </ul>
  )
}

/** "Preparando disparo em massa": fases ao vivo; pode fechar (o progresso continua na lista). */
export function PreparingDialog({
  id,
  warnings,
  onClose,
  onDetails,
}: {
  id: string | null
  warnings: readonly CreateWarning[]
  onClose: () => void
  onDetails: (id: string) => void
}) {
  const t = useT(NS)
  const q = useQuery({
    ...massDispatchQuery(id ?? ''),
    enabled: !!id,
    // Reserva do SSE (10 §5 nº 3): polling enquanto prepara.
    refetchInterval: (query) => {
      const d = query.state.data
      return d && preparationDone(d) ? false : 2_000
    },
  })
  const d = q.data
  const done = !!d && preparationDone(d)
  return (
    <Modal
      testId={`${P}-preparing`}
      open={id !== null}
      title={t('preparing.title')}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" data-testid={`${P}-preparing-close`} onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button data-testid={`${P}-preparing-details`} disabled={!id} onClick={() => id && onDetails(id)}>
            {t('actions.details')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{t('preparing.body')}</p>
      {d ? (
        <>
          <PhaseList d={d} />
          {done && d.status !== 'failed' ? (
            <p
              data-testid={`${P}-preparing-done`}
              role="status"
              className="text-sm font-medium text-emerald-700 dark:text-emerald-300"
            >
              {t('preparing.done', { total: d.total_count })}
            </p>
          ) : null}
        </>
      ) : (
        <div className="h-24 animate-pulse rounded-lg bg-muted/40" aria-busy />
      )}
      <WarningList warnings={warnings} />
    </Modal>
  )
}

function Row({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="min-w-0 break-words">
        {children}
      </dd>
    </>
  )
}

/** "Ver detalhes": configuração, agenda, progresso, distribuição A/B, contagens por alvo e Cancelar. */
export function DetailsDialog({
  id,
  canManage,
  onClose,
}: {
  id: string | null
  canManage: boolean
  onClose: () => void
}) {
  const t = useT(NS)
  const fmt = useFormat()
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const q = useQuery({
    ...massDispatchQuery(id ?? ''),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data && canCancel(query.state.data.status) ? 5_000 : false),
  })
  const cancel = useMutation({
    mutationFn: (dispatchId: string) => massDispatchApi.cancel(dispatchId),
    onSuccess: (r) => {
      qc.setQueryData(massDispatchQuery(r.mass_dispatch.id).queryKey, r.mass_dispatch)
      notify('mass-dispatch-cancelled', t('toast.cancelled'), t('toast.released', { n: r.released_count }))
      setConfirming(false)
    },
    onError: (err) => notify('mass-dispatch-error', t('common.error'), serverMessage(err) ?? undefined),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [...MASS_DISPATCH_KEY, 'list'] })
      void qc.invalidateQueries({ queryKey: quotaKey })
    },
  })
  const d = q.data
  const close = () => {
    setConfirming(false)
    onClose()
  }
  const showCancel = !!d && canManage && canCancel(d.status)
  return (
    <>
      <Modal
        testId={`${P}-details`}
        open={id !== null}
        wide
        title={d ? fmt.name(d) : t('details.title')}
        onClose={close}
        footer={
          <>
            {showCancel ? (
              <Button
                variant="destructive"
                data-testid={`${P}-details-cancel`}
                disabled={cancel.isPending}
                onClick={() => setConfirming(true)}
              >
                {t('actions.cancel')}
              </Button>
            ) : null}
            <Button variant="outline" data-testid={`${P}-details-close`} onClick={close}>
              {t('common.close')}
            </Button>
          </>
        }
      >
        {q.isError ? (
          <p data-testid={`${P}-details-error`} className="text-sm text-destructive">
            {t('common.error')}
          </p>
        ) : !d ? (
          <div className="h-40 animate-pulse rounded-lg bg-muted/40" aria-busy />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge d={d} testId={`${P}-details-status`} />
              <span className="text-xs text-muted-foreground">
                {t('details.createdAt', { date: fmt.date(d.created_at) })}
              </span>
            </div>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('details.progress')}</h3>
              <ProgressBar d={d} testId={`${P}-details-progress`} />
              <p data-testid={`${P}-details-counts`} className="text-sm tabular-nums">
                {t('progress.long', {
                  sent: d.sent_count,
                  total: d.total_count,
                  failed: d.failed_count,
                  pending: d.pending_count,
                  skipped: d.skipped_count,
                })}
              </p>
              <p className="text-xs text-muted-foreground">{t('progress.startedHint')}</p>
            </section>

            {d.status === 'preparing' || d.status === 'failed' ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t('details.preparation')}</h3>
                <PhaseList d={d} />
              </section>
            ) : null}

            <section
              data-testid={`${P}-details-ab`}
              data-ab={d.flow_b_id ? 'on' : 'off'}
              className="flex flex-col gap-2"
            >
              <h3 className="text-sm font-semibold">{t('details.ab')}</h3>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <Row label={t('details.flowA')} testId={`${P}-details-ab-a`}>
                  {[...new Set(d.targets.map((x) => x.flow_name ?? '—'))].join(', ') || '—'}
                </Row>
                <Row label={t('details.flowB')} testId={`${P}-details-ab-b`}>
                  {d.flow_b_id ? (d.flow_b_name ?? '—') : t('details.noAb')}
                </Row>
              </dl>
              {d.flow_b_id ? <p className="text-xs text-muted-foreground">{t('details.abHint')}</p> : null}
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('details.targets')}</h3>
              <ul data-testid={`${P}-details-targets`} className="flex flex-col gap-2">
                {d.targets.map((x) => (
                  <li
                    key={x.id}
                    data-testid={`${P}-details-target-${x.id}`}
                    className="flex flex-col gap-0.5 rounded-lg border p-3 text-sm"
                  >
                    <span className="font-medium break-words">
                      {x.connection_name ?? '—'} → {x.flow_name ?? '—'}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t('details.targetCounts', {
                        assigned: x.assigned_count,
                        sent: x.sent_count,
                        failed: x.failed_count,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('details.config')}</h3>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <Row label={t('details.days')} testId={`${P}-details-days`}>
                  {fmt.days(d.weekdays)}
                </Row>
                <Row label={t('details.window')} testId={`${P}-details-window`}>
                  {`${d.window_start}–${d.window_end} (${d.time_zone})`}
                </Row>
                <Row label={t('details.interval')} testId={`${P}-details-interval`}>
                  {d.interval_min_seconds === d.interval_max_seconds
                    ? t('details.intervalFixed', { s: d.interval_min_seconds })
                    : t('details.intervalRange', { min: d.interval_min_seconds, max: d.interval_max_seconds })}
                </Row>
                <Row label={t('details.dailyLimit')} testId={`${P}-details-daily-limit`}>
                  {d.daily_limit ?? t('details.noDailyLimit')}
                </Row>
                <Row label={t('details.startsAt')} testId={`${P}-details-starts-at`}>
                  {fmt.date(d.starts_scheduling_at)}
                </Row>
                <Row label={t('details.firstSent')}>{fmt.date(d.first_sent_at)}</Row>
                <Row label={t('details.lastSent')}>{fmt.date(d.last_sent_at)}</Row>
                <Row label={t('details.finished')}>{fmt.date(d.finished_at)}</Row>
              </dl>
              <p className="text-xs text-muted-foreground">{t('pace.notice')}</p>
            </section>
          </>
        )}
      </Modal>
      <CancelConfirm
        open={confirming && !!d}
        name={d ? fmt.name(d) : ''}
        pending={cancel.isPending}
        onBack={() => setConfirming(false)}
        onConfirm={() => d && cancel.mutate(d.id)}
      />
    </>
  )
}

export function CancelConfirm({
  open,
  name,
  pending,
  onBack,
  onConfirm,
}: {
  open: boolean
  name: string
  pending: boolean
  onBack: () => void
  onConfirm: () => void
}) {
  const t = useT(NS)
  return (
    <Modal
      testId={`${P}-cancel-confirm`}
      open={open}
      title={t('cancel.title', { name })}
      onClose={onBack}
      footer={
        <>
          <Button variant="outline" data-testid={`${P}-cancel-confirm-back`} onClick={onBack}>
            {t('cancel.back')}
          </Button>
          <Button variant="destructive" data-testid={`${P}-cancel-confirm-ok`} disabled={pending} onClick={onConfirm}>
            {t('cancel.ok')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{t('cancel.body')}</p>
    </Modal>
  )
}
