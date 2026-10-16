// FakeXPag: servidor HTTP local que imita a API pública da XPag (https://xpag.global/docs) para os testes.
// Nunca usar a API real nos testes. Rotas: GET /balance, POST /cashin, GET /consult-transaction.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { XPAG_WEBHOOK_TOKEN_HEADER } from './gateway'

export interface FakeXPagRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

export interface FakeXPagCashin {
  transaction_id: string
  body: Record<string, unknown>
  /** `webhook_url` recebido (com o `?token=` do CRM). */
  webhook_url: string | null
  status: 'pending' | 'confirmed' | 'failed' | 'expired'
}

export interface FakeXPagWebhook {
  /** URL que a XPag chamaria (a do cashin). */
  url: string | null
  rawBody: string
  headers: Record<string, string>
}

export class FakeXPag {
  readonly requests: FakeXPagRequest[] = []
  readonly cashins: FakeXPagCashin[] = []
  private server: Server | null = null
  private forced: { status: number; body: unknown } | null = null
  url = ''

  constructor(private readonly creds: { clientId: string; clientSecret: string }) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  }

  /** Força a próxima resposta (ex.: 500 ou um erro de negócio). */
  failNext(status: number, body: unknown = { ok: false, error: 'internal_error', error_code: 'internal_error' }): void {
    this.forced = { status, body }
  }

  /** Webhook que a XPag mandaria para a cobrança (token tirado do `webhook_url` do cashin). */
  webhookFor(transactionId: string, opts: { status?: 'confirmed' | 'failed' | 'expired'; amount?: number } = {}): FakeXPagWebhook {
    const c = this.cashins.find((x) => x.transaction_id === transactionId)
    if (!c) throw new Error(`FakeXPag: cobrança ${transactionId} não existe`)
    const status = opts.status ?? 'confirmed'
    c.status = status
    const token = c.webhook_url ? new URL(c.webhook_url).searchParams.get('token') : null
    const payload = {
      type: 'cashin',
      status,
      amount: opts.amount ?? (typeof c.body.amount === 'number' ? c.body.amount : 0),
      fee: 0,
      currency: c.body.currency,
      request_number: transactionId,
      transaction_id: transactionId,
      e2e: `E${transactionId.replace(/\W/g, '')}`,
      external_id: c.body.external_id ?? null,
      provider: 'XPag',
      updated_at: '2025-11-24 12:00:00',
      ...(status === 'failed' ? { fail_reason: 'rejected' } : {}),
    }
    return { url: c.webhook_url, rawBody: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...(token ? { [XPAG_WEBHOOK_TOKEN_HEADER]: token } : {}) } }
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const chunks: Buffer[] = []
    for await (const ch of req) chunks.push(ch as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> | null
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    } catch {
      body = null
    }
    const url = new URL(req.url ?? '/', 'http://fake')
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, headers, body })

    if (this.forced) {
      const f = this.forced
      this.forced = null
      return f
    }
    const id = headers['x-client-id']
    const secret = headers['x-client-secret']
    if (!id || !secret) return { status: 401, body: { ok: false, error: 'missing_credentials', error_code: 'missing_credentials' } }
    if (id !== this.creds.clientId || secret !== this.creds.clientSecret)
      return { status: 401, body: { ok: false, error: 'invalid_credentials', error_code: 'invalid_credentials' } }

    if (req.method === 'GET' && url.pathname === '/balance') return { status: 200, body: { ok: true, balances: [{ currency: 'BRL', available: 0 }] } }
    if (req.method === 'GET' && url.pathname === '/consult-transaction') {
      const c = this.cashins.find((x) => x.transaction_id === url.searchParams.get('transaction_id'))
      return c ? { status: 200, body: { ok: true, transaction_id: c.transaction_id, status: c.status } } : { status: 404, body: { ok: false, error: 'not_found', error_code: 'not_found' } }
    }
    if (req.method === 'POST' && url.pathname === '/cashin') return this.cashin(body ?? {})
    return { status: 404, body: { ok: false, error: 'not_found', error_code: 'not_found' } }
  }

  private cashin(b: Record<string, unknown>): { status: number; body: unknown } {
    const currency = String(b.currency ?? '')
    const method = typeof b.method === 'string' ? b.method : undefined
    const amount = typeof b.amount === 'number' ? b.amount : undefined
    const prefix = method === 'OXXO' ? 'oxxo_' : 'pr_'
    const tx = `${prefix}${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const ok = (extra: Record<string, unknown>) => {
      this.cashins.push({ transaction_id: tx, body: b, webhook_url: typeof b.webhook_url === 'string' ? b.webhook_url : null, status: 'pending' })
      return { status: 200, body: { ok: true, request_number: tx, transaction_id: tx, ...extra } }
    }
    const err = (code: string) => ({ status: 400, body: { ok: false, error: code, error_code: code } })
    if (currency === 'BRL')
      return ok(amount === undefined ? { static: true, open_value: true, copyPaste: `00020126OPEN${tx}`, qr_url: `https://fake.xpag/qr/${tx}` } : { qr_img: 'data:image/png;base64,iVBORw0KGgo=', copyPaste: `00020126PIX${tx}6304ABCD`, code: `00020126PIX${tx}6304ABCD` })
    if (currency === 'MXN' && method === 'OXXO') {
      if (amount === undefined || amount < 10) return err('amount_below_min')
      if (amount > 10_000) return err('amount_above_limit')
      return ok({ currency, amount, fee: 5, method: 'OXXO', status: 'pending', awaiting_instruction: false, transfer_type: 'REFERENCE', payee_data: { transferType: 'REFERENCE', reference: '8204240000119882', barcode: `https://fake.xpag/barcode/${tx}.png` } })
    }
    if (currency === 'MXN')
      return ok({ reference: 'REF123456', clabe: '012345678901234567', ...(amount !== undefined ? { amount } : { static: true, open_value: true }), fee: 5, currency, status: 'pending', bank_name: 'STP (Sistema de Transferencia y Pagos)', beneficiary: 'XPag Pagamentos' })
    if (currency === 'COP') {
      if (amount === undefined || amount < 10_000) return err('amount_below_min')
      const breb = method === 'BREB'
      return ok({ currency, amount, fee: 0, method: breb ? 'BREB' : 'NEQUI_QR', method_requested: method, transfer_type: 'QR', awaiting_instruction: false, code: `000201COP${tx}`, copy_paste: `000201COP${tx}`, qr_url: `https://fake.xpag/qr/${tx}`, breb_key: breb ? '@xpag123' : '', checkout_url: `https://fake.xpag/checkout/${tx}`, expire_minutes: breb ? 15 : 45, status: 'pending' })
    }
    if (currency === 'ARS') {
      if (amount === undefined) return err('amount_required')
      return ok({ currency, amount, method: 'BANK_TRANSFER', status: 'pending', awaiting_instruction: false, payee_data: { name: 'XPag SA', accountNumber: '0000003100000000000001', bankName: 'Banco Fake' } })
    }
    return err('unsupported_currency')
  }
}
