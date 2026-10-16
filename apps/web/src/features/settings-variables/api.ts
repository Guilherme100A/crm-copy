// API das variáveis globais (T35; 17 §3.C): lista paginada com busca e CRUD. O servidor aplica o prefixo `g_` e
// mantém o nome imutável. DTOs locais.
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import type { PageMeta } from '@/features/settings-quick-replies/kit'
import { api } from '@/lib/http'

export type VariableType = 'text' | 'number'
export const VARIABLE_TYPES: readonly VariableType[] = ['text', 'number']

export interface GlobalVariableDto {
  id: string
  name: string
  description: string | null
  type: VariableType
  value: string | null
  created_at: string
  updated_at: string
}

export interface GlobalVariableInput {
  name?: string
  description?: string | null
  type: VariableType
  value: string
}

export const VARIABLES_PAGE_SIZE = 20
export const VARIABLES_KEY = ['settings-variables'] as const
const enc = encodeURIComponent

export const variablesPageQuery = (page: number, search: string) =>
  queryOptions({
    queryKey: [...VARIABLES_KEY, 'list', page, search] as const,
    queryFn: () =>
      api.get<{ items: GlobalVariableDto[]; page: PageMeta }>('/api/global-variables', {
        query: { page, limit: VARIABLES_PAGE_SIZE, search: search || undefined },
      }),
    placeholderData: keepPreviousData,
  })

export const variablesApi = {
  create: async (input: GlobalVariableInput) =>
    (await api.post<{ global_variable: GlobalVariableDto }>('/api/global-variables', input)).global_variable,
  update: async (id: string, input: Omit<GlobalVariableInput, 'name'>) =>
    (await api.patch<{ global_variable: GlobalVariableDto }>(`/api/global-variables/${enc(id)}`, input))
      .global_variable,
  remove: (id: string) => api.delete(`/api/global-variables/${enc(id)}`),
}
