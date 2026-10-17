// API do admin interno (T95, T96, T37 e o upload da T100): DTOs locais (a web não importa `@crm/core`) e queries.
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'
import type { PageMeta } from '@/features/settings-quick-replies/kit'
import { ADMIN_PAGE_SIZE, type AnnouncementType, type CreditsMode, type UserRole } from './rules'

export interface AdminUserDto {
  id: string
  name: string
  email: string
  system_role: 'user' | 'platform_admin' | 'support'
  role: UserRole
  role_label: string
  personal_whatsapp: string | null
  locale: string | null
  last_company_id: string | null
  companies_count: number
  created_at: string
  updated_at: string
}

export interface AdminUserCompanyDto {
  account_id: string
  account_name: string
  role: string
  role_label: string
  active: boolean
}

export interface AdminCompanyDto {
  id: string
  name: string
  active: boolean
  owner: { id: string; name: string; email: string } | null
  owner_email: string | null
  users_count: number
  created_at: string
}

export interface AdminStatisticsDto {
  start_date: string
  end_date: string
  time_zone: string
  new_companies: number
  new_users: number
  totals: { companies: number; active_companies: number; users: number; connections: number; connected_connections: number }
  messages: { total: number; inbound: number; outbound: number }
  messages_per_day: { date: string; total: number; inbound: number; outbound: number }[]
}

