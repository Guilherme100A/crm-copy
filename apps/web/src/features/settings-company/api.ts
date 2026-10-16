// API da empresa (T22; 16 §3.1, §5 "Empresa"): ler, salvar, desativar (`DELETE`) e reativar (`PUT { active: true }`).
// O DTO do fio (`CompanyDto` do core + `role`) não bate com o `companySchema` do shared: tipo local.
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import type { CompanyRole } from '@crm/shared'
import { api } from '@/lib/http'
import { profileQueryKey } from '@/lib/session'

export interface CompanyDto {
  id: string
  name: string
  slug: string
  description: string | null
  active: boolean
  time_zone: string
  connection_status_emails_enabled: boolean
  deactivated_at: string | null
  created_at: string
  updated_at: string
  role: CompanyRole
}

export interface CompanyInput {
  name?: string
  slug?: string
  description?: string | null
  time_zone?: string
  connection_status_emails_enabled?: boolean
}

const enc = encodeURIComponent
export const COMPANY_KEY = ['settings-company'] as const
export const companyKey = (id: string) => [...COMPANY_KEY, id] as const

export const companyQuery = (id: string) =>
  queryOptions({
    queryKey: companyKey(id),
    queryFn: async () => (await api.get<{ company: CompanyDto }>(`/api/companies/${enc(id)}`)).company,
  })

export const companyApi = {
  update: async (id: string, input: CompanyInput) =>
    (await api.put<{ company: CompanyDto }>(`/api/companies/${enc(id)}`, input)).company,
  deactivate: async (id: string) =>
    (await api.delete<{ company: CompanyDto; paused_session_ids: string[] }>(`/api/companies/${enc(id)}`)).company,
  reactivate: async (id: string) =>
    (await api.put<{ company: CompanyDto }>(`/api/companies/${enc(id)}`, { active: true })).company,
}

/** Depois de salvar/desativar: a empresa, o perfil e a lista de contas do usuário (16 §5 item 2). */
export async function refreshCompany(qc: QueryClient, company: CompanyDto): Promise<void> {
  qc.setQueryData(companyKey(company.id), company)
  await Promise.all([
    qc.invalidateQueries({ queryKey: profileQueryKey }),
    qc.invalidateQueries({ queryKey: ['company-switcher'] }),
  ])
}
