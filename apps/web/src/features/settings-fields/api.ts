// API do catálogo de campos personalizados (T26; 17 §3.D): lista única (sistema primeiro), criação e edição só da
// descrição — também nos campos de sistema (T58). Não há exclusão. DTOs locais.
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export interface CustomFieldDto {
  key: string
  description: string | null
  example_value: string | null
  system: boolean
}

export const FIELDS_KEY = ['settings-fields'] as const

export const fieldsQuery = () =>
  queryOptions({
    queryKey: [...FIELDS_KEY, 'list'] as const,
    queryFn: async () => (await api.get<{ items: CustomFieldDto[] }>('/api/custom-fields')).items,
  })

export const fieldsApi = {
  create: async (input: { key: string; description?: string | null }) =>
    (await api.post<{ custom_field: CustomFieldDto }>('/api/custom-fields', input)).custom_field,
  update: async (key: string, description: string | null) =>
    (
      await api.patch<{ custom_field: CustomFieldDto }>(`/api/custom-fields/${encodeURIComponent(key)}`, {
        description,
      })
    ).custom_field,
}
