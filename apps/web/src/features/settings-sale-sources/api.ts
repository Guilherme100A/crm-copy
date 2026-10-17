// API das fontes de venda (T73): CRUD, teste do mapeamento (dry-run), rotação do token, log de eventos e replay. DTOs
// locais: a web não importa `@crm/core`. O segredo HMAC é só de escrita (o DTO traz apenas `hmac_configured`).
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'
import type { AmountUnit, InboundEventStatus, SaleEventField, SaleEventStatus } from './rules'

export interface SaleSourceDto {
  id: string
  name: string
  active: boolean
  token: string
  public_url: string
  hmac_configured: boolean
  mapping: Partial<Record<SaleEventField, string>>
  status_map: Record<string, SaleEventStatus>
  amount_unit: AmountUnit
  created_at: string
  updated_at: string
}

export interface SaleEvent {
  external_id: string
  status: SaleEventStatus
  amount_cents: number
  currency: string
  sold_at: string | null
  customer: { phone: string; name: string | null; email: string | null }
  product_id: string | null
  attribution: Record<string, string | null>
}

export type TestResult =
  { ok: true; event: SaleEvent } | { ok: false; missing: { field: string; path: string }[]; errors: string[] }

export interface InboundSaleEventDto {
  id: string
  sale_source_id: string
  status: InboundEventStatus
  raw_body: string
  sale_event: SaleEvent | null
  error: string | null
  missing: { field: string; path: string }[]
  sale_id: string | null
  contact_id: string | null
  attempts: number
  processed_at: string | null
  created_at: string
  updated_at: string
}

export interface SaleSourceInput {
  name?: string
  active?: boolean
  hmac_secret?: string | null
  mapping?: Record<string, string>
  status_map?: Record<string, SaleEventStatus>
  amount_unit?: AmountUnit
}

export interface TestInput {
  sample: string
  mapping?: Record<string, string>
  status_map?: Record<string, SaleEventStatus>
  amount_unit?: AmountUnit
}

export const SALE_SOURCES_KEY = ['settings-sale-sources'] as const
export const EVENTS_PAGE_SIZE = 20
const enc = encodeURIComponent

export const saleSourcesQuery = () =>
  queryOptions({
    queryKey: [...SALE_SOURCES_KEY, 'list'] as const,
    queryFn: async () => (await api.get<{ items: SaleSourceDto[] }>('/api/sale-sources')).items,
  })

export const saleSourceQuery = (id: string) =>
  queryOptions({
    queryKey: [...SALE_SOURCES_KEY, 'detail', id] as const,
    queryFn: async () => (await api.get<{ sale_source: SaleSourceDto }>(`/api/sale-sources/${enc(id)}`)).sale_source,
  })

export const saleEventsQuery = (id: string, status: InboundEventStatus | '', page: number) =>
  queryOptions({
    queryKey: [...SALE_SOURCES_KEY, 'events', id, status, page] as const,
    queryFn: () =>
      api.get<{ items: InboundSaleEventDto[]; total: number; page: number; limit: number }>(
        `/api/sale-sources/${enc(id)}/events`,
        {
          query: { status: status || undefined, page, limit: EVENTS_PAGE_SIZE },
        },
      ),
    placeholderData: keepPreviousData,
  })

export const saleSourcesApi = {
  create: async (input: SaleSourceInput) =>
    (await api.post<{ sale_source: SaleSourceDto }>('/api/sale-sources', input)).sale_source,
  update: async (id: string, input: SaleSourceInput) =>
    (await api.patch<{ sale_source: SaleSourceDto }>(`/api/sale-sources/${enc(id)}`, input)).sale_source,
  remove: (id: string) => api.delete(`/api/sale-sources/${enc(id)}`),
  test: (id: string, input: TestInput) => api.post<TestResult>(`/api/sale-sources/${enc(id)}/test`, input),
  rotateToken: async (id: string) =>
    (await api.post<{ sale_source: SaleSourceDto }>(`/api/sale-sources/${enc(id)}/rotate-token`)).sale_source,
  replay: async (id: string, eventId: string) =>
    (await api.post<{ event: InboundSaleEventDto }>(`/api/sale-sources/${enc(id)}/events/${enc(eventId)}/replay`))
      .event,
}
