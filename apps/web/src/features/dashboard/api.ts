// Dados do dashboard (T55): bootstrap (opções, grupos, leads e marco), bloco de vendas do período e o fuso da empresa
// (para os presets e a saudação). Grupos de filtro pela API de vendas (`/api/sales/filter-groups`).
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export interface Milestone {
  level: number
  key: string
  name: string
  description: string
  min_cents: number
}

export interface MilestoneResult {
  level: number
  current: Milestone | null
  next: Milestone | null
  progress_pct: number
  remaining_cents: number
  max_reached: boolean
}

export interface FilterGroup {
  id: string
  name: string
  connection_ids: string[]
  product_ids: string[]
  ad_account_ids: string[]
}

export interface Bootstrap {
  products: { id: string; name: string; currency: string }[]
  connections: { id: string; name: string; phone_number: string | null; status: string; scheduled_for_deletion: boolean }[]
  filter_groups: FilterGroup[]
  leads_count: number
  lifetime_revenue?: { revenue_cents: number; display_currency: string; milestone: MilestoneResult }
}

export interface Trend {
  direction: 'up' | 'down' | 'neutral'
  delta_pct: number | null
}

export interface SalesKpis {
  new_leads: number
  sales_count: number
  revenue_cents: number
  avg_ticket_cents: number | null
  conversion_rate: number | null
  spend_cents: number
  roas: number | null
  profit_pre_fees_cents: number
  expenses_cents: number
  profit_cents: number
}

export interface SalesBlock {
  kpis: SalesKpis
  previous: SalesKpis
  trends: Record<string, Trend>
  sales_over_time: { bucket_start: string; revenue_cents: number; sales_count: number }[]
  sales_by_hour: { hour: number; sales_count: number; revenue_cents: number }[]
  sales_by_connection: { connection_id: string | null; connection_name: string | null; connection_number: string | null; sales_count: number; revenue_cents: number }[]
  sales_by_state: { state: string; sales_count: number; revenue_cents: number }[]
  sales_by_product: { product_id: string | null; product_name: string; sales_count: number; revenue_cents: number }[]
}

export interface DashboardResult {
  range: { start_date: string; end_date: string; time_zone: string; granularity: 'hour' | 'day' }
  previous_range: { start_date: string; end_date: string }
  cached: boolean
  computed_at: string
  sales?: SalesBlock
}

export const DEFAULT_TZ = 'America/Sao_Paulo'

export const bootstrapKey = ['dashboard', 'bootstrap'] as const
export const bootstrapQuery = (locale: string) =>
  queryOptions({
    queryKey: [...bootstrapKey, locale] as const,
    queryFn: () => api.get<Bootstrap>('/api/dashboard/bootstrap', { query: { locale: milestoneLocale(locale) } }),
    staleTime: 60_000,
  })

/** Os nomes dos marcos existem em pt-BR, en-US e es-ES. */
export const milestoneLocale = (locale: string) => (locale === 'en' ? 'en-US' : locale === 'es' ? 'es-ES' : 'pt-BR')

export const companyTzQuery = (companyId: string | null) =>
  queryOptions({
    queryKey: ['dashboard', 'company-tz', companyId] as const,
    enabled: !!companyId,
    staleTime: 5 * 60_000,
    queryFn: async () => (await api.get<{ company: { time_zone?: string | null } }>(`/api/companies/${encodeURIComponent(companyId!)}`)).company.time_zone || DEFAULT_TZ,
  })

export const dashboardKey = ['dashboard', 'data'] as const
export const dashboardQuery = (params: Record<string, string>) =>
  queryOptions({
    queryKey: [...dashboardKey, params] as const,
    queryFn: () => api.get<DashboardResult>('/api/dashboard', { query: params }),
    placeholderData: keepPreviousData,
    // Mostra o que já está em cache na hora e revalida (o servidor tem o próprio cache de 5 min).
    staleTime: 0,
  })

/** "Atualizar": recálculo no servidor (`force_refresh=1`). */
export const refreshDashboard = (params: Record<string, string>) => api.get<DashboardResult>('/api/dashboard', { query: { ...params, force_refresh: '1' } })

export const groupsApi = {
  create: (input: { name: string; connection_ids: string[]; product_ids: string[] }) => api.post('/api/sales/filter-groups', input),
  remove: (id: string) => api.delete(`/api/sales/filter-groups/${encodeURIComponent(id)}`),
}
