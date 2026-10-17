// Painel "Teste ao vivo" do editor (07 §2 e §5 item 6; AC-T92-01): conversa com o agente usando o rascunho não
// salvo (`draft`), mostra as habilidades disparadas e os campos preenchidos de cada resposta, os créditos cobrados e
// o uso diário de testes (`eval`). "Limpar conversa" zera o teste no servidor sem mexer no cadastro.
import { Eraser, FlaskConical, Loader2, Send, UserRound, X, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { labApi, type TestMessageResult } from './api'
import {
  agentMessages,
  fieldEntries,
  firstFieldMessage,
  formatCredits,
  labErrorKey,
  msgId,
  skillKey,
  totalCredits,
  type ChatMessage,
} from './lab'

/** Botão do cabeçalho do editor que abre o painel (`agent-lab-open`). Sem agente salvo fica desabilitado. */
export function LiveTestButton({ agentId, getDraft }: { agentId: string | null; getDraft: () => Record<string, unknown> | null }) {
  const t = useT('agent-lab')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="outline"
        data-testid="agent-lab-open"
        aria-expanded={open}
        disabled={!agentId}
        title={!agentId ? t('test.saveFirst') : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <FlaskConical aria-hidden /> {t('test.open')}
      </Button>
      {open && agentId ? <LiveTestPanel agentId={agentId} getDraft={getDraft} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

export function LiveTestPanel({
  agentId,
  getDraft,
  onClose,
}: {
  agentId: string
  getDraft: () => Record<string, unknown> | null
  onClose: () => void
}) {
  const t = useT('agent-lab')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [last, setLast] = useState<TestMessageResult | null>(null)
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    list.current?.scrollTo?.({ top: list.current.scrollHeight })
  }, [messages])

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    setText('')
    setSending(true)
    setMessages((m) => [...m, { id: msgId(), role: 'user', text: body }])
    try {
      const result = await labApi.testMessage(agentId, body, getDraft())
      setLast(result)
      setMessages((m) => [...m, ...agentMessages(result)])
    } catch (err) {
      const key = labErrorKey(err)
      const detail = key === 'validation' ? firstFieldMessage(err) : null
      setMessages((m) => [...m, { id: msgId(), role: 'error', text: [t(`errors.${key}`), detail].filter(Boolean).join(' — ') }])
    } finally {
      setSending(false)
    }
  }

  const clear = async () => {
    setClearing(true)
    try {
      await labApi.resetTest(agentId)
      setMessages([])
      setLast(null)
    } catch (err) {
      notify('agent-lab-error', t(`errors.${labErrorKey(err)}`))
    } finally {
      setClearing(false)
    }
  }

  const fields = fieldEntries(last?.collected)
  const credits = totalCredits(messages)

  return (
    <aside
      data-testid="agent-lab-panel"
      aria-label={t('test.title')}
      className="fixed inset-y-0 right-0 z-[60] flex w-[min(26rem,100vw)] flex-col border-l bg-background shadow-xl"
    >
      <header className="flex items-center gap-2 border-b p-3">
        <FlaskConical className="size-4 shrink-0" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate font-semibold">{t('test.title')}</h2>
        <Button
          variant="ghost"
          size="sm"
          data-testid="agent-lab-clear"
          disabled={clearing || sending}
          onClick={() => void clear()}
        >
          {clearing ? <Loader2 className="animate-spin" aria-hidden /> : <Eraser aria-hidden />}
          <span className="max-sm:sr-only">{t('test.clear')}</span>
        </Button>
        <Button variant="ghost" size="icon" data-testid="agent-lab-close" aria-label={t('test.close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground">
        <span data-testid="agent-lab-credits" data-credits={credits}>
          {t('test.credits', { n: formatCredits(credits) })}
        </span>
        {last ? (
          <span data-testid="agent-lab-eval" data-used={last.eval.used} data-limit={last.eval.limit}>
            {t('test.eval', { used: last.eval.used, limit: last.eval.limit })}
          </span>
        ) : null}
      </div>

      {fields.length ? (
        <section data-testid="agent-lab-fields" className="border-b px-3 py-2">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('test.fields')}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {fields.map(([k, v]) => (
              <div key={k} data-testid={`agent-lab-field-${k}`} className="contents">
                <dt className="font-mono text-muted-foreground">{k}</dt>
                <dd className="min-w-0 break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <ol ref={list} data-testid="agent-lab-messages" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <li data-testid="agent-lab-empty" className="m-auto max-w-64 text-center text-sm text-muted-foreground">
            {t('test.empty')}
          </li>
        ) : null}
        {messages.map((m, i) => {
          // Detalhes (habilidades, campos, créditos) vão na última bolha de cada resposta.
          const next = messages[i + 1]
          const lastOfReply = m.role === 'agent' && !(next?.role === 'agent' && next.result === m.result)
          return (
            <li
              key={m.id}
              data-testid="agent-lab-bubble"
              data-role={m.role}
              className={cn('flex min-w-0 flex-col gap-1', m.role === 'user' ? 'items-end' : 'items-start')}
            >
              {m.text || m.role !== 'agent' ? (
                <p
                  role={m.role === 'error' ? 'alert' : undefined}
                  data-testid={m.role === 'error' ? 'agent-lab-error' : undefined}
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3 py-2 text-sm break-words whitespace-pre-wrap',
                    m.role === 'user' && 'bg-primary text-primary-foreground',
                    m.role === 'agent' && 'bg-muted',
                    m.role === 'error' && 'border border-destructive/40 bg-destructive/5 text-destructive',
                  )}
                >
                  {m.text}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground italic">{t('test.noText')}</p>
              )}
              {lastOfReply && m.role === 'agent' ? <ReplyDetails result={m.result} /> : null}
            </li>
          )
        })}
        {sending ? (
          <li data-testid="agent-lab-typing" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden /> {t('test.typing')}
          </li>
        ) : null}
      </ol>

      <form
        className="flex items-end gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          data-testid="agent-lab-input"
          aria-label={t('test.placeholder')}
          placeholder={t('test.placeholder')}
          rows={2}
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          className="min-h-10 w-full min-w-0 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" size="icon" data-testid="agent-lab-send" aria-label={t('test.send')} disabled={!text.trim() || sending}>
          {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
        </Button>
      </form>
    </aside>
  )
}

function ReplyDetails({ result }: { result: TestMessageResult }) {
  const t = useT('agent-lab')
  const filled = fieldEntries(result.fields_filled)
  return (
    <div className="flex max-w-[85%] flex-col gap-1 text-xs">
      {result.skills_fired.length ? (
        <ul data-testid="agent-lab-skills" className="flex flex-wrap gap-1">
          {result.skills_fired.map((s, i) => (
            <li
              key={`${s.tool}-${i}`}
              data-testid={`agent-lab-skill-${s.action_type}`}
              data-skill-id={s.skill_id ?? undefined}
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-800 dark:text-amber-300"
            >
              <Zap className="size-3" aria-hidden /> {t(`skills.${skillKey(s.action_type)}`)}
            </li>
          ))}
        </ul>
      ) : null}
      {filled.length ? (
        <ul data-testid="agent-lab-filled" className="flex flex-wrap gap-1">
          {filled.map(([k, v]) => (
            <li key={k} data-testid={`agent-lab-filled-${k}`} className="rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-800 dark:text-sky-300">
              {t('test.filled', { key: k, value: v })}
            </li>
          ))}
        </ul>
      ) : null}
      {result.handoff ? (
        <p data-testid="agent-lab-handoff" className="inline-flex items-center gap-1 text-muted-foreground">
          <UserRound className="size-3" aria-hidden /> {t('test.handoff')}
        </p>
      ) : null}
      <p data-testid="agent-lab-msg-credits" className="text-muted-foreground">
        {t('test.charged', { n: formatCredits(result.charged_credits || 0), tokens: result.charged_tokens })}
      </p>
    </div>
  )
}
