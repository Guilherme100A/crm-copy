// API do formulário de contato (T26/T48): busca prévia (`GET /api/contacts?search=`, decisão do Orquestrador — o
// `/duplicates` só acha iguais exatos), detalhe, criar/editar e abrir conversa (`POST /api/chats`).
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'
import { CONTACTS_KEY, type ContactDto } from '@/features/contacts/api'
import { DUPLICATE_SEARCH_LIMIT, type ContactDetail } from './form'

const enc = encodeURIComponent

export const contactSearchQuery = (term: string | null) =>
  queryOptions({
    queryKey: [...CONTACTS_KEY, 'form-search', term] as const,
    queryFn: async ({ signal }) =>
      (
        await api.get<{ items: ContactDto[] }>('/api/contacts', {
          query: { search: term!, page: 1, limit: DUPLICATE_SEARCH_LIMIT, skip_total_count: 1 },
          signal,
        })
      ).items,
    enabled: !!term,
    staleTime: 5_000,
  })

export const contactDetailQuery = (id: string | null) =>
  queryOptions({
    queryKey: [...CONTACTS_KEY, 'detail', id] as const,
    queryFn: async () => (await api.get<{ contact: ContactDetail }>(`/api/contacts/${enc(id!)}`)).contact,
    enabled: !!id,
    staleTime: 0,
  })

export const contactFormApi = {
  create: async (body: Record<string, unknown>) =>
    (await api.post<{ contact: ContactDetail }>('/api/contacts', body)).contact,
  update: async (id: string, body: Record<string, unknown>) =>
    (await api.patch<{ contact: ContactDetail }>(`/api/contacts/${enc(id)}`, body)).contact,
  openChat: async (contactId: string, connectionId: string) =>
    (
      await api.post<{ chat: { id: string }; created: boolean }>('/api/chats', {
        contact_id: contactId,
        connection_id: connectionId,
      })
    ).chat,
}
