// Envio automático de vendas à Conversions API (T104): cada `sale.recorded` vira um job `meta-capi` que manda um
// `Purchase` (`event_id = sale-<saleId>`, `action_source: system_generated`) para os pixels da empresa com
// `auto_send_sales`. O decorator `capiSalePublisher` envolve o publisher do realtime (o mesmo que o SalesService
// já recebe) e só enfileira — o POST acontece no worker, fora da transação da venda.
// T126: quem grava a venda numa transação (o nó `approved_sale` roda dentro da transação do passo) enfileira ANTES do
// commit; o job que chega antes do commit não vê a venda e lança `SaleNotVisibleError` para o BullMQ tentar de novo.
import { and, eq } from 'drizzle-orm'
import { pixelConfigs, sales, type Database } from '@crm/db'
import type { CapiSendResult, CapiService } from './service'

export const META_CAPI_QUEUE = 'meta-capi'

export interface MetaCapiSaleJobData {
  companyId: string
  saleId: string
}

export const saleEventId = (saleId: string) => `sale-${saleId}`
export const saleJobId = (saleId: string) => `capi-sale-${saleId}`

export type CapiSaleEnqueue = (data: MetaCapiSaleJobData, opts: { jobId: string }) => Promise<void>

/** A venda do job ainda não está visível (commit pendente de quem a gravou). Retentável: o job nunca conclui sem enviar. */
export class SaleNotVisibleError extends Error {
  readonly retryable = true
  constructor(readonly saleId: string) {
    super(`meta-capi: venda ${saleId} ainda não visível (commit pendente?)`)
    this.name = 'SaleNotVisibleError'
  }
}

export const isSaleNotVisibleError = (err: unknown): err is SaleNotVisibleError => err instanceof Error && err.name === 'SaleNotVisibleError'

interface Publisher {
  publish(companyId: string, type: never, data: never, opts?: never): Promise<unknown>
}

/**
 * Publisher que, além de publicar, enfileira o envio CAPI de cada `sale.recorded`. Falha ao enfileirar só é logada
 * (não derruba o registro da venda).
 */
export function capiSalePublisher<P extends Publisher>(inner: P, deps: { enqueue: CapiSaleEnqueue; logger?: { warn(obj: object, msg?: string): void } }): P {
  const publish = async (companyId: string, type: string, data: unknown, opts?: unknown) => {
    const out = await inner.publish(companyId, type as never, data as never, opts as never)
    if (type === 'sale.recorded') {
      const saleId = (data as { sale_id?: unknown } | null)?.sale_id
      if (typeof saleId === 'string' && saleId) {
        try {
          await deps.enqueue({ companyId, saleId }, { jobId: saleJobId(saleId) })
        } catch (err) {
          deps.logger?.warn({ err, saleId }, 'falha ao enfileirar o envio CAPI da venda')
        }
      }
    }
    return out
  }
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'publish') return publish
      return Reflect.get(target, prop, receiver) as unknown
    },
  })
}

export interface CapiSaleOutcome {
  pixelConfigId: string
  result: CapiSendResult
}

/**
 * Envia o `Purchase` da venda para cada pixel com `auto_send_sales` (job `meta-capi`). Venda não aprovada: nada.
 * Venda ainda não visível: `SaleNotVisibleError` (o retry do job a encontra depois do commit; um rollback termina `failed`).
 */
export async function sendSaleToPixels(deps: { db: Database; capi: Pick<CapiService, 'send' | 'userFromContact'> }, data: MetaCapiSaleJobData): Promise<CapiSaleOutcome[]> {
  const [sale] = await deps.db
    .select()
    .from(sales)
    .where(and(eq(sales.companyId, data.companyId), eq(sales.id, data.saleId)))
    .limit(1)
  if (!sale) throw new SaleNotVisibleError(data.saleId)
  if (sale.status !== 'approved') return []
  const pixels = await deps.db
    .select({ id: pixelConfigs.id })
    .from(pixelConfigs)
    .where(and(eq(pixelConfigs.companyId, data.companyId), eq(pixelConfigs.autoSendSales, true)))
  if (!pixels.length) return []
  const user = await deps.capi.userFromContact(data.companyId, sale.contactId)
  const out: CapiSaleOutcome[] = []
  for (const p of pixels) {
    const result = await deps.capi.send({
      companyId: data.companyId,
      pixelConfigId: p.id,
      eventName: 'Purchase',
      eventId: saleEventId(sale.id),
      eventTime: sale.soldAt,
      value: sale.amountCents / 100,
      currency: sale.currency,
      user,
      actionSource: 'system_generated',
      source: 'sale',
      sourceId: sale.id,
    })
    out.push({ pixelConfigId: p.id, result })
  }
  return out
}
