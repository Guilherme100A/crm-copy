// Porta dos emissores de NF (T112; 19-integracoes.md §3.2, §5.4). O job `invoices` só conversa com `InvoiceIssuer`;
// o adapter Notasy (`./notasy`) é o único provedor. `succeeded` = o emissor aceitou o envio (HTTP 2xx), não NF autorizada.

/** Venda enviada ao emissor (centavos + moeda ISO, SPEC 3.6). */
export interface InvoiceSale {
  id: string
  amount_cents: number
  currency: string
  /** ISO 8601. */
  sold_at: string
  status: string
  external_id: string | null
}

export interface InvoiceCustomer {
  name: string | null
  email: string | null
  /** E.164 (`+5511…`) quando houver. */
  phone: string | null
  state: string | null
  city: string | null
  zip: string | null
}

export interface InvoiceProduct {
  id: string | null
  name: string
}

export interface InvoiceIssueResult {
  /** Id da venda/nota no emissor (ou o id enviado, se o emissor não devolver um). */
  external_id: string
  status: 'succeeded'
  number?: string | null
  pdf_url?: string | null
}

export interface InvoiceIssuer {
  readonly provider: string
  /** Envia a venda para emissão. Recusa ou falha do emissor → `InvoiceIssuerError` (mensagem sem o token). */
  issue(sale: InvoiceSale, customer: InvoiceCustomer, product: InvoiceProduct | null): Promise<InvoiceIssueResult>
}

export type InvoiceIssuerErrorCode = 'unauthorized' | 'upstream' | 'validation'

export class InvoiceIssuerError extends Error {
  constructor(
    readonly code: InvoiceIssuerErrorCode,
    message: string,
    /** `upstream`/`unauthorized`: `{ status? }`. Nunca o token. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'InvoiceIssuerError'
  }
}

export interface InvoiceIssuerFactoryContext {
  env: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
}

/** Cria o adapter a partir do token decifrado do emissor. */
export type InvoiceIssuerFactory = (
  creds: { integrationId: string; companyId: string; token: string },
  ctx: InvoiceIssuerFactoryContext,
) => InvoiceIssuer

/** Troca o segredo por `[redacted]` e limita o tamanho (mensagens de erro e `last_error`). */
export function redactInvoiceSecret(text: string, secret: string | null | undefined, max = 300): string {
  let out = text
  if (secret) {
    out = out.split(secret).join('[redacted]')
    const enc = encodeURIComponent(secret)
    if (enc !== secret) out = out.split(enc).join('[redacted]')
  }
  return out.length > max ? `${out.slice(0, max)}…` : out
}
