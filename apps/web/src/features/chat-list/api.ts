// Dados da lista de chats (T69): `GET /api/chats` paginado por cursor (15 por página) com os contadores por aba, e
// as opções do modal de filtros (`GET /api/chats/filter-options`, já no escopo do atendente).
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { api, HttpError } from '@/lib/http'
import { toApiQuery, type ApiQuery, type ChatSearch, type ChatTab } from './search'

export interface ChatListItem {
  id: string
  connection_id: string
  contact_id: string
  status: ChatTab
  assigned_user_id: string | null
  department_id: string | null
  ai_agent_id: string | null
  unread_count: number
  last_message_preview: string | null
  last_message_at: string | null
  last_inbound_at: string | null
  opened_at: string
  resolved_at: string | null
  blocked: boolean
  created_at: string
  updated_at: string
  contact: { id: string; name: string; phone_e164: string | null; wa_lid: string | null }
  assigned_user: { id: string; name: string } | null
  label_ids: string[]
}

export type ChatCounts = Record<ChatTab, number>

export interface ChatListPage {
  items: ChatListItem[]
  next_cursor: string | null
  counts: ChatCounts
}

export interface FilterOptions {
  connections: string[]
  departments: { id: string; name: string; color?: string | null }[]
  labels: { id: string; name: string; color?: string | null }[]
  users: { id: string; name: string }[]
}

/** Prefixo de todas as listas em cache (o realtime atualiza todas). */
export const CHAT_LIST_KEY = ['chat-list'] as const

export const chatListQueryKey = (query: ApiQuery) => [...CHAT_LIST_KEY, query] as const

export function chatListQuery(search: ChatSearch) {
  const query = toApiQuery(search)
  return infiniteQueryOptions({
    queryKey: chatListQueryKey(query),
    queryFn: ({ pageParam, signal }) => api.get<ChatListPage>('/api/chats', { query: { ...query, cursor: pageParam ?? undefined }, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    // Cache curto por combinação de filtros (spec 03 F12: 10 s).
    staleTime: 10_000,
  })
}

export const filterOptionsQuery = () =>
  queryOptions({ queryKey: ['chat-list', 'filter-options'] as const, queryFn: () => api.get<FilterOptions>('/api/chats/filter-options'), staleTime: 60_000 })

/** Nomes das conexões (exige `connections.view`; sem a permissão a lista mostra só o chip genérico). */
export const connectionNamesQuery = () =>
  queryOptions({
    queryKey: ['chat-list', 'connection-names'] as const,
    queryFn: async (): Promise<Record<string, string>> => {
      try {
        const r = await api.get<{ items: { id: string; name: string }[] }>('/api/connections', { query: { limit: 100 } })
        return Object.fromEntries(r.items.map((c) => [c.id, c.name]))
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return {}
        throw err
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })

/** Quadros do Kanban para o filtro CRM (exige `kanban.view`; sem ela o filtro some). */
export const crmBoardsQuery = () =>
  queryOptions({
    queryKey: ['chat-list', 'crm-boards'] as const,
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      try {
        return (await api.get<{ items: { id: string; name: string }[] }>('/api/crms')).items
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return []
        throw err
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })

export const chatDetailQuery = (chatId: string) =>
  queryOptions({ queryKey: ['chat', chatId] as const, queryFn: async () => (await api.get<{ chat: ChatListItem }>(`/api/chats/${encodeURIComponent(chatId)}`)).chat })
