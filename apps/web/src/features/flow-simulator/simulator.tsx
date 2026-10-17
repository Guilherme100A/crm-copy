// Simulador no editor (T82; 06 §2.2 botão "Simular", §4.4, §5.6): painel lateral (gaveta de baixo no mobile) com a
// conversa em formato de chat e os botões das respostas possíveis da espera atual. Roda o RASCUNHO salvo
// (`beforeRun` salva o pendente antes) pela rota `POST /api/flows/:id/simulate`; nada é enviado nem salvo.
import { Bot, Play, RotateCcw, Send, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { simulatorApi, type SimMessage, type SimulateBody } from './api'
import {
  acceptsText,
  applyResult,
  choiceButtons,
  choiceLabel,
  choose,
  initialSession,
  resumeBody,
  startSession,
  type ChatItem,
  type SimSession,
} from './session'

export interface FlowSimulatorProps {
  flowId: string
  /** Salva o rascunho pendente antes de simular (o simulador lê o rascunho do servidor). */
  beforeRun?: () => Promise<unknown>
  /** Nome do bloco no canvas (avisos e fim). */
  nodeName?: (nodeKey: string) => string | undefined
}

/** Botão "Simular" do cabeçalho do editor + painel. */
export function FlowSimulator({ flowId, beforeRun, nodeName }: FlowSimulatorProps) {
  const t = useT('flow-simulator')
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState<SimSession>(initialSession)
  const [failed, setFailed] = useState<SimulateBody | null>(null)
  const runId = useRef(0)

  const run = useCallback(
    async (body: SimulateBody, base: SimSession) => {
      const id = ++runId.current
      setFailed(null)
      setSession(base)
      try {
        if (!body.resume) await beforeRun?.()
        const result = await simulatorApi.run(flowId, body)
        if (id === runId.current) setSession(applyResult(base, result))
      } catch {
        if (id === runId.current) setFailed(body)
      }
    },
    [beforeRun, flowId],
  )

  const restart = useCallback(() => void run({}, startSession()), [run])

  const openPanel = () => {
    setOpen(true)
    restart()
  }
  const close = () => {
    runId.current++
    setOpen(false)
    setSession(initialSession())
    setFailed(null)
  }

  const answer = (handle: string, text: string, sendText?: string) => {
    void run(resumeBody(session, handle, sendText), choose(session, handle, text))
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid="flow-simulate"
        aria-expanded={open}
        onClick={() => (open ? close() : openPanel())}
      >
        <Play aria-hidden /> {t('button')}
      </Button>
      {open ? (
        <SimulatorPanel
          session={session}
          failed={!!failed}
          nodeName={nodeName}
          onRetry={() => failed && void run(failed, failed.resume ? session : startSession())}
          onRestart={restart}
          onClose={close}
          onAnswer={answer}
        />
      ) : null}
    </>
  )
}

interface PanelProps {
  session: SimSession
  failed: boolean
  nodeName?: (nodeKey: string) => string | undefined
  onRetry: () => void
  onRestart: () => void
  onClose: () => void
  onAnswer: (handle: string, text: string, sendText?: string) => void
}

function SimulatorPanel({ session, failed, nodeName, onRetry, onRestart, onClose, onAnswer }: PanelProps) {
  const t = useT('flow-simulator')
  const [draft, setDraft] = useState('')
  const list = useRef<HTMLOListElement>(null)
  const name = (key?: string) => (key ? (nodeName?.(key) ?? key) : '')
  const kind = session.wait?.kind
  const buttons = choiceButtons(session)
  const textMode = acceptsText(session)

  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.items.length, session.status])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onAnswer('source', text, text)
  }

  return (
    <aside
      data-testid="flow-simulator"
      data-state={failed ? 'error' : session.status}
      aria-label={t('title')}
      className="fixed inset-x-0 bottom-0 z-[60] flex h-[85dvh] flex-col rounded-t-xl border bg-background shadow-xl lg:inset-x-auto lg:top-28 lg:right-4 lg:bottom-4 lg:h-auto lg:w-96 lg:rounded-xl"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Bot className="size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{t('title')}</h2>
          <p className="truncate text-xs text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          data-testid="flow-simulator-restart"
          title={t('restart')}
          onClick={onRestart}
        >
          <RotateCcw aria-hidden />
          <span className="sr-only">{t('restart')}</span>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          data-testid="flow-simulator-close"
          title={t('close')}
          onClick={onClose}
        >
          <X aria-hidden />
          <span className="sr-only">{t('close')}</span>
        </Button>
      </header>

      <ol
        ref={list}
        data-testid="flow-simulator-messages"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-muted/30 p-3"
      >
        {session.items.length === 0 && session.status !== 'running' && !failed ? (
          <li className="text-center text-xs text-muted-foreground">{t('empty')}</li>
        ) : null}
        {session.items.map((item, i) => (
          <ChatRow key={i} item={item} name={name} />
        ))}
        {session.status === 'running' && !failed ? (
          <li data-testid="flow-simulator-loading" role="status" className="self-start text-xs text-muted-foreground">
            {t('running')}
          </li>
        ) : null}
      </ol>

      <footer className="flex flex-col gap-2 border-t p-3">
        {failed ? (
          <div
            data-testid="flow-simulator-error"
            role="alert"
            className="flex items-center gap-2 text-sm text-destructive"
          >
            <span className="flex-1">{t('error')}</span>
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t('retry')}
            </Button>
          </div>
        ) : null}
        {session.status === 'waiting' && kind ? (
          <>
            <p data-testid="flow-simulator-wait" data-kind={kind} className="text-xs font-medium text-muted-foreground">
              {t(`wait.${kind}`)}
            </p>
            {buttons.length ? (
              <div data-testid="flow-simulator-choices" className="flex flex-wrap gap-2">
                {buttons.map((c) => {
                  const label = choiceLabel(c, kind, t)
                  return (
                    <Button
                      key={c.handle}
                      size="sm"
                      variant={c.connected ? 'outline' : 'ghost'}
                      data-testid={`flow-simulator-choice-${c.handle}`}
                      data-connected={c.connected ? 'true' : 'false'}
                      title={c.connected ? undefined : t('notConnected')}
                      className={cn(
                        'h-auto max-w-full min-h-8 py-1 whitespace-normal text-left',
                        !c.connected && 'border border-dashed text-muted-foreground',
                      )}
                      onClick={() => onAnswer(c.handle, label)}
                    >
                      {label}
                    </Button>
                  )
                })}
              </div>
            ) : null}
            {textMode ? (
              <form className="flex gap-2" onSubmit={submit}>
                <input
                  data-testid="flow-simulator-input"
                  value={draft}
                  maxLength={4000}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t('inputPlaceholder')}
                  className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button
                  type="submit"
                  size="icon"
                  data-testid="flow-simulator-send"
                  disabled={!draft.trim()}
                  title={t('send')}
                >
                  <Send aria-hidden />
                  <span className="sr-only">{t('send')}</span>
                </Button>
              </form>
            ) : null}
          </>
        ) : null}
        {session.status === 'finished' ? (
          <Button size="sm" variant="outline" className="self-start" onClick={onRestart}>
            <RotateCcw aria-hidden /> {t('restart')}
          </Button>
        ) : null}
      </footer>
    </aside>
  )
}

