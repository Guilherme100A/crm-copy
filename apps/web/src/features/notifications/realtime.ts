// Handlers realtime da central (AC-T84-01/02/05). Importado de forma ESTÁTICA pelo shell (via `bell.tsx`): o SSE só
// ouve os tipos registrados quando abre (lição T53).
import type { QueryClient } from '@tanstack/react-query'
import { chatDetailQuery } from '@/features/chat-list/api'
import { onRealtime } from '@/lib/realtime'
import { browserEffects } from './effects'
import { genericItem, messageItem, openChatIdFromPath } from './model'
import { notificationStore } from './store'

interface CachedChat {
  id: string
  contact?: { name?: string | null; phone_e164?: string | null } | null
}

const nameOf = (chat: CachedChat | undefined) => chat?.contact?.name?.trim() || chat?.contact?.phone_e164 || null

/** Nome do contato pelo cache já carregado (detalhe `['chat', id]` ou listas `['chat-list', …]`); o evento não traz. */
export function chatTitleFromCache(qc: QueryClient, chatId: string): string | null {
  const detail = nameOf(qc.getQueryData<CachedChat>(['chat', chatId]))
  if (detail) return detail
  for (const [, data] of qc.getQueriesData<{ pages?: { items?: CachedChat[] }[] }>({ queryKey: ['chat-list'] })) {
    for (const page of data?.pages ?? []) {
      const hit = page.items?.find((c) => c.id === chatId)
      if (hit) return nameOf(hit)
    }
  }
  return null
}

/** Espera máxima pelo detalhe do chat antes de notificar sem o nome. */
export const TITLE_FETCH_TIMEOUT_MS = 1_500

type FetchChat = (qc: QueryClient, chatId: string) => Promise<CachedChat | undefined>
const fetchChatDetail: FetchChat = (qc, chatId) => qc.fetchQuery({ ...chatDetailQuery(chatId), staleTime: 60_000 })

/** Nome do contato: cache; senão `GET /api/chats/:id` (mesma query do detalhe, fica em cache); falha ou demora → null. */
export async function resolveChatTitle(
  qc: QueryClient,
  chatId: string,
  fetchChat: FetchChat = fetchChatDetail,
): Promise<string | null> {
  const cached = chatTitleFromCache(qc, chatId)
  if (cached) return cached
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), TITLE_FETCH_TIMEOUT_MS)
  })
  try {
    return nameOf(await Promise.race([fetchChat(qc, chatId), timeout]))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const currentPath = () => globalThis.location?.pathname ?? ''
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

notificationStore.effects = browserEffects

onRealtime('message.created', (e, qc) => {
  // A decisão (entrada, chat aberto, preferências) é do instante do evento; o nome pode precisar de uma consulta.
  const item = messageItem(e.data, {
    companyId: e.company_id,
    now: Date.now(),
    openChatId: openChatIdFromPath(currentPath()),
    settings: notificationStore.getState().settings,
    title: null,
  })
  if (!item?.chat_id) return
  const title = chatTitleFromCache(qc, item.chat_id)
  if (title) notificationStore.ingest({ ...item, title })
  else void resolveChatTitle(qc, item.chat_id).then((t) => notificationStore.ingest({ ...item, title: t }))
})

onRealtime('notification.created', (e) => {
  const item = genericItem(e.data, {
    id: e.id ? `n-${e.id}` : `n-${newId()}`,
    companyId: e.company_id,
    now: Date.now(),
    settings: notificationStore.getState().settings,
  })
  if (item) notificationStore.ingest(item)
})
