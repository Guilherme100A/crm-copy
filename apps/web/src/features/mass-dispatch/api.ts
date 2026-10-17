// API dos disparos em massa (T60/T74 → T83; 10-disparos-em-massa.md §3.3, §3.4, §6): cota, lista, detalhe, criação
// (multipart com o manifesto do público como arquivo JSON) e cancelamento. Alvos do wizard: conexões conectadas e
// fluxos acionáveis. DTOs locais: a web não importa `@crm/core`.
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export const MASS_DISPATCH_STATUSES = [
  'preparing',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
] as const
export type MassDispatchStatus = (typeof MASS_DISPATCH_STATUSES)[number]

export const PREPARATION_PHASES = ['queued', 'resolving_recipients', 'counting', 'scheduling', 'completed'] as const
export type PreparationPhase = (typeof PREPARATION_PHASES)[number]

export interface PreparationProgress {
  phase?: string
  scheduled_count?: number
  target_count?: number
  [key: string]: unknown
}

export interface QuotaDto {
  limit: number
  used: number
  remaining: number
  bonus: number
  billable_slots: number
  per_instance_limit: number
  period: string
}

export interface MassDispatchTargetDto {
  id: string
  connection_id: string
  connection_name: string | null
  flow_id: string
  flow_name: string | null
  assigned_count: number
  sent_count: number
  failed_count: number
}

export interface MassDispatchDto {
  id: string
  name: string | null
  status: MassDispatchStatus
  targets: MassDispatchTargetDto[]
  flow_b_id: string | null
  flow_b_name: string | null
  weekdays: number[]
  window_start: string
  window_end: string
  time_zone: string
  interval_min_seconds: number
  interval_max_seconds: number
  daily_limit: number | null
  starts_scheduling_at: string
  total_count: number
  pending_count: number
  sent_count: number
  failed_count: number
  skipped_count: number
  cancelled_count: number
  progress_percent: number
  preparation_progress: PreparationProgress
  preparation_error: string | null
  first_sent_at: string | null
  last_sent_at: string | null
  finished_at: string | null
  created_at: string
  created_by: string | null
}

export interface PageMeta {
  page: number
  limit: number
  total_count: number | null
  total_pages?: number | null
  has_more: boolean
}

export interface MassDispatchesPage {
  items: MassDispatchDto[]
  page: PageMeta
}

export interface CreateWarning {
  code: 'only_first_n' | 'daily_limit_exceeds_warmup' | (string & {})
  message: string
  [key: string]: unknown
}

export interface CreateResult {
  mass_dispatch: MassDispatchDto
  warnings: CreateWarning[]
}

/** Conexão do seletor de alvo (`GET /api/connections?status=connected`). */
export interface TargetConnection {
  id: string
  name: string
  phone_number: string | null
  badges?: string[]
}

export interface Named {
  id: string
  name: string
}

/** A lista vem inteira numa página (limite da API: 100); os cards da visão geral contam o que foi carregado. */
export const MASS_DISPATCH_PAGE_SIZE = 100
export const MASS_DISPATCH_KEY = ['mass-dispatch'] as const
export const listKey = (page: number) => [...MASS_DISPATCH_KEY, 'list', page] as const
export const quotaKey = [...MASS_DISPATCH_KEY, 'quota'] as const
export const detailKey = (id: string) => [...MASS_DISPATCH_KEY, 'detail', id] as const

const enc = encodeURIComponent
const base = (id: string) => `/api/mass-dispatches/${enc(id)}`

export const massDispatchListQuery = (page: number) =>
  queryOptions({
    queryKey: listKey(page),
    queryFn: () =>
      api.get<MassDispatchesPage>('/api/mass-dispatches', { query: { page, limit: MASS_DISPATCH_PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  })

export const quotaQuery = () =>
  queryOptions({
    queryKey: quotaKey,
    queryFn: async () =>
      (await api.get<{ mass_dispatch_quota: QuotaDto }>('/api/mass-dispatches/quota')).mass_dispatch_quota,
  })

export const massDispatchQuery = (id: string) =>
  queryOptions({
    queryKey: detailKey(id),
    queryFn: async () => (await api.get<{ mass_dispatch: MassDispatchDto }>(base(id))).mass_dispatch,
  })

export const targetConnectionsQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: [...MASS_DISPATCH_KEY, 'connections'],
    queryFn: async () =>
      (
        await api.get<{ items: TargetConnection[] }>('/api/connections', {
          query: { status: 'connected', page: 1, limit: 100 },
        })
      ).items,
    enabled,
  })

export const triggerableFlowsQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: [...MASS_DISPATCH_KEY, 'flows'],
    queryFn: async () => (await api.get<{ items: Named[] }>('/api/flows/names', { query: { triggerable: 1 } })).items,
    enabled,
  })

/** Total de contatos da empresa (para "Todos os contatos" no passo Público). */
export const contactsTotalQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: [...MASS_DISPATCH_KEY, 'contacts-total'],
    queryFn: async () =>
      (await api.get<{ page: PageMeta }>('/api/contacts', { query: { page: 1, limit: 1 } })).page.total_count,
    enabled,
  })

export const massDispatchApi = {
  create: (body: FormData) => api.post<CreateResult>('/api/mass-dispatches', body),
  cancel: (id: string) => api.post<{ mass_dispatch: MassDispatchDto; released_count: number }>(`${base(id)}/cancel`),
}
