// Assistente de fluxo no editor (T93; 07 §3.9 e §7): botão no cabeçalho + painel de conversa com sessões por fluxo.
// A resposta aparece enquanto o turno roda (`copilot.delta` pelo SSE: ferramentas usadas e o texto). Quando o
// assistente edita, o canvas recarrega pelo `flow.graph_updated` (source 'ai') e o painel avisa "Canvas atualizado".
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Check, Plus, Send, Sparkles, X, AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { copilotApi, copilotKeys, type CopilotMessage, type CopilotSession } from './api'
import { applyCopilotDelta, emptyStreaming, onCopilotStream, type StreamingReply } from './stream'

export interface FlowCopilotProps {
  flowId: string
  /** Salva o rascunho pendente antes de cada pedido (o assistente lê o rascunho do servidor). */
  beforeSend?: () => Promise<unknown>
}

/** Ferramentas com rótulo traduzido (as do servidor; outra aparece pelo nome). */
export const COPILOT_TOOLS = [
  'get_flow',
  'list_block_types',
  'create_node',
  'update_action',
  'connect',
  'disconnect',
  'delete_node',
]

const newClientId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

/** Botão "Assistente" do cabeçalho do editor + painel. */
export function FlowCopilot({ flowId, beforeSend }: FlowCopilotProps) {
  const t = useT('flow-copilot')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid="flow-copilot-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Sparkles aria-hidden /> {t('button')}
      </Button>
      {open ? <CopilotPanel flowId={flowId} beforeSend={beforeSend} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

type PanelError = null | 'send' | 'load' | 'resume_no_balance' | 'action'

function CopilotPanel({ flowId, beforeSend, onClose }: FlowCopilotProps & { onClose: () => void }) {
  const t = useT('flow-copilot')
  const qc = useQueryClient()
  const [showArchived, setShowArchived] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [streaming, setStreaming] = useState<StreamingReply>(emptyStreaming)
  const [error, setError] = useState<PanelError>(null)
  const [busy, setBusy] = useState(false)
  const list = useRef<HTMLOListElement>(null)

  const sessionsQ = useQuery({
    queryKey: copilotKeys.sessions(flowId, showArchived),
    queryFn: () => copilotApi.list(flowId, showArchived),
  })
  const sessions = sessionsQ.data?.items ?? []
  const current: CopilotSession | undefined =
    sessions.find((s) => s.id === selected) ?? (selected ? undefined : sessions[0])
  const sessionId = current?.id ?? null
  const messagesQ = useQuery({
    queryKey: copilotKeys.messages(sessionId ?? '-'),
    queryFn: () => copilotApi.messages(sessionId!),
    enabled: !!sessionId,
  })
  const messages = sessionId ? (messagesQ.data ?? []) : []
  const canEdit = sessionsQ.data?.can_edit ?? false
  const status = current?.status ?? 'active'

  useEffect(() => {
    if (!sessionId) return
    return onCopilotStream(sessionId, (ev) => {
      if (ev.type === 'delta') setStreaming((s) => applyCopilotDelta(s, ev))
    })
  }, [sessionId])

  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, pending, streaming])

  const refresh = async (id?: string | null) => {
    await qc.invalidateQueries({ queryKey: ['flow-copilot', 'sessions', flowId] })
    if (id) await qc.invalidateQueries({ queryKey: copilotKeys.messages(id) })
  }

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const content = draft.trim()
    if (!content || busy) return
    setBusy(true)
    setError(null)
    setPending(content)
    setStreaming(emptyStreaming())
    setDraft('')
    let id = sessionId
    try {
      await beforeSend?.().catch(() => undefined)
      if (!id) {
        const created = await copilotApi.create(flowId)
        id = created.id
        setSelected(id)
        await refresh()
      }
      const turn = await copilotApi.send(id, content, newClientId())
      if (turn.graph_changed) notify('flow-copilot-canvas-updated', t('canvasUpdated'))
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 429)) {
        setError('send')
        setDraft(content)
      }
    } finally {
      await refresh(id)
      setPending(null)
      setStreaming(emptyStreaming())
      setBusy(false)
    }
  }

  const act = async (fn: () => Promise<CopilotSession>) => {
    setError(null)
    setBusy(true)
    try {
      const s = await fn()
      setSelected(s.id)
    } catch (err) {
      setError(err instanceof HttpError && err.status === 429 ? 'resume_no_balance' : 'action')
    } finally {
      await refresh(sessionId)
      setBusy(false)
    }
  }

  const newSession = () =>
    act(async () => {
      setShowArchived(false)
      return copilotApi.create(flowId)
    })

  const state =
    error === 'send'
      ? 'error'
      : busy && pending
        ? 'sending'
        : status === 'paused_quota'
          ? 'paused'
          : status === 'archived'
            ? 'archived'
            : 'idle'
  const inputDisabled = busy || status !== 'active'

  return (
    <aside
      data-testid="flow-copilot"
      data-state={state}
      data-session-id={sessionId ?? ''}
      aria-label={t('title')}
      className="fixed inset-x-0 bottom-0 z-[60] flex h-[85dvh] flex-col rounded-t-xl border bg-background shadow-xl lg:inset-x-auto lg:top-28 lg:right-4 lg:bottom-4 lg:h-auto lg:w-96 lg:rounded-xl"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Sparkles className="size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{t('title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          data-testid="flow-copilot-new"
          title={t('newSession')}
          disabled={busy}
          onClick={() => void newSession()}
        >
          <Plus aria-hidden />
          <span className="sr-only">{t('newSession')}</span>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          data-testid="flow-copilot-close"
          title={t('close')}
          onClick={onClose}
        >
          <X aria-hidden />
          <span className="sr-only">{t('close')}</span>
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <label className="sr-only" htmlFor="flow-copilot-sessions">
          {t('sessions')}
        </label>
        <select
          id="flow-copilot-sessions"
          data-testid="flow-copilot-sessions"
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
          value={sessionId ?? ''}
          disabled={!sessions.length}
          onChange={(e) => setSelected(e.target.value || null)}
        >
          {sessions.length === 0 ? <option value="">{t('noSessions')}</option> : null}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {(s.title || t('untitled')) + (s.status === 'active' ? '' : ` · ${t(`status.${s.status}`)}`)}
            </option>
          ))}
        </select>
        {current && status === 'archived' ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="flow-copilot-reopen"
            disabled={busy}
            onClick={() => void act(() => copilotApi.reopen(current.id))}
          >
            <ArchiveRestore aria-hidden /> {t('reopen')}
          </Button>
        ) : current ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            data-testid="flow-copilot-archive"
            title={t('archive')}
            disabled={busy}
            onClick={() => void act(() => copilotApi.archive(current.id))}
          >
            <Archive aria-hidden />
            <span className="sr-only">{t('archive')}</span>
          </Button>
        ) : null}
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            data-testid="flow-copilot-show-archived"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {t('showArchived')}
        </label>
      </div>

      {sessionsQ.data && !canEdit ? (
        <p data-testid="flow-copilot-readonly" className="border-b bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {t('readOnly')}
        </p>
      ) : null}

      <ol
        ref={list}
        data-testid="flow-copilot-messages"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-muted/30 p-3"
      >
        {sessionsQ.isLoading || messagesQ.isLoading ? (
          <li data-testid="flow-copilot-loading" role="status" className="text-center text-xs text-muted-foreground">
            {t('loading')}
          </li>
        ) : null}
        {sessionsQ.isError || messagesQ.isError ? (
          <li
            data-testid="flow-copilot-load-error"
            role="alert"
            className="flex items-center gap-2 text-sm text-destructive"
          >
            <span className="flex-1">{t('loadError')}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh(sessionId)}>
              {t('retry')}
            </Button>
          </li>
        ) : null}
        {!sessionsQ.isLoading && !messagesQ.isLoading && messages.length === 0 && !pending ? (
          <li data-testid="flow-copilot-empty" className="text-center text-xs text-muted-foreground">
            {canEdit ? t('empty') : t('emptyReadOnly')}
          </li>
        ) : null}
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
        {pending ? (
          <>
            <li
              data-testid="flow-copilot-message"
              data-role="user"
              data-status="sending"
              className="max-w-[85%] self-end rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground"
            >
              {pending}
            </li>
            <li
              data-testid="flow-copilot-streaming"
              role="status"
              className="flex max-w-[85%] flex-col gap-1 self-start rounded-lg border bg-background px-3 py-2 text-sm"
            >
              <ToolList tools={streaming.tools} />
              <span className="whitespace-pre-wrap">{streaming.text || t('thinking')}</span>
            </li>
          </>
        ) : null}
      </ol>

      <footer className="flex flex-col gap-2 border-t p-3">
        {status === 'paused_quota' ? (
          <div
            data-testid="flow-copilot-paused"
            role="alert"
            className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm"
          >
            <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden />
            <span className="flex-1">{t('paused')}</span>
            {current ? (
              <Button
                size="sm"
                data-testid="flow-copilot-resume"
                disabled={busy}
                onClick={() => void act(() => copilotApi.resume(current.id))}
              >
                {t('resume')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {error === 'resume_no_balance' ? (
          <p data-testid="flow-copilot-resume-error" role="alert" className="text-xs text-destructive">
            {t('noBalance')}
          </p>
        ) : null}
        {error === 'send' || error === 'action' ? (
          <p data-testid="flow-copilot-error" role="alert" className="text-xs text-destructive">
            {error === 'send' ? t('sendError') : t('actionError')}
          </p>
        ) : null}
        {status === 'archived' ? <p className="text-xs text-muted-foreground">{t('archivedNotice')}</p> : null}
        <form className="flex items-end gap-2" onSubmit={(e) => void send(e)}>
          <label className="sr-only" htmlFor="flow-copilot-input">
            {t('inputLabel')}
          </label>
          <textarea
            id="flow-copilot-input"
            data-testid="flow-copilot-input"
            rows={2}
            className="min-h-10 min-w-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm"
            placeholder={canEdit ? t('placeholder') : t('placeholderReadOnly')}
            value={draft}
            disabled={inputDisabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            data-testid="flow-copilot-send"
            disabled={inputDisabled || !draft.trim()}
            title={t('send')}
          >
            <Send aria-hidden />
            <span className="sr-only">{t('send')}</span>
          </Button>
        </form>
      </footer>
    </aside>
  )
}

function MessageRow({ message: m }: { message: CopilotMessage }) {
  const t = useT('flow-copilot')
  const user = m.role === 'user'
  const failed = m.status === 'failed'
  return (
    <li
      data-testid="flow-copilot-message"
      data-role={m.role}
      data-status={m.status}
      className={cn(
        'flex max-w-[85%] flex-col gap-1 rounded-lg px-3 py-2 text-sm',
        user ? 'self-end bg-primary text-primary-foreground' : 'self-start border bg-background',
        failed && 'border-destructive/50 text-destructive',
      )}
    >
      {!user ? <ToolList tools={m.tool_calls.map((c) => ({ tool: c.name, ok: c.ok }))} /> : null}
      {m.content ? <span className="whitespace-pre-wrap">{m.content}</span> : null}
      {failed ? (
        <span className="text-xs">{m.error_code === 'paused_quota' ? t('pausedTurn') : t('failedTurn')}</span>
      ) : null}
    </li>
  )
}

function ToolList({ tools }: { tools: { tool: string; ok: boolean }[] }) {
  const t = useT('flow-copilot')
  if (!tools.length) return null
  return (
    <ul className="flex flex-col gap-0.5">
      {tools.map((x, i) => (
        <li
          key={i}
          data-testid="flow-copilot-tool"
          data-tool={x.tool}
          data-ok={x.ok ? 'true' : 'false'}
          className={cn('flex items-center gap-1 text-xs text-muted-foreground', !x.ok && 'text-destructive')}
        >
          {x.ok ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
          {COPILOT_TOOLS.includes(x.tool) ? t(`tools.${x.tool}`) : x.tool}
          {x.ok ? '' : ` — ${t('toolRejected')}`}
        </li>
      ))}
    </ul>
  )
}
