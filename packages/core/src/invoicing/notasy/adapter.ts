// Adapter Notasy da porta `InvoiceIssuer` (T112; 19-integracoes.md §5.4). Sem sandbox no projeto; testes só com o
// `FakeNotasy`. Implementado pelo que a Notasy publica (detalhes, inferências e o que falta validar em
// docs/integrations/notasy.md):
//   - https://notasy.com.br/                         (produto; "API documentada pra emitir nota direto da sua aplicação")
//   - https://api-notasy.com.br/integrations         (catálogo público de integrações: a conexão nativa deste tipo de
//                                                      CRM é `native_connection_is_token_only`, só "Token de integração")
//   - https://app.notasy.com.br/ (componente `EndpointUrl` da tela da integração): o endpoint de cada integração é
//     `<api>/integrations/endpoint/<token>`, e o "Token de integração" exibido é o trecho depois de `/integrations/endpoint/`
//   - https://app.notasy.com.br/webhooks/documentacao (webhooks de SAÍDA da Notasy: eventos `*_invoice.transmitted|
//     canceled|failed`, header `X-Notasy-Signature` = HMAC-SHA256 hex do corpo cru com o segredo do webhook)
//   - https://faq.notasy.com.br/                     (central de ajuda; a integração "API" é orientada pelo suporte)
// O corpo JSON da venda NÃO é público (o tutorial da integração só aparece logado): o formato abaixo é inferido e
// precisa ser validado com um token real (SPEC 10.1 nº 10).
import {
  InvoiceIssuerError,
  redactInvoiceSecret,
  type InvoiceCustomer,
  type InvoiceIssuer,
  type InvoiceIssueResult,
  type InvoiceProduct,
  type InvoiceSale,
} from '../port'

export const NOTASY_DEFAULT_API_URL = 'https://api-notasy.com.br'
export const NOTASY_ENDPOINT_PATH = '/integrations/endpoint/'

export interface NotasyIssuerOptions {
  /** "Token de integração" do painel Notasy (o sufixo do endpoint). */
  token: string
  /** Default: `NOTASY_API_URL` do env, senão https://api-notasy.com.br. */
  apiUrl?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

type Json = Record<string, unknown>

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null

/** Aceita o token puro ou o endpoint inteiro colado do painel (`…/integrations/endpoint/<token>`). */
export function normalizeNotasyToken(input: string): string {
  const v = input.trim()
  const at = v.indexOf(NOTASY_ENDPOINT_PATH)
  const token = at >= 0 ? v.slice(at + NOTASY_ENDPOINT_PATH.length) : v
  return token.replace(/[/?#].*$/, '').trim()
}

/** Corpo enviado ao endpoint da integração (formato inferido; ver docs/integrations/notasy.md). */
export function notasySalePayload(sale: InvoiceSale, customer: InvoiceCustomer, product: InvoiceProduct | null): Json {
  return {
    event: 'sale.approved',
    id: sale.id,
    external_sale_id: sale.external_id ?? sale.id,
    status: sale.status,
    created_at: sale.sold_at,
    currency: sale.currency,
    /** Centavos, como os valores dos webhooks da Notasy. */
    total: sale.amount_cents,
    customer: {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      address: { state: customer.state, city: customer.city, zip_code: customer.zip },
    },
    products: [{ id: product?.id ?? null, name: product?.name ?? 'Venda', quantity: 1, price: sale.amount_cents }],
  }
}

export function createNotasyIssuer(opts: NotasyIssuerOptions): InvoiceIssuer {
  const token = normalizeNotasyToken(opts.token)
  const base = () =>
    (opts.apiUrl ?? process.env.NOTASY_API_URL?.trim() ?? NOTASY_DEFAULT_API_URL).replace(/\/+$/, '') ||
    NOTASY_DEFAULT_API_URL
  const redact = (text: string) => redactInvoiceSecret(text, token)

  return {
    provider: 'notasy',
    async issue(sale, customer, product): Promise<InvoiceIssueResult> {
      if (!token) throw new InvoiceIssuerError('unauthorized', 'Emissor não configurado')
      const fetchFn = opts.fetch ?? globalThis.fetch
      let res: Response
      try {
        res = await fetchFn(`${base()}${NOTASY_ENDPOINT_PATH}${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(notasySalePayload(sale, customer, product)),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        })
      } catch (err) {
        throw new InvoiceIssuerError(
          'upstream',
          redact(`Notasy indisponível: ${err instanceof Error ? err.message : String(err)}`),
        )
      }
      const text = await res.text().catch(() => '')
      let body: Json
      try {
        body = obj(text ? JSON.parse(text) : {})
      } catch {
        body = {}
      }
      if (!res.ok) {
        const err = obj(body.error)
        const reason = str(err.message) ?? str(body.message) ?? str(body.error) ?? `HTTP ${res.status}`
        if (res.status === 401 || res.status === 403 || res.status === 404)
          throw new InvoiceIssuerError('unauthorized', redact(`Notasy recusou o token da integração (${reason})`), {
            status: res.status,
          })
        if (res.status === 400 || res.status === 422)
          throw new InvoiceIssuerError('validation', redact(`Notasy recusou a venda: ${reason}`), {
            status: res.status,
          })
        throw new InvoiceIssuerError('upstream', redact(`Falha na Notasy: ${reason}`), { status: res.status })
      }
      const data = obj(body.data)
      const invoice = obj(data.service_invoice ?? data.product_invoice ?? data.invoice)
      return {
        external_id: str(data.id) ?? str(body.id) ?? sale.id,
        status: 'succeeded',
        number: str(invoice.number) ?? str(data.number),
        pdf_url: str(invoice.danfse_file) ?? str(invoice.danfe_file) ?? str(data.pdf_url),
      }
    },
  }
}
