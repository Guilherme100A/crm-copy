// Adapter UTMify da porta `SalesTracker` (T113; 11-facebook-ads.md §3.6, §9). Sem sandbox no projeto; testes só com o
// `FakeUtmify`. Implementado pela documentação pública (detalhes e o que falta validar em docs/integrations/utmify.md):
//   - https://docs.utmify.com.br/envio-de-vendas      ("Envio de Vendas": `POST https://api.utmify.com.br/api-credentials/orders`,
//                                                      header `x-api-token` com a "Credencial de API" do dashboard;
//                                                      corpo `orderId`, `platform`, `paymentMethod`, `status`, `createdAt`,
//                                                      `approvedDate`, `refundedAt`, `customer`, `products`,
//                                                      `trackingParameters`, `commission`, `isTest`)
//   - https://docs.utmify.com.br/envio-de-vendas.md   (mesma página em Markdown: exemplos "PIX Pago" e "Cartão Reembolsado")
//   - https://docs.utmify.com.br/llms.txt             (índice público da documentação)
// Datas em "YYYY-MM-DD HH:MM:SS" UTC; `createdAt` é o mesmo em todos os envios do pedido (a atualização de status
// reenvia o mesmo `orderId`). A doc não publica os códigos HTTP de resposta: 2xx = aceito; o resto é tratado como erro
// (401/403 ou `API_CREDENTIAL_NOT_FOUND` = credencial; 400/422 = validação).
import {
  redactTrackerSecret,
  SalesTrackerError,
  type SaleAttribution,
  type SalesTracker,
  type SalesTrackerResult,
  type TrackedSale,
} from './port'

export const UTMIFY_DEFAULT_API_URL = 'https://api.utmify.com.br'
export const UTMIFY_ORDERS_PATH = '/api-credentials/orders'
export const UTMIFY_TOKEN_HEADER = 'x-api-token'
/** Moedas aceitas em `commission.currency` (BRL é o padrão e vai omitida). */
export const UTMIFY_CURRENCIES = [
  'BRL',
  'USD',
  'EUR',
  'GBP',
  'ARS',
  'CAD',
  'COP',
  'MXN',
  'PYG',
  'CLP',
  'PEN',
  'PLN',
] as const

