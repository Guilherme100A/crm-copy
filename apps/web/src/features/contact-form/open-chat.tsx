// Abrir conversa com o contato (05 §5 nº 21): com 1 conexão cria direto; com várias, modal para escolher (busca por
// nome/telefone/status, pré-seleciona a primeira `connected`). Leva a `/chats/$chatId`.
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, Search } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { connectionsQuery, firstConnected, type ConnectionDto } from '@/features/contacts/api'
import { ModalShell } from '@/features/contacts/dialogs'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { contactFormApi } from './api'
import { filterConnections } from './form'

export function useOpenChat() {
  const t = useT('contact-form')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [contactId, setContactId] = useState<string | null>(null)
  const [conns, setConns] = useState<ConnectionDto[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)

  const go = async (cid: string, connectionId: string) => {
    setPending(true)
    try {
      const chat = await contactFormApi.openChat(cid, connectionId)
      setContactId(null)
      await navigate({ to: '/chats/$chatId', params: { chatId: chat.id } })
      return true
    } catch {
      notify('contact-open-chat-error', t('openChat.error'))
      return false
    } finally {
      setPending(false)
    }
  }

  /** Abre (ou escolhe a conexão para abrir) a conversa com o contato. */
  const open = async (cid: string) => {
    let list: ConnectionDto[]
    try {
      list = await qc.fetchQuery(connectionsQuery())
    } catch {
      list = []
    }
    if (list.length === 0) {
      notify('contact-open-chat-no-connection', t('openChat.noConnection'))
      return false
    }
    if (list.length === 1) return go(cid, list[0]!.id)
    setConns(list)
    setSelected((firstConnected(list) ?? list[0]!).id)
    setText('')
    setContactId(cid)
    return true
  }

  const shown = filterConnections(conns, text)
  const dialog = (
    <ModalShell
      open={!!contactId}
      onClose={() => setContactId(null)}
      testId="contact-open-chat-dialog"
      title={t('openChat.title')}
    >
      <label className="relative block">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          data-testid="contact-open-chat-search"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('openChat.search')}
          aria-label={t('openChat.search')}
          className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <ul role="listbox" aria-label={t('openChat.title')} className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {shown.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              role="option"
              aria-selected={selected === c.id}
              data-testid={`contact-open-chat-connection-${c.id}`}
              onClick={() => setSelected(c.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent',
                selected === c.id && 'border-primary bg-primary/5',
              )}
            >
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  c.status === 'connected' ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="text-xs text-muted-foreground">{c.status}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 ? <li className="px-3 py-2 text-sm text-muted-foreground">{t('openChat.empty')}</li> : null}
      </ul>
      <div className="flex justify-end gap-2">
        <Button variant="outline" data-testid="contact-open-chat-cancel" onClick={() => setContactId(null)}>
          {t('common.cancel')}
        </Button>
        <Button
          data-testid="contact-open-chat-confirm"
          disabled={!selected || pending}
          onClick={() => contactId && selected && void go(contactId, selected)}
        >
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t('openChat.confirm')}
        </Button>
      </div>
    </ModalShell>
  )

  return { open, dialog, pending }
}
