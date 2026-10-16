// Ações do kanban fora do arrasto (T76 sobre a T50/T27): quadros e colunas (criar/editar/excluir), chats disponíveis
// para um card novo, funil (`/stats`) e exportação dos leads (job `kanban_cards`).
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'
import type { BoardDto, CardDto, ColumnDto } from '@/features/crms/api'
import { toQuery, type ApiFilters } from './filters'

const enc = encodeURIComponent

/** 8 cores do modal de coluna (04 §2 "Modal Nova/Editar coluna"); `null` = Automático (cor pela posição). */
export const COLUMN_COLORS = ['#3B82F6', '#8B5CF6', '#F59E0B', '#10B981', '#EC4899', '#06B6D4', '#F97316', '#84CC16'] as const

export interface ColumnInput {
  name: string
  accent_color: string | null
  conversion_goal: boolean
}

export const boardApi = {
  create: async (name: string) => (await api.post<{ crm: BoardDto }>('/api/crms', { name })).crm,
  rename: async (id: string, name: string) => (await api.patch<{ crm: BoardDto }>(`/api/crms/${enc(id)}`, { name })).crm,
  remove: (id: string) => api.delete(`/api/crms/${enc(id)}`),
}

export const columnApi = {
  create: async (crmId: string, input: ColumnInput) => (await api.post<{ column: ColumnDto }>(`/api/crms/${enc(crmId)}/columns`, input)).column,
  update: async (crmId: string, columnId: string, input: Partial<ColumnInput>) =>
    (await api.patch<{ column: ColumnDto }>(`/api/crms/${enc(crmId)}/columns/${enc(columnId)}`, input)).column,
  remove: (crmId: string, columnId: string) => api.delete(`/api/crms/${enc(crmId)}/columns/${enc(columnId)}`),
}

export interface AvailableChat {
  id: string
  customer_name: string
  customer_phone: string | null
  status: string
  unread_count: number
  last_message_preview: string | null
}

export interface AvailablePage {
  items: AvailableChat[]
  page: { page: number; limit: number; total_count: number; has_more: boolean }
}

export const AVAILABLE_PAGE_SIZE = 20

export const availableChats = (crmId: string, search: string, page: number) =>
  api.get<AvailablePage>(`/api/crms/${enc(crmId)}/available-chats`, { query: { search: search.trim() || undefined, page, limit: AVAILABLE_PAGE_SIZE } })

export const createCard = async (crmId: string, chatId: string, columnId: string) =>
  (await api.post<{ card: CardDto }>(`/api/crms/${enc(crmId)}/cards`, { chat_id: chatId, column_id: columnId })).card

export interface FunnelStage {
  column_id: string
  name: string
  position: number
  column_count: number
  count: number
  conversion_rate_from_previous: number | null
  wave_progress_percent: number
  total_value_cents: number
}

export interface FunnelStats {
  total_cards: number
  stages: FunnelStage[]
  conversion_count: number
  conversion_rate: number
  totals: { total_leads: number; overall_conversion_rate: number; total_purchases: number; total_revenue_cents: number }
}

export const statsKey = (crmId: string) => ['crms', 'stats', crmId] as const

export const statsQuery = (crmId: string, filters: ApiFilters) =>
  queryOptions({
    queryKey: [...statsKey(crmId), filters] as const,
    queryFn: () => api.get<FunnelStats>(`/api/crms/${enc(crmId)}/stats`, { query: toQuery(filters) }),
  })

export const KANBAN_EXPORT_KIND = 'kanban_cards'

export interface JobDto {
  id: string
  kind: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  progress: { processed: number; total: number | null; percent: number | null }
  row_count: number | null
  error: string | null
  file_name: string | null
  download_url: string | null
}

export const exportApi = {
  start: async (crmId: string, filters: ApiFilters) => (await api.post<{ job: JobDto }>('/api/jobs', { kind: KANBAN_EXPORT_KIND, filters: { crm_id: crmId, ...filters } })).job,
  get: async (id: string) => (await api.get<{ job: JobDto }>(`/api/jobs/${enc(id)}`)).job,
}

export const fileUrl = (jobId: string) => `/api/jobs/${enc(jobId)}/file`

/** Junta um `job.progress` do SSE ao job conhecido (o evento pode chegar fora de ordem: estado final não regride). */
export function mergeJobProgress(job: JobDto, ev: Partial<JobDto> & { job_id?: string }): JobDto {
  if (ev.job_id && ev.job_id !== job.id) return job
  if (job.status === 'completed' || job.status === 'failed') return job
  return {
    ...job,
    status: ev.status ?? job.status,
    progress: ev.progress ? { ...job.progress, ...ev.progress } : job.progress,
    row_count: ev.row_count ?? job.row_count,
    error: ev.error ?? job.error,
  }
}
