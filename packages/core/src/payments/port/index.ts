// Porta dos gateways de pagamento AO LEAD (T109; 19-integracoes.md §3.1, §4.6). Cada gateway (XPag aqui, Zenith na
// T110) implementa `PaymentGateway`; o bloco Pagamento (T111) só conversa com a porta. Não é a `BillingProvider` do SaaS.
import { timingSafeEqual } from 'node:crypto'

export type PaymentEventType = 'payment.approved' | 'payment.failed' | 'payment.expired' | 'payment.refunded'

/** Evento normalizado de um webhook do gateway. */
export interface PaymentEvent {
  type: PaymentEventType
  transaction_id: string
  /** Valor pago/afetado em centavos (`null` se o gateway não informar). */
  amount_cents: number | null
  currency: string
  /** ISO 8601; momento informado pelo gateway (ou do recebimento, se ausente). */
  paid_at: string | null
}

/** Moedas e métodos aceitos pelo gateway (matriz §4.6). */
export interface PaymentSupport {
  currency: string
  methods: string[]
  /** `false` quando a moeda não aceita "chave sem valor" (`open_amount`). */
  open_amount: boolean
}

export interface ChargeRequest {
  currency: string
  method: string
  /** Centavos. Ausente/`null` = "chave sem valor" (o lead paga o que quiser). */
  amount_cents?: number | null
  name?: string
  email?: string
  phone?: string
  document?: string
  document_type?: string
  description?: string
  /** Idempotência no gateway (ex.: id da cobrança no CRM). */
  external_id?: string
}

export interface ChargeBankInfo {
  bank_name?: string
  beneficiary?: string
  account?: string
  reference?: string
}

export interface ChargeResult {
  transaction_id: string
  status: 'created'
  checkout_url?: string
  /** PIX copia-e-cola, CLABE, referência OXXO, EMV Bre-B, CVU/CBU… */
  payment_code?: string
  qr_image_url?: string
  bank_info?: ChargeBankInfo
  /** ISO 8601. */
  expires_at?: string
  /** Resposta do gateway (sem credenciais), para as variáveis do bloco. */
  raw?: Record<string, unknown>
}

export interface ConnectionTestResult {
  ok: boolean
  error?: string
}

export interface PaymentGateway {
  readonly id: string
  supported(): PaymentSupport[]
  /** Valida a combinação moeda × método × valor ANTES de chamar o gateway (`PaymentGatewayError`). */
  createCharge(req: ChargeRequest): Promise<ChargeResult>
  /** Autentica e converte o webhook. Assinatura inválida → `PaymentGatewayError('invalid_signature')`, nenhum evento. */
  parseWebhook(rawBody: string | Uint8Array, headers: WebhookHeaders): PaymentEvent[]
  /** Nunca lança por recusa do gateway: devolve `{ ok: false, error }` sem a chave. */
  testConnection(): Promise<ConnectionTestResult>
}

export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>

export type PaymentGatewayErrorCode = 'validation' | 'coming_soon' | 'unauthorized' | 'upstream' | 'invalid_signature'

export class PaymentGatewayError extends Error {
  constructor(
    readonly code: PaymentGatewayErrorCode,
    message: string,
    /** `validation`: `{ fields }`; `upstream`: `{ status?, error_code? }`. Nunca credenciais. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'PaymentGatewayError'
  }
}

export function chargeInvalid(path: string, message: string): PaymentGatewayError {
  return new PaymentGatewayError('validation', message, { fields: [{ path, message }] })
}

/** Credenciais decifradas de uma integração, entregues à fábrica do adapter. */
export interface PaymentGatewayCredentials {
  integrationId: string
  companyId: string
  clientId: string
  clientSecret: string | null
  webhookSecret: string
  /** URL pública do webhook desta integração (sem segredo). */
  webhookUrl: string
  extra: Record<string, unknown> | null
}

export interface PaymentGatewayFactoryContext {
  env: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
}

export type PaymentGatewayFactory = (creds: PaymentGatewayCredentials, ctx: PaymentGatewayFactoryContext) => PaymentGateway

const factories = new Map<string, PaymentGatewayFactory>()

/** Registra o adapter de um gateway (XPag é registrado por `payments/xpag`; Zenith pela T110). */
export function registerPaymentGateway(id: string, factory: PaymentGatewayFactory): void {
  factories.set(id, factory)
}

export function paymentGatewayFactory(id: string): PaymentGatewayFactory | undefined {
  return factories.get(id)
}

/** Lê um header de `Headers` ou de objeto (nome sem diferenciar maiúsculas). */
export function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>))
    if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v
  return undefined
}

/** Comparação em tempo constante de dois segredos. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Unidades decimais (ex.: 123.45) → centavos. */
export const toCents = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null
}
