// Painel lateral do chat (T91; spec 03 F52–F59, F50–F51): contato, kanban, departamento (transferência),
// responsável ("Atribuir a mim"), agente de IA, etiquetas, notas, fluxos ativos (parar), disparar fluxo e agendamentos.
// Desktop: coluna lateral da T69. Mobile: botão no cabeçalho que abre o painel num sheet.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, PanelRight, Play, Plus, Square, Tag, UserCheck, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { ChatSlotProps } from '@/features/chat/slots'
import type { ChatListItem } from '@/features/chat-list/api'
import { useI18n, useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { cn } from '@/lib/utils'
import {
  agentsQuery,
  applyChat,
  boardsQuery,
  contactQuery,
  departmentsQuery,
  filterOptionsQuery,
  flowRunsQuery,
  kanbanLocationQuery,
  notesQuery,
  panelApi,
  panelKey,
  schedulesQuery,
  type ScheduleInput,
} from './api'
import { ConfirmDialog, ScheduleDialog, TriggerFlowDialog, type ConfirmRequest } from './dialogs'

const selectClass = 'h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm disabled:opacity-60'

function Section({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section data-testid={`chat-panel-${id}`} className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function SectionError({ id, onRetry }: { id: string; onRetry: () => void }) {
  const t = useT('chat-panel')
  return (
    <div data-testid={`chat-panel-section-error-${id}`} className="flex items-center gap-2 text-xs text-destructive">
      <span className="flex-1">{t('errors.load')}</span>
      <button type="button" data-testid={`chat-panel-retry-${id}`} onClick={onRetry} className="rounded px-2 py-1 font-medium hover:bg-destructive/10">
        {t('retry')}
      </button>
    </div>
  )
}

function PanelBody({ chatId, chat }: { chatId: string; chat: ChatListItem | undefined }) {
  const t = useT('chat-panel')
  const { locale } = useI18n()
  const qc = useQueryClient()
  const profile = useQuery(profileQuery()).data
  const session = profile ? sessionFrom(profile) : null
  const me = session?.user.id ?? null
  const can = (...keys: string[]) => !!session && hasAny(session, keys)

  const contact = useQuery(contactQuery(chat?.contact_id))
  const options = useQuery(filterOptionsQuery())
  const allDepartments = useQuery(departmentsQuery())
  const agents = useQuery(agentsQuery())
  const boards = useQuery(boardsQuery())
  const location = useQuery(kanbanLocationQuery(chat, boards.data))
  const notes = useQuery(notesQuery(chatId))
  const runs = useQuery(flowRunsQuery(chatId))
  const schedules = useQuery(schedulesQuery(chatId))

  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [triggerOpen, setTriggerOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  /** Roda a ação; erro vai para `chat-panel-error` (padrão da T85). */
  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof HttpError && err.message ? err.message : t('errors.action'))
    } finally {
      setBusy(false)
    }
  }
  const withChat = (fn: () => Promise<{ chat: ChatListItem }>) => act(async () => applyChat(qc, (await fn()).chat))

  if (!chat) return <div data-testid="chat-panel-loading" className="flex flex-col gap-3 p-4">{[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />)}</div>

  const departments = allDepartments.data ?? options.data?.departments ?? []
  const users = options.data?.users ?? []
  const labelsById = new Map((options.data?.labels ?? []).map((l) => [l.id, l]))
  const chatLabels = chat.label_ids.map((id) => labelsById.get(id) ?? { id, name: id.slice(0, 8), color: null })
  const freeLabels = (options.data?.labels ?? []).filter((l) => !chat.label_ids.includes(l.id))
  const canKanban = can('kanban.edit')
  const canRun = can('flows.run')
  const canAssignOthers = can('chat.assign_others')
  const board = boards.data?.find((b) => b.id === location.data?.crmId)
  const fmt = (iso: string) => new Date(iso).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  const setKanban = (crmId: string, columnId: string | null) =>
    withChat(async () => {
      const r = await panelApi.patchChat(chatId, crmId ? { crm_id: crmId, crm_column_id: columnId } : { crm_id: location.data?.crmId ?? '', crm_column_id: null })
      void qc.invalidateQueries({ queryKey: panelKey(chatId, 'kanban') })
      return r
    })

  const refreshSchedules = () => qc.invalidateQueries({ queryKey: panelKey(chatId, 'schedules') })

  return (
    <div data-testid="chat-panel" className="flex min-w-0 flex-col">
      {error ? (
        <p data-testid="chat-panel-error" role="alert" className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <Section id="contact" title={t('contact.title')}>
        <div className="min-w-0">
          <p data-testid="chat-panel-contact-name" className="truncate text-sm font-semibold">
            {contact.data?.name || chat.contact.name || chat.contact.phone_e164 || '—'}
          </p>
          <p data-testid="chat-panel-contact-phone" className="truncate text-xs text-muted-foreground">
            {chat.contact.phone_e164 ?? chat.contact.wa_lid ?? ''}
          </p>
          {contact.data?.email ? <p className="truncate text-xs text-muted-foreground">{contact.data.email}</p> : null}
        </div>
        {contact.data?.labels?.length ? (
          <div className="flex flex-wrap gap-1">
            {contact.data.labels.map((l) => (
              <span key={l.id} className="rounded-full border px-2 py-0.5 text-[11px]">
                {l.name}
              </span>
            ))}
          </div>
        ) : null}
      </Section>

      {boards.data !== null ? (
        <Section id="kanban" title={t('kanban.title')}>
          {boards.isError ? (
            <SectionError id="kanban" onRetry={() => void boards.refetch()} />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <select
                data-testid="chat-panel-crm"
                aria-label={t('kanban.board')}
                disabled={!canKanban || busy || location.isPending}
                value={location.data?.crmId ?? ''}
                onChange={(e) => {
                  const b = boards.data?.find((x) => x.id === e.target.value)
                  void setKanban(e.target.value, b?.columns[0]?.id ?? null)
                }}
                className={selectClass}
              >
                <option value="">{t('kanban.none')}</option>
                {(boards.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <select
                data-testid="chat-panel-crm-column"
                aria-label={t('kanban.column')}
                disabled={!canKanban || busy || !board}
                value={location.data?.columnId ?? ''}
                onChange={(e) => void setKanban(board!.id, e.target.value)}
                className={selectClass}
              >
                {board ? null : <option value="">—</option>}
                {(board?.columns ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </Section>
      ) : null}

      <Section id="department-section" title={t('department.title')}>
        <select
          data-testid="chat-panel-department"
          aria-label={t('department.title')}
          disabled={busy}
          value={chat.department_id ?? ''}
          onChange={(e) => void withChat(() => panelApi.patchChat(chatId, { department_id: e.target.value || null }))}
          className={selectClass}
        >
          <option value="">{t('department.none')}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          {chat.department_id && !departments.some((d) => d.id === chat.department_id) ? <option value={chat.department_id}>{t('department.other')}</option> : null}
        </select>
        <p className="text-xs text-muted-foreground">{t('department.hint')}</p>
      </Section>

      <Section
        id="assignee-section"
        title={t('assignee.title')}
        action={
          me && chat.assigned_user_id !== me ? (
            <button type="button" data-testid="chat-panel-assign-me" disabled={busy} onClick={() => void withChat(() => panelApi.assign(chatId, me))} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/10">
              <UserCheck className="size-3.5" aria-hidden /> {t('assignee.me')}
            </button>
          ) : null
        }
      >
        <select
          data-testid="chat-panel-assignee"
          aria-label={t('assignee.title')}
          disabled={busy || !canAssignOthers}
          value={chat.assigned_user_id ?? ''}
          onChange={(e) => void withChat(() => (e.target.value ? panelApi.assign(chatId, e.target.value) : panelApi.unassign(chatId)))}
          className={selectClass}
        >
          <option value="">{t('assignee.none')}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
          {chat.assigned_user && !users.some((u) => u.id === chat.assigned_user!.id) ? <option value={chat.assigned_user.id}>{chat.assigned_user.name}</option> : null}
        </select>
      </Section>

      {agents.data !== null ? (
        <Section id="ai-agent-section" title={t('agent.title')}>
          <select
            data-testid="chat-panel-ai-agent"
            aria-label={t('agent.title')}
            disabled={busy}
            value={chat.ai_agent_id ?? ''}
            onChange={(e) => {
              const value = e.target.value || null
              if (!value && chat.ai_agent_id)
                setConfirm({ title: t('agent.offTitle'), body: t('agent.offBody'), action: t('agent.off'), run: () => withChat(() => panelApi.patchChat(chatId, { ai_agent_id: null })) })
              else void withChat(() => panelApi.patchChat(chatId, { ai_agent_id: value }))
            }}
            className={selectClass}
          >
            <option value="">{t('agent.none')}</option>
            {(agents.data ?? [])
              .filter((a) => a.status === 'active' || a.id === chat.ai_agent_id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Section>
      ) : null}

      <Section id="labels" title={t('labels.title')}>
        <div className="flex flex-wrap gap-1">
          {chatLabels.length === 0 ? <p className="text-xs text-muted-foreground">{t('labels.empty')}</p> : null}
          {chatLabels.map((l) => (
            <span key={l.id} data-testid={`chat-panel-label-${l.id}`} className="flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2 text-xs" style={l.color ? { borderColor: l.color } : undefined}>
              <Tag className="size-3" aria-hidden style={l.color ? { color: l.color } : undefined} />
              {l.name}
              <button
                type="button"
                data-testid={`chat-panel-label-remove-${l.id}`}
                aria-label={t('labels.remove', { name: l.name })}
                onClick={() => setConfirm({ title: t('labels.removeTitle'), body: t('labels.removeBody', { name: l.name }), action: t('labels.removeAction'), run: () => withChat(() => panelApi.removeLabel(chatId, l.id)) })}
                className="rounded-full p-0.5 hover:bg-accent"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
        {freeLabels.length ? (
          <select
            data-testid="chat-panel-label-add"
            aria-label={t('labels.add')}
            disabled={busy}
            value=""
            onChange={(e) => e.target.value && void withChat(() => panelApi.addLabel(chatId, e.target.value))}
            className={selectClass}
          >
            <option value="">{t('labels.add')}</option>
            {freeLabels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        ) : null}
      </Section>

      {runs.data !== null ? (
        <Section
          id="flow-runs"
          title={t('flows.title')}
          action={
            canRun ? (
              <button type="button" data-testid="chat-panel-trigger-flow" onClick={() => setTriggerOpen(true)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/10">
                <Play className="size-3.5" aria-hidden /> {t('flows.trigger')}
              </button>
            ) : null
          }
        >
          {runs.isError ? (
            <SectionError id="flow-runs" onRetry={() => void runs.refetch()} />
          ) : (runs.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('flows.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {(runs.data ?? []).map((r) => (
                <li key={r.id} data-testid={`chat-panel-flow-run-${r.id}`} data-status={r.status} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.flow_name ?? t('flows.unnamed')}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t(`flows.status.${r.status}`)} · {fmt(r.started_at)}
                    </span>
                  </span>
                  {canRun ? (
                    <button
                      type="button"
                      data-testid={`chat-panel-flow-run-stop-${r.id}`}
                      aria-label={t('flows.stop')}
                      onClick={() =>
                        setConfirm({
                          title: t('flows.stopTitle'),
                          body: t('flows.stopBody', { name: r.flow_name ?? '' }),
                          action: t('flows.stop'),
                          run: () =>
                            act(async () => {
                              await panelApi.cancelRun(r.id)
                              await qc.invalidateQueries({ queryKey: panelKey(chatId, 'flow-runs') })
                            }),
                        })
                      }
                      className="rounded-md p-1.5 text-destructive hover:bg-destructive/10"
                    >
                      <Square className="size-4" aria-hidden />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      <Section
        id="schedules"
        title={t('schedule.section')}
        action={
          <button type="button" data-testid="chat-panel-schedule-new" onClick={() => setScheduleOpen(true)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/10">
            <CalendarClock className="size-3.5" aria-hidden /> {t('schedule.new')}
          </button>
        }
      >
        {schedules.isError ? (
          <SectionError id="schedules" onRetry={() => void schedules.refetch()} />
        ) : (schedules.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('schedule.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label={t('schedule.pending')}>
            {(schedules.data ?? []).map((s) => (
              <li key={s.id} data-testid={`chat-schedule-${s.id}`} data-status={s.status} data-recurrence={s.recurrence} className="flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{s.kind === 'message' ? s.text : t('schedule.kind.flow')}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {fmt(s.run_at)} · {t(`schedule.recurrence.${s.recurrence}`)}
                  </span>
                </span>
                <button
                  type="button"
                  data-testid={`chat-schedule-cancel-${s.id}`}
                  aria-label={t('schedule.cancel')}
                  onClick={() =>
                    setConfirm({
                      title: t('schedule.cancelTitle'),
                      body: t('schedule.cancelBody'),
                      action: t('schedule.cancel'),
                      run: () =>
                        act(async () => {
                          await panelApi.cancelSchedule(s.id)
                          await refreshSchedules()
                        }),
                    })
                  }
                  className="rounded-md p-1 text-destructive hover:bg-destructive/10"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="notes" title={t('notes.title')}>
        <div className="flex gap-2">
          <textarea
            data-testid="chat-panel-note-input"
            aria-label={t('notes.placeholder')}
            placeholder={t('notes.placeholder')}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="min-w-0 flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-sm"
          />
          <Button
            size="icon"
            data-testid="chat-panel-note-submit"
            aria-label={t('notes.add')}
            disabled={busy || !note.trim()}
            onClick={() =>
              void act(async () => {
                await panelApi.addNote(chatId, note.trim())
                setNote('')
                await qc.invalidateQueries({ queryKey: panelKey(chatId, 'notes') })
                await qc.invalidateQueries({ queryKey: ['chat-thread', chatId, 'notes'] })
              })
            }
          >
            <Plus aria-hidden />
          </Button>
        </div>
        {notes.isError ? (
          <SectionError id="notes" onRetry={() => void notes.refetch()} />
        ) : (notes.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('notes.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {(notes.data ?? []).map((n) => (
              <li key={n.id} data-testid={`chat-panel-note-${n.id}`} className="rounded-md border border-dashed border-amber-300 bg-amber-50 px-2 py-1.5 text-xs dark:border-amber-800 dark:bg-amber-950/30">
                <p className="break-words whitespace-pre-wrap">{n.body}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {n.author?.name ?? '—'} · {fmt(n.created_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <TriggerFlowDialog
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        onTrigger={async (flowId) => {
          await panelApi.trigger(flowId, chatId)
          await qc.invalidateQueries({ queryKey: panelKey(chatId, 'flow-runs') })
        }}
      />
      <ScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        contactId={chat.contact_id}
        onCreate={async (input: ScheduleInput) => {
          await panelApi.createSchedule(chatId, input)
          await refreshSchedules()
        }}
      />
    </div>
  )
}

export function ChatPanel({ chatId, chat, isDesktop }: ChatSlotProps) {
  const t = useT('chat-panel')
  const [open, setOpen] = useState(false)
  if (isDesktop) return <PanelBody chatId={chatId} chat={chat} />
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger data-testid="chat-panel-open" aria-label={t('open')} className="rounded-md p-2 hover:bg-accent">
        <PanelRight className="size-5" aria-hidden />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-black/40" />
        <Dialog.Popup data-testid="chat-panel-sheet" className={cn('fixed inset-x-0 bottom-0 z-[60] flex max-h-[88dvh] flex-col rounded-t-2xl border-t bg-background shadow-xl outline-none')}>
          <div className="flex items-center justify-between border-b px-4 py-2">
            <Dialog.Title className="text-sm font-semibold">{t('title')}</Dialog.Title>
            <Dialog.Close data-testid="chat-panel-close" aria-label={t('close')} className="rounded-md p-2 hover:bg-accent">
              <X className="size-5" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            <PanelBody chatId={chatId} chat={chat} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
