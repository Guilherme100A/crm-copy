// Realtime da lista (T69; spec 03 "Realtime"; AC-T69-02): `chat.created`/`chat.updated` trazem o ChatDto, que é
// aplicado na hora em todas as listas em cache (sobe para o topo, não lidas, prévia; sai da aba se mudou de status).
// Depois, um refetch silencioso (com debounce) acerta ordem, contadores e chats que ainda não estavam na lista.
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { onRealtime } from '@/lib/realtime'
import { CHAT_LIST_KEY, type ChatListItem, type ChatListPage } from './api'
import type { ApiQuery } from './search'

export type ChatPatch = Partial<ChatListItem> & { id: string }

const sortKey = (c: Pick<ChatListItem, 'last_message_at' | 'created_at'>) => c.last_message_at ?? c.created_at

/**
 * Aplica o DTO do evento numa lista paginada. Devolve `null` se o chat não está nela (quem chama decide refazer
 * a busca). O item atualizado vai para o topo quando a última mensagem ficou mais nova que a do primeiro da lista.
 */
export function applyChatPatch(data: InfiniteData<ChatListPage, string | null>, query: ApiQuery, patch: ChatPatch): InfiniteData<ChatListPage, string | null> | null {
  let found: ChatListItem | undefined
  let at: [page: number, index: number] = [0, 0]
  const pages = data.pages.map((p, pi) => {
    const i = p.items.findIndex((c) => c.id === patch.id)
    if (i < 0) return { ...p, items: [...p.items] }
    found = p.items[i]
    at = [pi, i]
    return { ...p, items: p.items.filter((_, j) => j !== i) }
  })
  if (!found) return null
  const merged: ChatListItem = { ...found, ...patch, contact: patch.contact ?? found.contact, label_ids: patch.label_ids ?? found.label_ids }
  // Mudou de aba: sai desta lista.
  if (query.status && merged.status !== query.status) return { ...data, pages }
  const first = pages[0]
  if (!first) return { ...data, pages }
  const top = first.items[0]
  const newer = sortKey(merged) > sortKey(found)
  if (newer && (!top || sortKey(merged) >= sortKey(top))) first.items = [merged, ...first.items]
  // Sem mensagem nova: fica onde estava.
  else pages[at[0]]!.items.splice(at[1], 0, merged)
  return { ...data, pages }
}

/** Remove o chat de uma lista (`chat.deleted`). */
export function removeChat(data: InfiniteData<ChatListPage, string | null>, chatId: string): InfiniteData<ChatListPage, string | null> {
  return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== chatId) })) }
}

const REFETCH_DEBOUNCE_MS = 400
let timer: ReturnType<typeof setTimeout> | undefined

function scheduleRefetch(queryClient: QueryClient) {
  clearTimeout(timer)
  timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: CHAT_LIST_KEY, exact: false, refetchType: 'active' }), REFETCH_DEBOUNCE_MS)
}

type ListKey = readonly ['chat-list', ApiQuery]
const isListKey = (key: readonly unknown[]): key is ListKey => key.length === 2 && key[0] === 'chat-list' && !!key[1] && typeof key[1] === 'object'

export function applyToCache(queryClient: QueryClient, patch: ChatPatch): void {
  for (const [key, data] of queryClient.getQueriesData<InfiniteData<ChatListPage, string | null>>({ queryKey: CHAT_LIST_KEY })) {
    if (!data || !isListKey(key)) continue
    const next = applyChatPatch(data, key[1], patch)
    if (next) queryClient.setQueryData(key, next)
  }
  queryClient.setQueryData<ChatListItem>(['chat', patch.id], (old) => (old ? { ...old, ...patch, contact: patch.contact ?? old.contact } : old))
}

let registered = false

/** Registra os handlers (idempotente). Chamado no carregamento do módulo da rota `/chats`. */
export function registerChatListRealtime(): void {
  if (registered) return
  registered = true
  const onChat = (e: { data: unknown }, queryClient: QueryClient) => {
    const data = e.data as { chat_id?: string; chat?: ChatPatch }
    if (data.chat && typeof data.chat.id === 'string') applyToCache(queryClient, data.chat)
    scheduleRefetch(queryClient)
  }
  onRealtime('chat.created', onChat)
  onRealtime('chat.updated', onChat)
  onRealtime('message.created', (_e, queryClient) => scheduleRefetch(queryClient))
  onRealtime('chat.deleted', (e, queryClient) => {
    const id = (e.data as { chat_id?: string }).chat_id
    if (id)
      for (const [key, data] of queryClient.getQueriesData<InfiniteData<ChatListPage, string | null>>({ queryKey: CHAT_LIST_KEY }))
        if (data && isListKey(key)) queryClient.setQueryData(key, removeChat(data, id))
    scheduleRefetch(queryClient)
  })
}
