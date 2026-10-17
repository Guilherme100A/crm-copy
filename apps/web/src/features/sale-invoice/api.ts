// Status da NF e do envio à UTMify por venda (T112/T113; 19 §4.2, §5.4) para o histórico de vendas (T87): as células
// pedem o status da própria venda e um agrupador junta os pedidos do mesmo instante num só
// `GET /api/sale-invoices?sale_ids=` / `GET /api/sale-utmify?sale_ids=` (até 200 ids). Reemissão:
// `POST /api/sales/:id/reemit-invoice { invoice_integration_id? }` → 202 com a mensagem do servidor.
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'

export type InvoiceEmitStatus = 'pending' | 'succeeded' | 'failed'

export interface SaleInvoiceDto {
  sale_id: string
  /** `null` = "Sem emissor". */
  invoice_emit_status: InvoiceEmitStatus | null
  invoice_last_error: string | null
  invoice_integration_id: string | null
  attempts: number
  external_id?: string | null
  number: string | null
  pdf_url: string | null
  requested_at?: string | null
  succeeded_at?: string | null
  updated_at?: string | null
  /** Reemissão permitida (status ≠ pending e ≠ succeeded). */
  can_reemit: boolean
}

export type UtmifySendStatus = 'pending' | 'succeeded' | 'failed'

export interface SaleUtmifyDto {
  sale_id: string
  utmify_integration_id: string | null
  utmify_status: UtmifySendStatus | null
  utmify_last_error: string | null
}

export interface ReemitResponse {
  invoice: SaleInvoiceDto
  message: string
}

export const SALE_INVOICE_KEY = ['sale-invoice'] as const
export const SALE_UTMIFY_KEY = ['sale-utmify'] as const

/** Máximo de ids por chamada (o servidor corta em 200). */
export const BATCH_MAX = 200

interface Waiter<T> {
  resolve: (v: T | null) => void
  reject: (e: unknown) => void
}

/** Junta os `load(id)` feitos dentro de `delayMs` numa chamada por lote de até `max` ids; id sem item → `null`. */
export function createBatcher<T>(
  fetchMany: (ids: string[]) => Promise<T[]>,
  idOf: (item: T) => string,
  { max = BATCH_MAX, delayMs = 10 } = {},
) {
  let pending = new Map<string, Waiter<T>[]>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = async () => {
    timer = null
    const batch = pending
    pending = new Map()
    const ids = [...batch.keys()]
    for (let i = 0; i < ids.length; i += max) {
      const chunk = ids.slice(i, i + max)
      try {
        const items = await fetchMany(chunk)
        const byId = new Map(items.map((x) => [idOf(x), x]))
        for (const id of chunk) for (const w of batch.get(id) ?? []) w.resolve(byId.get(id) ?? null)
      } catch (err) {
        for (const id of chunk) for (const w of batch.get(id) ?? []) w.reject(err)
      }
    }
  }
  return {
    load(id: string): Promise<T | null> {
      return new Promise<T | null>((resolve, reject) => {
        const list = pending.get(id) ?? []
        list.push({ resolve, reject })
        pending.set(id, list)
        timer ??= setTimeout(() => void flush(), delayMs)
      })
    },
  }
}

const invoices = createBatcher(
  async (ids) =>
    (await api.get<{ items: SaleInvoiceDto[] }>('/api/sale-invoices', { query: { sale_ids: ids.join(',') } })).items,
  (x) => x.sale_id,
)
const utmify = createBatcher(
  async (ids) =>
    (await api.get<{ items: SaleUtmifyDto[] }>('/api/sale-utmify', { query: { sale_ids: ids.join(',') } })).items,
  (x) => x.sale_id,
)

/** Enquanto a emissão está `pending`, consulta de novo (cobre o SSE que ainda não ouvia `sale.updated`). */
export const PENDING_POLL_MS = 4_000

export const saleInvoiceQuery = (saleId: string) =>
  queryOptions({
    queryKey: [...SALE_INVOICE_KEY, saleId] as const,
    queryFn: () => invoices.load(saleId),
    staleTime: 30_000,
    refetchInterval: (q) => (q.state.data?.invoice_emit_status === 'pending' ? PENDING_POLL_MS : false),
  })

export const saleUtmifyQuery = (saleId: string) =>
  queryOptions({
    queryKey: [...SALE_UTMIFY_KEY, saleId] as const,
    queryFn: () => utmify.load(saleId),
    staleTime: 30_000,
    refetchInterval: (q) => (q.state.data?.utmify_status === 'pending' ? PENDING_POLL_MS : false),
  })

export const reemitInvoice = (saleId: string, invoiceIntegrationId?: string) =>
  api.post<ReemitResponse>(
    `/api/sales/${encodeURIComponent(saleId)}/reemit-invoice`,
    invoiceIntegrationId ? { invoice_integration_id: invoiceIntegrationId } : {},
  )