function ChatRow({ item, name }: { item: ChatItem; name: (key?: string) => string }) {
  const t = useT('flow-simulator')
  if (item.type === 'bot')
    return (
      <li
        data-testid="flow-simulator-bot"
        data-node={item.message.node_key}
        data-to={item.message.to}
        className={cn(
          'max-w-[85%] self-start rounded-2xl rounded-tl-sm border bg-card px-3 py-2 text-sm shadow-sm',
          item.message.to === 'internal' && 'border-dashed',
        )}
      >
        {item.message.to === 'internal' ? (
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">{t('internal')}</p>
        ) : null}
        <MessageBody message={item.message} />
      </li>
    )
  if (item.type === 'user')
    return (
      <li
        data-testid="flow-simulator-user"
        data-handle={item.handle}
        className="max-w-[85%] self-end rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground"
      >
        {item.text}
      </li>
    )
  if (item.type === 'notice')
    return (
      <li
        data-testid="flow-simulator-notice"
        data-code={item.code}
        data-node={item.nodeKey}
        className="self-center rounded-full bg-amber-500/15 px-3 py-1 text-center text-xs text-amber-800 dark:text-amber-300"
      >
        {t(`notice.${item.code}`, { name: name(item.nodeKey), target: item.target ?? '' })}
      </li>
    )
  const loop = item.reason === 'loop_guard'
  return (
    <li
      data-testid={loop ? 'flow-simulator-interrupted' : 'flow-simulator-end'}
      data-reason={item.reason}
      data-node={item.nodeKey}
      role={loop || item.reason === 'failed' ? 'alert' : undefined}
      className={cn(
        'self-center rounded-lg px-3 py-1.5 text-center text-xs',
        loop || item.reason === 'failed' || item.reason === 'no_start'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {t(`end.${item.reason}`, { name: name(item.nodeKey), error: item.error ?? '' })}
    </li>
  )
}

function MessageBody({ message: m }: { message: SimMessage }) {
  const t = useT('flow-simulator')
  if (m.kind === 'text') return <p className="break-words whitespace-pre-wrap">{m.text}</p>
  const caption = 'caption' in m ? m.caption : undefined
  const detail =
    m.kind === 'document' ? m.file_name : m.kind === 'contact' ? m.name : m.kind === 'location' ? m.name : undefined
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">
        [{t(`media.${m.kind}`)}]{detail ? ` ${detail}` : ''}
      </p>
      {'url' in m ? <p className="truncate text-xs text-muted-foreground">{m.url}</p> : null}
      {caption ? <p className="break-words whitespace-pre-wrap">{caption}</p> : null}
    </div>
  )
}
