// Chamadas do compositor (T85): envio (T49), upload de mídia, figurinhas e respostas rápidas (T35), estado da
// conexão (T40) e a mensagem otimista na thread (cache da T75).
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { threadKey, type MessageDto } from '@/features/chat-thread/api'
import { receiveMessage } from '@/features/chat-thread/realtime'
import { findMessage, patchMessage, type ThreadData } from '@/features/chat-thread/timeline'
import { api, HttpError } from '@/lib/http'

const enc = encodeURIComponent

export interface SendPayload {
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'pix'
  text?: string
  media_id?: string
  caption?: string
  ptt?: boolean
  pix?: { key: string; name?: string | null; amount_cents?: number | null }
  quoted_id?: string | null
  signature?: boolean
}

export interface StickerDto {
  id: string
  name: string
  media_id: string
  url: string
  favorite: boolean
}

export interface QuickReplyDto {
  id: string
  shortcut: string
  preview: string
}

export const composerApi = {
  send: (chatId: string, payload: SendPayload, clientId: string) =>
    api.post<{ message: MessageDto }>(`/api/chats/${enc(chatId)}/messages`, { ...payload, client_message_id: clientId }, { headers: { 'Idempotency-Key': clientId } }),
  upload: async (file: Blob, name: string) => {
    const form = new FormData()
    form.append('file', file, name)
    return (await api.post<{ media: { id: string; mime: string } }>('/api/media', form)).media
  },
  renderQuickReply: (quickReplyId: string, contactId: string | null) => api.post<{ text: string }>('/api/content/render', { quick_reply_id: quickReplyId, contact_id: contactId }),
}

export const stickersQuery = () =>
  queryOptions({ queryKey: ['chat-composer', 'stickers'] as const, queryFn: async () => (await api.get<{ items: StickerDto[] }>('/api/stickers')).items, staleTime: 60_000 })

export const quickRepliesQuery = (search: string) =>
  queryOptions({
    queryKey: ['chat-composer', 'quick-replies', search] as const,
    queryFn: async (): Promise<QuickReplyDto[] | 'forbidden'> => {
      try {
        return (await api.get<{ items: QuickReplyDto[] }>('/api/quick-replies', { query: { search: search || undefined, limit: 20 } })).items
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return 'forbidden'
        throw err
      }
    },
    staleTime: 30_000,
  })

/** Status de UI da conexão (T40); `null` quando o usuário não pode ver conexões. */
export const connectionStatusQuery = (connectionId: string | undefined) =>
  queryOptions({
    queryKey: ['chat-composer', 'connection', connectionId ?? ''] as const,
    queryFn: async (): Promise<string | null> => {
      try {
        return (await api.get<{ connection: { status: string } }>(`/api/connections/${enc(connectionId!)}`)).connection.status
      } catch (err) {
        if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return null
        throw err
      }
    },
    enabled: !!connectionId,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    retry: false,
  })

/** Status em que o WhatsApp não aceita envio. */
export const BLOCKED_CONNECTION_STATUSES = ['disconnected', 'banned', 'paused'] as const
export const isBlockedStatus = (s: string | null | undefined) => !!s && (BLOCKED_CONNECTION_STATUSES as readonly string[]).includes(s)

// ---- otimista --------------------------------------------------------------------------------------------------

export function tempMessage(input: { chatId: string; clientId: string; type: string; body: string | null; userId: string | null; now?: Date }): MessageDto {
  const at = (input.now ?? new Date()).toISOString()
  return {
    id: `tmp-${input.clientId}`,
    chat_id: input.chatId,
    direction: 'outbound',
    sender_type: 'user',
    sender_user_id: input.userId,
    type: input.type,
    wa_type: null,
    body: input.body,
    media: null,
    quoted_wa_message_id: null,
    status: 'queued',
    error: null,
    wa_message_id: null,
    pipeline_message_id: null,
    historical: false,
    deleted_at: null,
    wa_timestamp: null,
    created_at: at,
    reactions: [],
  }
}

/** Mostra a mensagem na thread na hora (e a thread rola ao fim, por ser minha). */
export const showTemp = (qc: QueryClient, temp: MessageDto) => receiveMessage(qc, temp)

/** Troca a temporária pela real; se o SSE já trouxe a real, só remove a temporária. */
export function confirmTemp(qc: QueryClient, chatId: string, tempId: string, real: MessageDto): void {
  qc.setQueryData<ThreadData>(threadKey(chatId), (d) => {
    if (!d) return d
    if (findMessage(d, real.id)) return removeFrom(d, tempId)
    return patchMessage(d, tempId, { ...real, media: real.media ?? null })
  })
}

export function dropTemp(qc: QueryClient, chatId: string, tempId: string): void {
  qc.setQueryData<ThreadData>(threadKey(chatId), (d) => (d ? removeFrom(d, tempId) : d))
}

function removeFrom(d: ThreadData, id: string): ThreadData {
  return { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.filter((m) => m.id !== id) })) }
}