export interface AnnouncementDto {
  id: string
  title: string
  message: string
  image_url: string | null
  url: string | null
  announcement_type: AnnouncementType
  priority: number
  expires_at: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface BannerDto {
  id: string
  title: string | null
  image_url: string
  url: string | null
  priority: number
  expires_at: string | null
  active: boolean
  created_at: string
  updated_at: string
}

type HealthStatus = 'ok' | 'down'
export interface InfraHealthDto {
  status: 'ok' | 'degraded'
  checked_at: string
  queue_prefix: string
  queues: {
    name: string
    status: HealthStatus
    waiting: number | null
    active: number | null
    failed: number | null
    delayed: number | null
    paused: number | null
    is_paused: boolean | null
    error?: string
  }[]
  redis: { status: HealthStatus; used_memory_human: string | null; error?: string }
  postgres: { status: HealthStatus; connections: number | null; max_connections: number | null; database_size_bytes: number | null; error?: string }
  wa_events: { status: HealthStatus; stream: string; group: string; exists: boolean; lag: number | null; pending: number | null; consumers: number | null; error?: string }
}

export interface AdminWaSessionDto {
  id: string
  name: string
  phone: string | null
  state: string
  requires_restart: boolean
  last_connected_at: string | null
  connection: { id: string; name: string; connection_state: string | null; scheduled_for_deletion: boolean } | null
  company: { id: string; name: string; active: boolean } | null
}

export interface AiUsageItem {
  company_id: string
  company_name: string
  provider: string
  model: string
  count: number
  input_tokens: number
  output_tokens: number
  cost_micros: number
  billed_micros: number
  credits: number
}

export interface AiUsageDto {
  from: string | null
  to: string | null
  items: AiUsageItem[]
  totals: Omit<AiUsageItem, 'company_id' | 'company_name' | 'provider' | 'model'>
}

export interface AiWalletDto {
  company_id: string
  company_name: string
  balance_credits: number
  status: string
  updated_at: string
}

export const ADMIN_KEY = ['admin'] as const
const enc = encodeURIComponent
const page = (p: number, search: string) => ({ page: p, limit: ADMIN_PAGE_SIZE, search: search || undefined })

export const adminUsersQuery = (p: number, search: string) =>
  queryOptions({
    queryKey: [...ADMIN_KEY, 'users', p, search] as const,
    queryFn: () => api.get<{ items: AdminUserDto[]; page: PageMeta }>('/api/admin/users', { query: page(p, search) }),
    placeholderData: keepPreviousData,
  })

export const adminUserCompaniesQuery = (id: string) =>
  queryOptions({
    queryKey: [...ADMIN_KEY, 'users', 'companies', id] as const,
    queryFn: async () => (await api.get<{ items: AdminUserCompanyDto[] }>(`/api/admin/users/${enc(id)}/companies`)).items,
  })

export const adminCompaniesQuery = (p: number, search: string) =>
  queryOptions({
    queryKey: [...ADMIN_KEY, 'companies', p, search] as const,
    queryFn: () => api.get<{ items: AdminCompanyDto[]; page: PageMeta }>('/api/admin/companies', { query: page(p, search) }),
    placeholderData: keepPreviousData,
  })

export const adminStatisticsQuery = (start: string, end: string) =>
  queryOptions({
    queryKey: [...ADMIN_KEY, 'statistics', start, end] as const,
    queryFn: async () =>
      (await api.get<{ statistics: AdminStatisticsDto }>('/api/admin/statistics', { query: { start_date: start || undefined, end_date: end || undefined } }))
        .statistics,
    placeholderData: keepPreviousData,
  })

export const adminAnnouncementsQuery = (p: number, search: string) =>
  queryOptions({
    queryKey: [...ADMIN_KEY, 'announcements', p, search] as const,
    queryFn: () => api.get<{ items: AnnouncementDto[]; page: PageMeta }>('/api/admin/announcements', { query: page(p, search) }),
    placeholderData: keepPreviousData,
  })

export const adminBannersQuery = (p: number, search: string) =>
  queryOptions({
    queryKey: [...ADMIN_KEY, 'banners', p, search] as const,
    queryFn: () => api.get<{ items: BannerDto[]; page: PageMeta }>('/api/admin/banners', { query: page(p, search) }),
    placeholderData: keepPreviousData,
  })

export const adminHealthQuery = () =>
  queryOptions({
    queryKey: [...ADMIN_KEY, 'health'] as const,
    queryFn: () => api.get<InfraHealthDto>('/api/admin/health'),
  })

/** Também é a sonda do modo extensão: 404 = aba Sessões escondida (sem repetir). */
export const adminWaSessionsQuery = () =>
  queryOptions({
    queryKey: [...ADMIN_KEY, 'wa-sessions'] as const,
    queryFn: () => api.get<{ profile: string; items: AdminWaSessionDto[]; total: number }>('/api/admin/wa/sessions'),
    retry: false,
  })

export const adminAiUsageQuery = (from: string | null, to: string | null) =>
  queryOptions({
    queryKey: [...ADMIN_KEY, 'ai-usage', from, to] as const,
    queryFn: () => api.get<AiUsageDto>('/api/admin/ai/usage', { query: { from: from ?? undefined, to: to ?? undefined } }),
    placeholderData: keepPreviousData,
  })

export const adminAiWalletsQuery = () =>
  queryOptions({
    queryKey: [...ADMIN_KEY, 'ai-wallets'] as const,
    queryFn: async () => (await api.get<{ items: AiWalletDto[] }>('/api/platform/ai/wallets')).items,
  })

/** Avisos ativos do app do cliente (pop-up). */
export const clientAnnouncementsQuery = (companyId: string) =>
  queryOptions({
    queryKey: ['announcements', companyId] as const,
    queryFn: async () => (await api.get<{ items: AnnouncementDto[] }>('/api/announcements')).items,
    staleTime: 5 * 60_000,
    retry: false,
  })

export const adminApi = {
  createUser: async (body: Record<string, unknown>) => (await api.post<{ user: AdminUserDto }>('/api/admin/users', body)).user,
  updateUser: async (id: string, body: Record<string, unknown>) => (await api.put<{ user: AdminUserDto }>(`/api/admin/users/${enc(id)}`, body)).user,
  setCompanyActive: (id: string, active: boolean) => api.patch(`/api/admin/companies/${enc(id)}`, { active }),
  createAnnouncement: (body: Record<string, unknown>) => api.post('/api/admin/announcements', body),
  updateAnnouncement: (id: string, body: Record<string, unknown>) => api.patch(`/api/admin/announcements/${enc(id)}`, body),
  deleteAnnouncement: (id: string) => api.delete(`/api/admin/announcements/${enc(id)}`),
  createBanner: (body: Record<string, unknown>) => api.post('/api/admin/banners', body),
  updateBanner: (id: string, body: Record<string, unknown>) => api.patch(`/api/admin/banners/${enc(id)}`, body),
  deleteBanner: (id: string) => api.delete(`/api/admin/banners/${enc(id)}`),
  /** Imagem global (aviso/banner) → URL pública. */
  upload: async (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return (await api.post<{ url: string }>('/api/admin/uploads', form)).url
  },
  credits: (companyId: string, mode: CreditsMode, credits: number, note: string) =>
    api.post(`/api/platform/companies/${enc(companyId)}/ai/${mode === 'topup' ? 'topups' : 'adjustments'}`, { credits, note }),
}
