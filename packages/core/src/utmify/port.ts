// Porta de rastreamento de vendas (T113; 11-facebook-ads.md §3.6, §3.7). O job `utmify` só conversa com `SalesTracker`;
// o adapter UTMify (`./adapter`) é o único provedor. `pushSale` envia a venda com o status atual (aprovada ou
// reembolsada) e a atribuição do contato; reenviar o mesmo pedido com outro status atualiza o pedido no provedor.

export type TrackedSaleStatus = 'approved' | 'refunded'

/** Venda enviada ao rastreador (centavos + moeda ISO, SPEC 3.6). */
export interface TrackedSale {
  id: string
  status: TrackedSaleStatus
  amount_cents: number
  currency: string
  /** ISO 8601: data da venda (a mesma em todos os envios do pedido). */
  sold_at: string
  /** ISO 8601 ou `null` (venda ainda não paga). */
  approved_at: string | null
  /** ISO 8601 ou `null` (não reembolsada). */
  refunded_at: string | null
  customer: TrackedCustomer
  product: TrackedProduct | null
}

export interface TrackedCustomer {
  name: string | null
  email: string | null
  /** E.164 (`+5511…`) quando houver. */
  phone: string | null
}

export interface TrackedProduct {
  id: string | null
  name: string
}

/** Atribuição do contato (último toque de `crm.contact_attribution`, T73) e dados do anúncio de clique (CTWA). */
export interface SaleAttribution {
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  /** Id do anúncio Meta (cruzamento venda ↔ anúncio). */
  source_id: string | null
  /** Click-to-WhatsApp click id. */
  ctwa_clid: string | null
}

export const emptyAttribution = (): SaleAttribution => ({
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  source_id: null,
  ctwa_clid: null,
})

export interface SalesTrackerResult {
  /** Id do pedido enviado. */
  order_id: string
}

export interface SalesTracker {
  readonly provider: string
  /** Envia a venda. Recusa ou falha do provedor → `SalesTrackerError` (mensagem sem o token). */
  pushSale(sale: TrackedSale, attribution: SaleAttribution): Promise<SalesTrackerResult>
}

export type SalesTrackerErrorCode = 'unauthorized' | 'upstream' | 'validation'

export class SalesTrackerError extends Error {
  constructor(
    readonly code: SalesTrackerErrorCode,
    message: string,
    /** `{ status? }`. Nunca o token. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SalesTrackerError'
  }
}

export interface SalesTrackerFactoryContext {
  env: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
}

/** Cria o adapter a partir do token decifrado da integração. */
export type SalesTrackerFactory = (
  creds: { integrationId: string; companyId: string; token: string },
  ctx: SalesTrackerFactoryContext,
) => SalesTracker

/** Troca o segredo por `[redacted]` e limita o tamanho (mensagens de erro, `last_error` e log). */
export function redactTrackerSecret(text: string, secret: string | null | undefined, max = 300): string {
  let out = text
  if (secret) {
    out = out.split(secret).join('[redacted]')
    const enc = encodeURIComponent(secret)
    if (enc !== secret) out = out.split(enc).join('[redacted]')
  }
  return out.length > max ? `${out.slice(0, max)}…` : out
}
