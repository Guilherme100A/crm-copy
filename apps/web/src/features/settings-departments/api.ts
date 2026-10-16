// API de departamentos (T31; 16 §3.2, §5 "Departamentos"): lista paginada (20) com busca, criar, editar, excluir.
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export interface DepartmentDto {
  id: string
  name: string
  color: string
  created_at: string
  updated_at: string
}

export interface DepartmentsPage {
  items: DepartmentDto[]
  page: { page: number; limit: number; total_count: number | null; total_pages: number | null; has_more: boolean }
}

export interface DepartmentInput {
  name: string
  color: string
}

const enc = encodeURIComponent
export const DEPARTMENTS_KEY = ['settings-departments'] as const
export const DEPARTMENTS_PAGE_SIZE = 20

export const departmentsQuery = (page: number, search: string) =>
  queryOptions({
    queryKey: [...DEPARTMENTS_KEY, 'list', page, search] as const,
    queryFn: () =>
      api.get<DepartmentsPage>('/api/departments', {
        query: { page, limit: DEPARTMENTS_PAGE_SIZE, search: search.trim() || undefined },
      }),
    placeholderData: keepPreviousData,
  })

export const departmentsApi = {
  create: async (input: DepartmentInput) =>
    (await api.post<{ department: DepartmentDto }>('/api/departments', input)).department,
  update: async (id: string, input: DepartmentInput) =>
    (await api.patch<{ department: DepartmentDto }>(`/api/departments/${enc(id)}`, input)).department,
  remove: (id: string) => api.delete(`/api/departments/${enc(id)}`),
}
