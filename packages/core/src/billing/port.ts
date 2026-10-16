// Porta de cobrança da plataforma (T18): SÓ interface. Não há assinatura do SaaS nem rota HTTP de billing
// (SPEC 8/10); a recarga de créditos hoje é manual pelo admin. Um gateway futuro implementa esta porta.

export interface CheckoutRequest {
  companyId: string
  /** Créditos de IA comprados. */
  credits: number
  amountCents: number
  /** ISO 4217 (ex.: `BRL`). */
  currency: string
  successUrl: string
  cancelUrl: string
  customerEmail?: string
}

export interface CheckoutSession {
  checkoutId: string
  url: string
}

export type BillingEvent =
  | { type: 'checkout.paid'; checkoutId: string; companyId: string; credits: number; amountCents: number; currency: string }
  | { type: 'checkout.failed'; checkoutId: string; companyId: string; reason?: string }
  | { type: 'refund'; checkoutId: string; companyId: string; amountCents: number; currency: string }

export interface BillingWebhook {
  headers: Record<string, string | undefined>
  rawBody: string | Uint8Array
}

export interface BillingProvider {
  readonly id: string
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>
  /** Valida e interpreta um webhook do gateway; `null` se o evento não interessa. */
  parseWebhook(webhook: BillingWebhook): Promise<BillingEvent | null>
}

export class BillingNotConfiguredError extends Error {
  readonly code = 'checkout_not_configured'
  constructor(message = 'Cobrança não configurada nesta instalação') {
    super(message)
    this.name = 'BillingNotConfiguredError'
  }
}
