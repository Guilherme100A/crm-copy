// API das etiquetas (T26; 17 §3.E): lista sem paginação com a contagem de contatos, CRUD. DTOs locais.
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export interface LabelDto {
  id: string
  name: string
  color: string
  contacts_count: number
  created_at: string
}

export interface LabelInput {
  name: string
  color: string
}

export const LABELS_KEY = ['settings-labels'] as const
const enc = encodeURIComponent

export const labelsQuery = () =>
  queryOptions({
    queryKey: [...LABELS_KEY, 'list'] as const,
    queryFn: async () => (await api.get<{ items: LabelDto[] }>('/api/labels')).items,
  })

export const labelsApi = {
  create: async (input: LabelInput) => (await api.post<{ label: LabelDto }>('/api/labels', input)).label,
  update: async (id: string, input: LabelInput) =>
    (await api.patch<{ label: LabelDto }>(`/api/labels/${enc(id)}`, input)).label,
  remove: (id: string) => api.delete(`/api/labels/${enc(id)}`),
}
