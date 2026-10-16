// API dos webhooks de entrada (T72/T81): CRUD, histórico de requests e a escuta de exemplo (90 s).
import { queryOptions } from '@tanstack/react-query'
import { api, HttpError } from '@/lib/http'

export type RequestStatus = 'pending' | 'processed' | 'failed' | 'skipped'
export const REQUEST_STATUSES: readonly RequestStatus[] = ['processed', 'failed', 'pending', 'skipped']

export interface WebhookDto {
  id: string
  name: string
  connection_id: string | null
  active: boolean
  public_token: string
  public_receive_url: string
  config: Record<string, unknown>
  month_count: number
  request_stats: { total: number; processed: number; failed: number; pending: number; skipped: number; retention_max: number }
  last_inbound_webhook_request: { id: string; raw_body: string; raw_body_truncated: boolean; created_at: string } | null
  created_at: string
  updated_at: string
}

export interface WebhookRequestDto {
  id: string
  webhook_id: string
  processing_status: RequestStatus
  raw_body: string
  raw_body_truncated: boolean
  content_type: string | null
  steps: { step: string; status: 'ok' | 'failed' | 'skipped'; reason?: string }[]
  error: string | null
  reason: string | null
  created_at: string
  processed_at: string | null
}

export interface WebhookInput {
  name?: string
  connection_id?: string | null
  active?: boolean
  config?: Record<string, unknown>
}

const enc = encodeURIComponent
export const WEBHOOKS_KEY = ['inbound-webhooks'] as const
export const webhookKey = (id: string) => [...WEBHOOKS_KEY, 'one', id] as const
export const REQUESTS_PAGE = 50

export const webhooksQuery = () =>
  queryOptions({
    queryKey: [...WEBHOOKS_KEY, 'list'] as const,
    queryFn: () => api.get<{ items: WebhookDto[]; usage: { used: number; limit: number } }>('/api/inbound-webhooks'),
  })

export const webhookQuery = (id: string) =>
  queryOptions({ queryKey: webhookKey(id), queryFn: async () => (await api.get<{ webhook: WebhookDto }>(`/api/inbound-webhooks/${enc(id)}`)).webhook })

/** Conexões para o select (sem `connections.view` a lista fica vazia). */
export const connectionsQuery = () =>
  queryOptions({
    queryKey: [...WEBHOOKS_KEY, 'connections'] as const,
    staleTime: 60_000,
    queryFn: async () => {
      try {
        return (await api.get<{ items: { id: string; name: string }[] }>('/api/connections', { query: { limit: 100 } })).items
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return []
        throw err
      }
    },
  })

export const webhooksApi = {
  create: async (input: WebhookInput) => (await api.post<{ webhook: WebhookDto }>('/api/inbound-webhooks', input)).webhook,
  update: async (id: string, input: WebhookInput) => (await api.patch<{ webhook: WebhookDto }>(`/api/inbound-webhooks/${enc(id)}`, input)).webhook,
  remove: (id: string) => api.delete(`/api/inbound-webhooks/${enc(id)}`),
  requests: (id: string, page: number) =>
    api.get<{ items: WebhookRequestDto[]; page: { page: number; limit: number; total_count: number; has_more: boolean } }>(`/api/inbound-webhooks/${enc(id)}/requests`, {
      query: { page, limit: REQUESTS_PAGE },
    }),
  listen: async (id: string) => api.post<{ listening: boolean; expires_at: string }>(`/api/inbound-webhooks/${enc(id)}/sample-listen`),
  stopListening: (id: string) => api.delete(`/api/inbound-webhooks/${enc(id)}/sample-listen`),
}
