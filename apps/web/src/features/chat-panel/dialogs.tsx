// Diálogos do painel (T91): confirmação de ações destrutivas, disparar fluxo e agendar mensagem/fluxo (T64).
import { Dialog } from '@base-ui/react/dialog'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { composerApi, quickRepliesQuery } from '@/features/chat-composer/api'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import { isoToLocal, localToIso, scheduleWindowProblem, triggerableFlowsQuery, SCHEDULE_MAX_DAYS, type ScheduleDto, type ScheduleInput } from './api'

const popupClass = 'fixed top-1/2 left-1/2 z-[70] flex max-h-[90dvh] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none'
const field = 'h-9 w-full rounded-md border bg-background px-3 text-sm'

function Shell({ open, onOpenChange, testId, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; testId: string; title: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid={testId} className={popupClass}>
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export interface ConfirmRequest {
  title: string
  body: string
  action: string
  run: () => Promise<void>
}

/** Confirmação única do painel (parar fluxo, cancelar agendamento, remover etiqueta, desligar agente). */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const t = useT('chat-panel')
  const [pending, setPending] = useState(false)
  return (
    <Shell open={!!request} onOpenChange={(o) => !o && onClose()} testId="chat-panel-confirm" title={request?.title ?? ''}>
      <p className="text-sm text-muted-foreground">{request?.body}</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" data-testid="chat-panel-confirm-cancel" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant="destructive"
          data-testid="chat-panel-confirm-submit"
          disabled={pending}
          onClick={async () => {
            if (!request) return
            setPending(true)
            try {
              await request.run()
            } finally {
              setPending(false)
              onClose()
            }
          }}
        >
          {request?.action}
        </Button>
      </div>
    </Shell>
  )
}

export function TriggerFlowDialog({ open, onOpenChange, onTrigger }: { open: boolean; onOpenChange: (o: boolean) => void; onTrigger: (flowId: string) => Promise<void> }) {
  const t = useT('chat-panel')
  const flows = useQuery({ ...triggerableFlowsQuery(), enabled: open })
  const [flowId, setFlowId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (open) {
      setFlowId('')
      setError(null)
    }
  }, [open])
  const items = flows.data ?? []
  return (
    <Shell open={open} onOpenChange={onOpenChange} testId="chat-panel-trigger-modal" title={t('trigger.title')}>
      {flows.isPending ? (
        <div className="h-9 animate-pulse rounded bg-muted" />
      ) : items.length === 0 ? (
        <p data-testid="chat-panel-trigger-empty" className="text-sm text-muted-foreground">
          {t('trigger.empty')}
        </p>
      ) : (
        <select data-testid="chat-panel-trigger-select" aria-label={t('trigger.flow')} value={flowId} onChange={(e) => setFlowId(e.target.value)} className={field}>
          <option value="">{t('trigger.choose')}</option>
          {items.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
      {error ? (
        <p role="alert" data-testid="chat-panel-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t('cancel')}
        </Button>
        <Button
          data-testid="chat-panel-trigger-submit"
          disabled={!flowId || pending}
          onClick={async () => {
            setPending(true)
            setError(null)
            try {
              await onTrigger(flowId)
              onOpenChange(false)
            } catch (err) {
              setError(err instanceof HttpError && err.message ? err.message : t('errors.action'))
            } finally {
              setPending(false)
            }
          }}
        >
          {t('trigger.submit')}
        </Button>
      </div>
    </Shell>
  )
}

const RECURRENCES: ScheduleDto['recurrence'][] = ['one_off', 'daily', 'weekly', 'monthly']

export function ScheduleDialog({
  open,
  onOpenChange,
  contactId,
  onCreate,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  contactId: string | null
  onCreate: (input: ScheduleInput) => Promise<void>
}) {
  const t = useT('chat-panel')
  const [kind, setKind] = useState<'message' | 'flow'>('message')
  const [text, setText] = useState('')
  const [quickReplyId, setQuickReplyId] = useState('')
  const [flowId, setFlowId] = useState('')
  const [runAt, setRunAt] = useState('')
  const [recurrence, setRecurrence] = useState<ScheduleDto['recurrence']>('one_off')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const flows = useQuery({ ...triggerableFlowsQuery(), enabled: open && kind === 'flow' })
  const quick = useQuery({ ...quickRepliesQuery(''), enabled: open && kind === 'message' })
  const quickItems = Array.isArray(quick.data) ? quick.data : []

  useEffect(() => {
    if (!open) return
    setKind('message')
    setText('')
    setQuickReplyId('')
    setFlowId('')
    setRunAt(isoToLocal(new Date(Date.now() + 60 * 60_000)))
    setRecurrence('one_off')
    setError(null)
  }, [open])

  const pickQuick = async (id: string) => {
    setQuickReplyId(id)
    if (!id) return
    try {
      setText((await composerApi.renderQuickReply(id, contactId)).text)
    } catch {
      setError(t('errors.action'))
    }
  }

  const submit = async () => {
    const iso = localToIso(runAt)
    if (!iso) return setError(t('schedule.errors.date'))
    const p = scheduleWindowProblem(iso)
    if (p) return setError(t(`schedule.errors.${p}`, { days: SCHEDULE_MAX_DAYS }))
    if (kind === 'message' && !text.trim()) return setError(t('schedule.errors.text'))
    if (kind === 'flow' && !flowId) return setError(t('schedule.errors.flow'))
    setPending(true)
    setError(null)
    try {
      await onCreate(
        kind === 'message'
          ? { kind, text: text.trim(), quick_reply_id: quickReplyId || null, run_at: iso, recurrence }
          : { kind, flow_id: flowId, run_at: iso, recurrence },
      )
      onOpenChange(false)
    } catch (err) {
      const fieldMsg = err instanceof HttpError ? (err.details as { fields?: { message: string }[] } | undefined)?.fields?.[0]?.message : undefined
      setError(fieldMsg ?? (err instanceof HttpError && err.message ? err.message : t('errors.action')))
    } finally {
      setPending(false)
    }
  }

  const tab = (k: 'message' | 'flow') => (
    <button
      type="button"
      data-testid={`chat-schedule-kind-${k}`}
      aria-pressed={kind === k}
      onClick={() => {
        setKind(k)
        setError(null)
      }}
      className={cn('flex-1 rounded-md px-3 py-1.5 text-sm', kind === k ? 'bg-background shadow-sm' : 'text-muted-foreground')}
    >
      {t(`schedule.kind.${k}`)}
    </button>
  )

  return (
    <Shell open={open} onOpenChange={onOpenChange} testId="chat-schedule-modal" title={t('schedule.title')}>
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {tab('message')}
        {tab('flow')}
      </div>
      {kind === 'message' ? (
        <>
          {quickItems.length ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('schedule.quickReply')}</span>
              <select data-testid="chat-schedule-quick-reply" value={quickReplyId} onChange={(e) => void pickQuick(e.target.value)} className={field}>
                <option value="">{t('schedule.textOnly')}</option>
                {quickItems.map((q) => (
                  <option key={q.id} value={q.id}>
                    /{q.shortcut}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('schedule.text')}</span>
            <textarea data-testid="chat-schedule-text" value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={4096} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </label>
        </>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('schedule.flow')}</span>
          <select data-testid="chat-schedule-flow" value={flowId} onChange={(e) => setFlowId(e.target.value)} className={field}>
            <option value="">{t('trigger.choose')}</option>
            {(flows.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">{t('schedule.flowHint')}</span>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t('schedule.runAt')}</span>
        <input type="datetime-local" data-testid="chat-schedule-run-at" value={runAt} onChange={(e) => setRunAt(e.target.value)} className={field} />
        <span className="text-xs text-muted-foreground">{t('schedule.window', { days: SCHEDULE_MAX_DAYS })}</span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t('schedule.repeat')}</span>
        <select data-testid="chat-schedule-recurrence" value={recurrence} onChange={(e) => setRecurrence(e.target.value as ScheduleDto['recurrence'])} className={field}>
          {RECURRENCES.map((r) => (
            <option key={r} value={r}>
              {t(`schedule.recurrence.${r}`)}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert" data-testid="chat-schedule-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 border-t pt-3">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t('close')}
        </Button>
        <Button data-testid="chat-schedule-submit" disabled={pending} onClick={() => void submit()}>
          {t('schedule.submit')}
        </Button>
      </div>
    </Shell>
  )
}
