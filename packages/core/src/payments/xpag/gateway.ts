// Adapter XPag da porta `PaymentGateway` (T109; 19-integracoes.md §4.6, linhas XPag).
// Implementado pela documentação pública da XPag (sem sandbox no projeto; testes só com o `FakeXPag`):
//   - https://xpag.global/docs                 (visão geral, base https://api.xpag.global)
//   - https://xpag.global/docs/authentication  (headers X-Client-Id / X-Client-Secret)
//   - https://xpag.global/docs/cashin          (POST /cashin por moeda: BRL PIX, MXN SPEI/OXXO, COP NEQUI/BREB, ARS)
//   - https://xpag.global/docs/transactions    (GET /consult-transaction)
//   - https://xpag.global/docs/webhooks        (payload do webhook; NÃO documenta assinatura)
//   - https://xpag.global/docs/balance         (GET /balance, usado no teste de conexão)
//   - https://xpag.global/docs/errors          (corpo { ok:false, error, error_code }; 401 invalid_credentials)
//   - https://xpag.global/llms-full.txt        (documentação consolidada)
// Detalhes e decisões inferidas em docs/integrations/xpag.md.
import {
  chargeInvalid,
  headerValue,
  PaymentGatewayError,
  safeEqual,
  toCents,
  type ChargeRequest,
  type ChargeResult,
  type ConnectionTestResult,
  type PaymentEvent,
  type PaymentGateway,
  type PaymentSupport,
  type WebhookHeaders,
} from '../port'

export const XPAG_DEFAULT_API_URL = 'https://api.xpag.global'
/** Header com o token do webhook; a rota de hooks (T111) o preenche com o `?token=` da URL chamada pela XPag. */
export const XPAG_WEBHOOK_TOKEN_HEADER = 'x-webhook-token'

/** Matriz moeda × método da XPag (§4.6). ARS não aceita "chave sem valor". */
export const XPAG_SUPPORT: readonly PaymentSupport[] = [
  { currency: 'BRL', methods: ['PIX'], open_amount: true },
  { currency: 'MXN', methods: ['SPEI', 'OXXO'], open_amount: true },
  { currency: 'COP', methods: ['NEQUI', 'BREB'], open_amount: false },
  { currency: 'ARS', methods: ['BANK_TRANSFER'], open_amount: false },
]

/** Limites em centavos: OXXO MX$10–10.000; COP mínimo COP$10.000. */
export const XPAG_LIMITS = { oxxoMinCents: 10_00, oxxoMaxCents: 10_000_00, copMinCents: 10_000_00 } as const
const OXXO_EXPIRY_DAYS = 12

export interface XPagGatewayOptions {
  clientId: string
  clientSecret: string
  /** Segredo do webhook desta integração (gerado pelo CRM). */
  webhookSecret: string
  /** URL pública do webhook (sem segredo); o adapter acrescenta `?token=`. Sem ela, a cobrança vai sem webhook. */
  webhookUrl?: string
  /** Default: `XPAG_API_URL` do env, senão https://api.xpag.global. */
  apiUrl?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  now?: () => Date
}

type Json = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

/** Valida a combinação antes de qualquer chamada (AC-T109-03). Devolve a requisição normalizada. */
export function validateXPagCharge(req: ChargeRequest): ChargeRequest & { currency: string; method: string } {
  const currency = String(req.currency ?? '').trim().toUpperCase()
  const method = String(req.method ?? '').trim().toUpperCase()
  const support = XPAG_SUPPORT.find((s) => s.currency === currency)
  if (!support) throw chargeInvalid('currency', `Moeda ${currency || '(vazia)'} não suportada pela XPag`)
  if (!support.methods.includes(method)) throw chargeInvalid('method', `Método ${method || '(vazio)'} não disponível para ${currency} na XPag`)
  const amount = req.amount_cents
  const open = amount === undefined || amount === null
  if (!open && (!Number.isInteger(amount) || amount <= 0)) throw chargeInvalid('amount', 'Valor inválido')
  if (open && currency === 'ARS') throw new PaymentGatewayError('coming_soon', 'Chave sem valor em ARS: em breve na XPag')
  if (open && (currency === 'COP' || method === 'OXXO')) throw chargeInvalid('amount', `Valor obrigatório para ${currency} ${method}`)
  if (method === 'OXXO' && (amount! < XPAG_LIMITS.oxxoMinCents || amount! > XPAG_LIMITS.oxxoMaxCents))
    throw chargeInvalid('amount', 'OXXO aceita de MX$10 a MX$10.000')
  if (currency === 'COP' && amount! < XPAG_LIMITS.copMinCents) throw chargeInvalid('amount', 'Valor mínimo em COP é COP$10.000')
  let phone = req.phone
  if (currency === 'COP' && str(phone)) {
    let digits = phone!.replace(/\D/g, '')
    if (digits.length === 12 && digits.startsWith('57')) digits = digits.slice(2)
    if (!/^3\d{9}$/.test(digits)) throw chargeInvalid('phone', 'Celular colombiano: 10 dígitos começando com 3')
    phone = digits
  }
  if (currency === 'ARS' && !str(req.name)) throw chargeInvalid('name', 'Nome obrigatório em ARS')
  return { ...req, currency, method, ...(phone !== undefined ? { phone } : {}) }
}

