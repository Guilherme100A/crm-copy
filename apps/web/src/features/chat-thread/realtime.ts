// Realtime da conversa (T75): message.created (fim da thread), message.status (ticks), message.deleted,
// message.reacted e chat.updated (nota nova → recarrega as notas). Registrado ao carregar o slot (eager).
import type { QueryClient } from '@tanstack/react-query'
import { onRealtime } from '@/lib/realtime'
import { notesKey, threadKey, type MessageDto } from './api'
import { appendMessage, applyReaction, findMessage, patchMessage, type ThreadData } from './timeline'

type Listener = (chatId: string, message: MessageDto) => void
const appendListeners = new Set<Listener>()

/** A thread aberta é avisada da mensagem nova (para decidir se rola ao fim). */
export function onThreadAppend(fn: Listener): () => void {
  appendListeners.add(fn)
  return () => appendListeners.delete(fn)
}

function update(queryClient: QueryClient, chatId: string, fn: (d: ThreadData) => ThreadData) {
  queryClient.setQueryData<ThreadData>(threadKey(chatId), (d) => (d ? fn(d) : d))
}

export function receiveMessage(queryClient: QueryClient, message: MessageDto): void {
  const key = threadKey(message.chat_id)
  if (!queryClient.getQueryData(key)) return
  const existed = !!findMessage(queryClient.getQueryData<ThreadData>(key), message.id)
  update(queryClient, message.chat_id, (d) => appendMessage(d, message))
  if (!existed) for (const l of appendListeners) l(message.chat_id, message)
}

let registered = false

export function registerThreadRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('message.created', (e, qc) => {
    const m = (e.data as { message?: MessageDto }).message
    if (m && typeof m.id === 'string' && typeof m.chat_id === 'string') receiveMessage(qc, m)
  })
  onRealtime('message.status', (e, qc) => {
    const d = e.data as { chat_id?: string; message_id?: string; status?: string; error?: string | null }
    if (d.chat_id && d.message_id && d.status) update(qc, d.chat_id, (t) => patchMessage(t, d.message_id!, { status: d.status!, error: d.error ?? null }))
  })
  onRealtime('message.deleted', (e, qc) => {
    const d = e.data as { chat_id?: string; message_id?: string }
    if (d.chat_id && d.message_id) update(qc, d.chat_id, (t) => patchMessage(t, d.message_id!, { deleted_at: new Date(e.at || Date.now()).toISOString() }))
  })
  onRealtime('message.reacted', (e, qc) => {
    const d = e.data as { chat_id?: string; message_id?: string; emoji?: string; user_id?: string | null }
    if (!d.chat_id || !d.message_id) return
    const current = findMessage(qc.getQueryData<ThreadData>(threadKey(d.chat_id)), d.message_id)
    if (!current) return
    update(qc, d.chat_id, (t) => patchMessage(t, d.message_id!, { reactions: applyReaction(current.reactions, { emoji: d.emoji ?? '', user_id: d.user_id ?? null }) }))
  })
  // Nota adicionada publica chat.updated: recarrega as notas do chat, se abertas.
  onRealtime('chat.updated', (e, qc) => {
    const id = (e.data as { chat_id?: string }).chat_id
    if (id && qc.getQueryData(notesKey(id))) void qc.invalidateQueries({ queryKey: notesKey(id) })
  })
}
