// Troca da empresa ativa (spec 01 §5.8; SPEC 3.3): o servidor guarda a empresa corrente (`last_company_id`); o
// cliente troca o `X-Company-Id`, zera TODO o cache (dados da empresa anterior não podem aparecer na nova) e reroda
// a guarda do router, que recarrega o perfil. O shell recebe a sessão nova e reabre o SSE com o `company_id` novo.
import type { QueryClient } from '@tanstack/react-query'
import { api, setActiveCompany } from '@/lib/http'
import type { CompanySummary } from '@/lib/session'

export interface CompanyDto extends CompanySummary {
  description?: string | null
  active?: boolean
}

export interface CompaniesPage {
  items: CompanyDto[]
  page: { page: number; limit: number; total_count: number | null; total_pages: number | null; has_more: boolean }
}

export const COMPANIES_PAGE_SIZE = 20

export const companiesApi = {
  list: (page: number, search: string, signal?: AbortSignal) =>
    api.get<CompaniesPage>('/api/companies', { query: { page, limit: COMPANIES_PAGE_SIZE, search: search.trim() || undefined }, ...(signal ? { signal } : {}) }),
  create: (name: string) => api.post<{ company: CompanyDto }>('/api/companies', { name: name.trim() }),
  switch: (companyId: string) => api.post<{ company: CompanyDto }>(`/api/companies/${encodeURIComponent(companyId)}/switch`),
}

export async function switchCompany(queryClient: QueryClient, router: { invalidate: () => Promise<unknown> }, companyId: string): Promise<void> {
  await companiesApi.switch(companyId)
  setActiveCompany(companyId)
  await queryClient.resetQueries()
  await router.invalidate()
}
