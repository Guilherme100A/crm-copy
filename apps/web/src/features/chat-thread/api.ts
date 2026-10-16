// Dados da conversa (T75): histórico paginado para trás (25 por página, `before` = id mais antigo), notas internas e
// ações por mensagem (T49/T119; o escopo é aplicado no servidor).
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export type MessageDirection = 'inbound' | 'outbound'
export type SenderType = 'contact' | 'user' | 'ai' | 'flow' | 'system'

export interface Reaction {
  emoji: string
  actor_type: string
  user_id: string | null
}

export interface MessageDto {
  id: string
  chat_id: string
  direction: MessageDirection
  sender_type: SenderType | (string & {})
  sender_user_id: string | null
  type: string
  wa_type: string | null
  body: string | null
  media: Record<string, unknown> | null
  quoted_wa_message_id: string | null
  status: string
  error: string | null
  wa_message_id: string | null
  pipeline_message_id: string | null
  historical: boolean
  deleted_at: string | null
  wa_timestamp: string | null
  created_at: string
  /** Reações gravadas (quando a API devolve; o SSE `message.reacted` também atualiza). */
  reactions?: Reaction[]
}

export interface MessagesPage {
  items: MessageDto[]
  next_cursor: string | null
}

export interface NoteDto {
  id: string
  chat_id: string
  body: string
  author: { id: string; name: string } | null
  created_at: string
}

export const MESSAGES_PAGE_SIZE = 25

const enc = encodeURIComponent

export const threadKey = (chatId: string) => ['chat-thread', chatId] as const
export const notesKey = (chatId: string) => ['chat-thread', chatId, 'notes'] as const

/** Páginas: a 1ª é a mais recente; as seguintes, cada vez mais antigas. */
export const messagesQuery = (chatId: string) =>
  infiniteQueryOptions({
    queryKey: threadKey(chatId),
    queryFn: ({ pageParam, signal }) =>
      api.get<MessagesPage>(`/api/chats/${enc(chatId)}/messages`, { query: { limit: MESSAGES_PAGE_SIZE, before: pageParam ?? undefined }, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    staleTime: 30_000,
  })

export const notesQuery = (chatId: string) =>
  queryOptions({
    queryKey: notesKey(chatId),
    queryFn: async () => (await api.get<{ items: NoteDto[] }>(`/api/chats/${enc(chatId)}/notes`)).items,
    staleTime: 30_000,
  })

/** Mídia da mensagem (entrada: baixada do WhatsApp sob demanda; saída: o arquivo enviado). */
export const mediaUrl = (chatId: string, messageId: string, download = false) =>
  `/api/chats/${enc(chatId)}/messages/${enc(messageId)}/media${download ? '?download=1' : ''}`

export const threadApi = {
  markRead: (chatId: string) => api.post<{ chat: { id: string } & Record<string, unknown> }>(`/api/chats/${enc(chatId)}/read`),
  react: (chatId: string, messageId: string, emoji: string) => api.post<{ message: MessageDto }>(`/api/chats/${enc(chatId)}/messages/${enc(messageId)}/react`, { emoji }),
  forward: (chatId: string, messageId: string, toChatId: string) =>
    api.post<{ message: MessageDto }>(`/api/chats/${enc(chatId)}/messages/${enc(messageId)}/forward`, { chat_id: toChatId }),
  deleteForEveryone: (chatId: string, messageId: string) => api.post<{ message: MessageDto }>(`/api/chats/${enc(chatId)}/messages/${enc(messageId)}/delete`),
  retry: (chatId: string, messageId: string) => api.post<{ message: MessageDto }>(`/api/chats/${enc(chatId)}/messages/${enc(messageId)}/retry`),
}
