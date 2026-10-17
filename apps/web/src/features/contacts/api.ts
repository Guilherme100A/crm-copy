// API da página de contatos (05 §6; T26/T66/T67): listagem paginada com filtros, catálogos dos filtros (etiquetas,
// etapas do kanban, campos personalizados), conexões (Importar do WhatsApp) e os jobs de exportação/exclusão em massa.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { activeCompany, api, HttpError } from '@/lib/http'
import type { ApiFilters } from './filters'
import { apiUrl } from '@/lib/base'

export const PAGE_SIZE = 20

export interface ContactLabel {
  id: string
  name: string
  color: string | null
}

export interface ContactDto {
  id: string
  name: string
  phone_e164: string | null
  wa_lid: string | null
  email: string | null
  labels: ContactLabel[]
  created_at: string
}

export interface ContactsPage {
  items: ContactDto[]
  page: { page: number; limit: number; total_count: number | null; total_pages: number | null; has_more: boolean }
}

export interface JobDto {
  id: string
  kind: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  progress: { processed: number; total: number | null; percent: number | null; [k: string]: unknown }
  row_count: number | null
  counters: Record<string, unknown>
  error: string | null
  file_name: string | null
  download_url: string | null
}

export interface BoardDto {
  id: string
  name: string
  columns: { id: string; name: string; color?: string | null }[]
}

export interface ConnectionDto {
  id: string
  name: string
  status: string
}

export interface WhatsAppImportResult {
  imported: number
  updated: number
  skipped: number
  [k: string]: unknown
}

const enc = encodeURIComponent

export const CONTACTS_KEY = ['contacts'] as const
export const contactsListKey = (companyId: string | null, filters: ApiFilters) => [...CONTACTS_KEY, 'list', companyId, filters] as const

const emptyPage = (page: number): ContactsPage => ({ items: [], page: { page, limit: PAGE_SIZE, total_count: 0, total_pages: 0, has_more: false } })

/**
 * Lista paginada. Com filtro ativo pede `skip_total_count=1` (como a referência: a contagem fica "N+"; o total do
 * filtro sai de `contactsCountQuery` quando a seleção precisa dele). Cache por empresa: durante a troca de empresa a
 * chave da empresa anterior não vai à rede com o header da nova (filtros antigos nunca saem com a empresa nova).
 */
export function contactsListQuery(companyId: string | null, filters: ApiFilters) {
  const skip = Object.keys(filters).length > 0
  return infiniteQueryOptions({
    queryKey: contactsListKey(companyId, filters),
    queryFn: ({ pageParam, signal }) =>
      companyId !== activeCompany()
        ? Promise.resolve(emptyPage(pageParam))
        : api.get<ContactsPage>('/api/contacts', { query: { ...filters, page: pageParam, limit: PAGE_SIZE, ...(skip ? { skip_total_count: 1 } : {}) }, signal }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page.has_more ? last.page.page + 1 : undefined),
    // Voltar a um filtro já visto (ex.: limpar a busca) consulta de novo; o cache só evita a tela vazia.
    staleTime: 0,
  })
}

/** Total exato do filtro (para "Todos do filtro ({n})" e a contagem efetiva da seleção). */
export const contactsCountQuery = (companyId: string | null, filters: ApiFilters) =>
  queryOptions({
    queryKey: [...CONTACTS_KEY, 'count', companyId, filters] as const,
    queryFn: async () => (await api.get<ContactsPage>('/api/contacts', { query: { ...filters, page: 1, limit: 1 } })).page.total_count,
    staleTime: 10_000,
  })

/** Catálogo opcional: sem a permissão (403) o filtro correspondente fica vazio. */
async function optional<T>(fn: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) return empty
    throw err
  }
}

export const labelsQuery = () =>
  queryOptions({
    queryKey: [...CONTACTS_KEY, 'labels'] as const,
    queryFn: () => optional(async () => (await api.get<{ items: ContactLabel[] }>('/api/labels')).items, [] as ContactLabel[]),
    staleTime: 60_000,
  })

export const boardsQuery = () =>
  queryOptions({
    queryKey: [...CONTACTS_KEY, 'boards'] as const,
    queryFn: () => optional(async () => (await api.get<{ items: BoardDto[] }>('/api/crms')).items, [] as BoardDto[]),
    staleTime: 60_000,
  })

export const customFieldKeysQuery = () =>
  queryOptions({
    queryKey: [...CONTACTS_KEY, 'custom-field-keys'] as const,
    queryFn: () => optional(async () => (await api.get<{ items: { key: string }[] }>('/api/custom-fields')).items.map((f) => f.key), [] as string[]),
    staleTime: 60_000,
  })

/** Conexões da empresa (sem `connections.view` não há botão de importar). */
export const connectionsQuery = () =>
  queryOptions({
    queryKey: [...CONTACTS_KEY, 'connections'] as const,
    queryFn: () => optional(async () => (await api.get<{ items: ConnectionDto[] }>('/api/connections', { query: { limit: 100 } })).items, [] as ConnectionDto[]),
    staleTime: 15_000,
  })

/** Primeira conexão `connected` (05 §5 nº 20). */
export const firstConnected = (conns: readonly ConnectionDto[] | undefined) => conns?.find((c) => c.status === 'connected') ?? null

export const jobKey = (kind: 'export' | 'bulk-delete', id: string) => [...CONTACTS_KEY, 'job', kind, id] as const

export const contactsApi = {
  startExport: async (body: Record<string, unknown>) => (await api.post<{ job: JobDto }>('/api/contacts/exports', body)).job,
  getExport: async (id: string) => (await api.get<{ job: JobDto }>(`/api/contacts/exports/${enc(id)}`)).job,
  /** Manifesto como arquivo no multipart `manifest` (05 §3.7). */
  startBulkDelete: async (manifest: Record<string, unknown>, now = Date.now()) => {
    const form = new FormData()
    form.append('manifest', new Blob([JSON.stringify(manifest)], { type: 'application/json' }), `customers-bulk-delete-${now}.json`)
    return (await api.post<{ job: JobDto }>('/api/contacts/bulk-deletes', form)).job
  },
  getBulkDelete: async (id: string) => (await api.get<{ job: JobDto }>(`/api/contacts/bulk-deletes/${enc(id)}`)).job,
  importFromWhatsApp: (connectionId: string) => api.post<WhatsAppImportResult>('/api/contacts/import-from-whatsapp', { connection_id: connectionId }),
}

export const jobFileUrl = (job: JobDto) => apiUrl(job.download_url ?? `/api/jobs/${enc(job.id)}/file`)

export const jobDone = (j: JobDto | undefined) => j?.status === 'completed' || j?.status === 'failed'

/** Evento `job.progress` sobre o job em cache (terminado não regride). */
export function mergeJobProgress(job: JobDto, ev: Partial<JobDto> & { job_id?: string }): JobDto {
  if (ev.job_id && ev.job_id !== job.id) return job
  if (jobDone(job)) return job
  return {
    ...job,
    status: ev.status ?? job.status,
    progress: ev.progress ? { ...job.progress, ...ev.progress } : job.progress,
    row_count: ev.row_count ?? job.row_count,
    error: ev.error ?? job.error,
  }
}

/** Percentual exibido (0–100) ou `null` quando o total ainda é desconhecido. */
export function jobPercent(job: JobDto): number | null {
  if (job.status === 'completed') return 100
  if (job.progress.percent !== null && job.progress.percent !== undefined) return Math.max(0, Math.min(100, Math.round(job.progress.percent)))
  const { processed, total } = job.progress
  return total ? Math.max(0, Math.min(100, Math.round((processed / total) * 100))) : null
}
