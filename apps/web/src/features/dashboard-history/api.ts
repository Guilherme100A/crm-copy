// Vendas (T34): `GET /api/sales` paginado (20 por página, `sold_at desc, id desc`, `skip_total=1` na rolagem infinita)
// com os filtros do dashboard, e `POST /api/sales` (perm `sales.edit`) para a venda manual.
import { infiniteQueryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export interface SaleDto {
  id: string
  amount_cents: number
  currency: string
  sold_at: string
  status: string
  source: string
  external_id: string | null
  source_id: string | null
  ctwa_clid: string | null
  contact_id: string | null
  connection_id: string | null
  product_id: string | null
  product_name: string | null
  instance_name: string | null
  instance_number: string | null
  lead_number: string | null
  customer_name: string | null
  note_issuer_id: string | null
  utmify_integration_id: string | null
  created_at: string
  updated_at: string
}

export interface SalesPage {
  items: SaleDto[]
  page: { page: number; limit: number; has_more: boolean; total_count?: number; total_pages?: number }
}

export interface SaleInput {
  amount_cents: number
  currency: string
  sold_at: string
  product_id: string | null
  source_id: string | null
  instance_name: string | null
  instance_number: string | null
  lead_number: string | null
  customer_name: string | null
}

export const PAGE_SIZE = 20

export const salesHistoryKey = ['dashboard', 'sales-history'] as const
export const salesHistoryQuery = (params: Record<string, string>) =>
  infiniteQueryOptions({
    queryKey: [...salesHistoryKey, params] as const,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api.get<SalesPage>('/api/sales', { query: { ...params, page: pageParam, limit: PAGE_SIZE, skip_total: '1' } }),
    getNextPageParam: (last) => (last.page.has_more ? last.page.page + 1 : undefined),
    staleTime: 30_000,
  })

export const createSale = (input: SaleInput) => api.post<{ sale: SaleDto; created: boolean }>('/api/sales', { sale: input })