export interface UtmifyTrackerOptions {
  /** "Credencial de API" do dashboard da UTMify. */
  token: string
  /** Default: `UTMIFY_API_URL` do env, senão https://api.utmify.com.br. */
  apiUrl?: string
  /** `platform` do pedido (PascalCase). Default: `APP_NAME` em PascalCase, senão `Crm`. */
  platform?: string
  /** `paymentMethod` (a venda do CRM não guarda o meio de pagamento). Default `pix`. */
  paymentMethod?: 'credit_card' | 'boleto' | 'pix' | 'paypal' | 'free_price'
  /** `isTest: true` valida sem gravar o pedido na UTMify. */
  isTest?: boolean
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

type Json = Record<string, unknown>

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null

/** ISO 8601 → "YYYY-MM-DD HH:MM:SS" (UTC 0), o formato da UTMify. */
export function utmifyDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** "Meu CRM" → "MeuCrm" (a doc recomenda `platform` em PascalCase). */
export function utmifyPlatform(name: string | null | undefined): string {
  const out = (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join('')
  return out || 'Crm'
}

/** Corpo do `POST /api-credentials/orders` (docs.utmify.com.br/envio-de-vendas). */
export function utmifyOrderPayload(
  sale: TrackedSale,
  attribution: SaleAttribution,
  opts: Pick<UtmifyTrackerOptions, 'platform' | 'paymentMethod' | 'isTest'> = {},
): Json {
  const currency = sale.currency.toUpperCase()
  const approvedAt = sale.approved_at ?? sale.sold_at
  return {
    orderId: sale.id,
    platform: opts.platform ?? 'Crm',
    paymentMethod: opts.paymentMethod ?? 'pix',
    status: sale.status === 'refunded' ? 'refunded' : 'paid',
    createdAt: utmifyDate(sale.sold_at),
    approvedDate: utmifyDate(approvedAt),
    refundedAt: sale.status === 'refunded' ? utmifyDate(sale.refunded_at ?? new Date().toISOString()) : null,
    customer: {
      name: sale.customer.name ?? 'Cliente',
      email: sale.customer.email ?? '',
      phone: sale.customer.phone ? sale.customer.phone.replace(/\D/g, '') : null,
      document: null,
    },
    products: [
      {
        id: sale.product?.id ?? sale.id,
        name: sale.product?.name ?? 'Venda',
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: sale.amount_cents,
      },
    ],
    trackingParameters: {
      // `src`/`sck` são parâmetros livres de rastreio: levam o anúncio (`source_id`) e o clique CTWA (`ctwa_clid`).
      src: attribution.source_id,
      sck: attribution.ctwa_clid,
      utm_source: attribution.utm_source,
      utm_campaign: attribution.utm_campaign,
      utm_medium: attribution.utm_medium,
      utm_content: attribution.utm_content,
      utm_term: attribution.utm_term,
    },
    commission: {
      totalPriceInCents: sale.amount_cents,
      gatewayFeeInCents: 0,
      userCommissionInCents: sale.amount_cents,
      ...(currency !== 'BRL' ? { currency } : {}),
    },
    ...(opts.isTest ? { isTest: true } : {}),
  }
}

export function createUtmifyTracker(opts: UtmifyTrackerOptions): SalesTracker {
  const token = opts.token.trim()
  const base = () =>
    (opts.apiUrl ?? process.env.UTMIFY_API_URL?.trim() ?? UTMIFY_DEFAULT_API_URL).replace(/\/+$/, '') ||
    UTMIFY_DEFAULT_API_URL
  const redact = (text: string) => redactTrackerSecret(text, token)
  const platform = opts.platform ?? utmifyPlatform(process.env.APP_NAME)

  return {
    provider: 'utmify',
    async pushSale(sale, attribution): Promise<SalesTrackerResult> {
      if (!token) throw new SalesTrackerError('unauthorized', 'Integração UTMify não configurada')
      const fetchFn = opts.fetch ?? globalThis.fetch
      let res: Response
      try {
        res = await fetchFn(`${base()}${UTMIFY_ORDERS_PATH}`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', [UTMIFY_TOKEN_HEADER]: token },
          body: JSON.stringify(
            utmifyOrderPayload(sale, attribution, {
              platform,
              ...(opts.paymentMethod ? { paymentMethod: opts.paymentMethod } : {}),
              ...(opts.isTest ? { isTest: true } : {}),
            }),
          ),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        })
      } catch (err) {
        throw new SalesTrackerError(
          'upstream',
          redact(`UTMify indisponível: ${err instanceof Error ? err.message : String(err)}`),
        )
      }
      if (res.ok) {
        await res.text().catch(() => '')
        return { order_id: sale.id }
      }
      const text = await res.text().catch(() => '')
      let body: Json
      try {
        body = obj(text ? JSON.parse(text) : {})
      } catch {
        body = {}
      }
      const reason =
        str(body.message) ??
        str(obj(body.error).message) ??
        str(body.error) ??
        (text.trim().slice(0, 200) || `HTTP ${res.status}`)
      if (res.status === 401 || res.status === 403 || /API_CREDENTIAL_NOT_FOUND/.test(reason))
        throw new SalesTrackerError('unauthorized', redact(`UTMify recusou a credencial de API (${reason})`), {
          status: res.status,
        })
      if (res.status === 400 || res.status === 422)
        throw new SalesTrackerError('validation', redact(`UTMify recusou a venda: ${reason}`), { status: res.status })
      throw new SalesTrackerError('upstream', redact(`Falha na UTMify: ${reason}`), { status: res.status })
    },
  }
}