export function createXPagGateway(opts: XPagGatewayOptions): PaymentGateway {
  const base = () => (opts.apiUrl ?? process.env.XPAG_API_URL ?? XPAG_DEFAULT_API_URL).replace(/\/+$/, '')
  const now = () => opts.now?.() ?? new Date()
  const redact = (text: string) => {
    let out = text
    for (const s of [opts.clientSecret, opts.webhookSecret]) if (s) out = out.split(s).join('[redacted]')
    return out.slice(0, 300)
  }

  async function call(method: 'GET' | 'POST', path: string, body?: Json): Promise<Json> {
    const fetchFn = opts.fetch ?? globalThis.fetch
    let res: Response
    try {
      res = await fetchFn(`${base()}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'x-client-id': opts.clientId,
          'x-client-secret': opts.clientSecret,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      })
    } catch (err) {
      throw new PaymentGatewayError('upstream', redact(`XPag indisponível: ${err instanceof Error ? err.message : String(err)}`))
    }
    const text = await res.text()
    let data: Json
    try {
      data = obj(text ? JSON.parse(text) : {})
    } catch {
      data = {}
    }
    if (res.ok && data.ok !== false) return data
    const errorCode = str(data.error_code) ?? str(data.error)
    const message = redact(str(data.error) ?? str(data.message) ?? `HTTP ${res.status}`)
    if (res.status === 401 || res.status === 403 || errorCode === 'invalid_credentials' || errorCode === 'missing_credentials')
      throw new PaymentGatewayError('unauthorized', `Credencial recusada pela XPag (${message})`, { status: res.status, ...(errorCode ? { error_code: errorCode } : {}) })
    if (errorCode === 'amount_below_min' || errorCode === 'amount_above_limit')
      throw new PaymentGatewayError('validation', `Valor fora do limite da XPag (${errorCode})`, { fields: [{ path: 'amount', message }], error_code: errorCode })
    throw new PaymentGatewayError('upstream', `XPag recusou a operação: ${message}`, { status: res.status, ...(errorCode ? { error_code: errorCode } : {}) })
  }

  function webhookTarget(): string | undefined {
    if (!opts.webhookUrl) return undefined
    const u = new URL(opts.webhookUrl)
    u.searchParams.set('token', opts.webhookSecret)
    return u.toString()
  }

  function cashinBody(req: ReturnType<typeof validateXPagCharge>): Json {
    const body: Json = { currency: req.currency }
    if (req.amount_cents !== undefined && req.amount_cents !== null) body.amount = req.amount_cents / 100
    if (req.method === 'OXXO') {
      body.method = 'OXXO'
      const payer: Json = {}
      if (str(req.name)) payer.name = req.name
      if (str(req.email)) payer.email = req.email
      if (Object.keys(payer).length) body.payerData = payer
    } else if (req.currency === 'COP') {
      body.method = req.method
      if (str(req.phone)) body.phone = req.phone
    } else if (req.currency === 'ARS') {
      body.method = 'BANK_TRANSFER'
      body.name = req.name
      if (str(req.document)) {
        body.document = req.document
        body.document_type = str(req.document_type) ?? 'CUIT'
      }
    } else {
      // BRL PIX e MXN SPEI.
      if (str(req.name)) body.name = req.name
      if (str(req.document)) body.document = req.document
    }
    if (str(req.description)) body.description = req.description
    if (str(req.external_id)) body.external_id = req.external_id
    const hook = webhookTarget()
    if (hook) body.webhook_url = hook
    return body
  }

  function toResult(req: ReturnType<typeof validateXPagCharge>, data: Json): ChargeResult {
    const transactionId = str(data.transaction_id) ?? str(data.request_number)
    if (!transactionId) throw new PaymentGatewayError('upstream', 'XPag não devolveu transaction_id')
    const payee = obj(data.payee_data)
    const out: ChargeResult = { transaction_id: transactionId, status: 'created', raw: data }
    const checkout = str(data.checkout_url)
    if (checkout) out.checkout_url = checkout
    if (req.currency === 'BRL') {
      const code = str(data.copyPaste) ?? str(data.copy_paste) ?? str(data.code)
      if (code) out.payment_code = code
      const qr = str(data.qr_img) ?? str(data.qr_url)
      if (qr) out.qr_image_url = qr
    } else if (req.method === 'SPEI') {
      const clabe = str(data.clabe)
      if (clabe) out.payment_code = clabe
      out.bank_info = { ...(str(data.bank_name) ? { bank_name: str(data.bank_name) } : {}), ...(str(data.beneficiary) ? { beneficiary: str(data.beneficiary) } : {}), ...(clabe ? { account: clabe } : {}), ...(str(data.reference) ? { reference: str(data.reference) } : {}) }
    } else if (req.method === 'OXXO') {
      const reference = str(payee.reference) ?? str(data.reference)
      if (reference) {
        out.payment_code = reference
        out.bank_info = { reference }
      }
      const barcode = str(payee.barcode)
      if (barcode) out.qr_image_url = barcode
      out.expires_at = new Date(now().getTime() + OXXO_EXPIRY_DAYS * 86_400_000).toISOString()
    } else if (req.currency === 'COP') {
      const code = str(data.copy_paste) ?? str(data.code)
      if (code) out.payment_code = code
      const qr = str(data.qr_url)
      if (qr) out.qr_image_url = qr
      const breb = str(data.breb_key)
      if (breb) out.bank_info = { reference: breb }
      const minutes = Number(data.expire_minutes)
      if (Number.isFinite(minutes) && minutes > 0) out.expires_at = new Date(now().getTime() + minutes * 60_000).toISOString()
    } else if (req.currency === 'ARS') {
      const account = str(payee.accountNumber)
      if (account) out.payment_code = account
      out.bank_info = { ...(str(payee.bankName) ? { bank_name: str(payee.bankName) } : {}), ...(str(payee.name) ? { beneficiary: str(payee.name) } : {}), ...(account ? { account } : {}) }
    }
    return out
  }

  return {
    id: 'xpag',
    supported: () => XPAG_SUPPORT.map((s) => ({ ...s, methods: [...s.methods] })),

    async createCharge(input) {
      const req = validateXPagCharge(input)
      return toResult(req, await call('POST', '/cashin', cashinBody(req)))
    },

    parseWebhook(rawBody: string | Uint8Array, headers: WebhookHeaders): PaymentEvent[] {
      const token = headerValue(headers, XPAG_WEBHOOK_TOKEN_HEADER)
      if (!token || !opts.webhookSecret || !safeEqual(token, opts.webhookSecret)) throw new PaymentGatewayError('invalid_signature', 'Webhook XPag com token inválido')
      const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new PaymentGatewayError('validation', 'Webhook XPag com JSON inválido')
      }
      const events: PaymentEvent[] = []
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        const ev = toEvent(obj(item), now)
        if (ev) events.push(ev)
      }
      return events
    },

    async testConnection(): Promise<ConnectionTestResult> {
      try {
        await call('GET', '/balance')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: redact(err instanceof Error ? err.message : String(err)) }
      }
    },
  }
}

/** Payload da doc de webhooks → evento. Cash out e estados intermediários (`med` aberto, `pending`) não geram evento. */
function toEvent(p: Json, now: () => Date): PaymentEvent | null {
  const type = str(p.type)?.toLowerCase()
  if (type && type !== 'cashin') return null
  const transactionId = str(p.transaction_id) ?? str(p.request_number)
  if (!transactionId) return null
  const status = str(p.status)?.toLowerCase()
  let kind: PaymentEvent['type'] | null = null
  if (status === 'confirmed' || status === 'completed' || status === 'paid' || status === 'approved') kind = 'payment.approved'
  else if (status === 'failed') kind = 'payment.failed'
  else if (status === 'expired') kind = 'payment.expired'
  else if (status === 'refunded') kind = 'payment.refunded'
  else if (status === 'med_closed') {
    // MED (devolução do PIX) encerrado: só vira reembolso quando o resultado indica devolução [INFERIDO].
    const result = str(obj(p.med).result)?.toLowerCase() ?? ''
    if (/refund|return|devol|accept|procedent/.test(result)) kind = 'payment.refunded'
  }
  if (!kind) return null
  return { type: kind, transaction_id: transactionId, amount_cents: toCents(p.amount), currency: str(p.currency)?.toUpperCase() ?? '', paid_at: parseXPagTime(str(p.updated_at)) ?? now().toISOString() }
}

/** `2025-11-24 12:00:00` (sem fuso na doc) → ISO, lido como UTC [INFERIDO]. */
function parseXPagTime(v: string | undefined): string | null {
  if (!v) return null
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
