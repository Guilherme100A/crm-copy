// FakeUtmify: servidor HTTP local que imita o envio de vendas da UTMify (`POST /api-credentials/orders` com o header
// `x-api-token`, ver ./adapter.ts) para os testes. Nunca usar a API real nos testes: aponte `UTMIFY_API_URL` para `fake.url`.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { UTMIFY_ORDERS_PATH, UTMIFY_TOKEN_HEADER } from './adapter'

export interface FakeUtmifyRequest {
  method: string
  path: string
  /** Valor do header `x-api-token`. */
  token: string | null
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

/** Pedido aceito (HTTP 200): um por chamada, na ordem (o mesmo `orderId` aparece de novo a cada status). */
export interface FakeUtmifyOrder {
  token: string
  orderId: string
  status: string
  body: Record<string, unknown>
}

interface Forced {
  status: number
  body: unknown
  /** Quantas respostas ainda forçar (`Infinity` = todas). */
  remaining: number
}

const REQUIRED = [
  'orderId',
  'platform',
  'paymentMethod',
  'status',
  'createdAt',
  'customer',
  'products',
  'commission',
] as const
const STATUSES = new Set(['waiting_payment', 'paid', 'refused', 'refunded', 'chargedback'])

export class FakeUtmify {
  readonly requests: FakeUtmifyRequest[] = []
  readonly orders: FakeUtmifyOrder[] = []
  private readonly tokens: Set<string>
  private server: Server | null = null
  private forced: Forced | null = null
  url = ''

  /** `tokens`: credenciais de API válidas (qualquer outra → 404 `API_CREDENTIAL_NOT_FOUND`). */
  constructor(tokens: string[] = []) {
    this.tokens = new Set(tokens)
  }

  addToken(token: string): void {
    this.tokens.add(token)
  }

  /** Pedidos aceitos de um `orderId` (id da venda), na ordem de chegada. */
  ordersOf(orderId: string): FakeUtmifyOrder[] {
    return this.orders.filter((o) => o.orderId === orderId)
  }

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

  /** Força as próximas `times` respostas (default 1) — ex.: `failNext(500)` simula a UTMify fora do ar. */
  failNext(status = 500, body: unknown = { message: 'Internal server error' }, times = 1): void {
    this.forced = { status, body, remaining: times }
  }

  /** Falha todas as respostas até `reset()`. */
  failAlways(status = 500, body: unknown = { message: 'Internal server error' }): void {
    this.forced = { status, body, remaining: Number.POSITIVE_INFINITY }
  }

  reset(): void {
    this.forced = null
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
    const token = headers[UTMIFY_TOKEN_HEADER] ?? null
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, token, headers, body })

    if (this.forced) {
      const f = this.forced
      f.remaining -= 1
      if (f.remaining <= 0) this.forced = null
      return { status: f.status, body: f.body }
    }
    if (req.method !== 'POST' || url.pathname !== UTMIFY_ORDERS_PATH)
      return { status: 404, body: { message: 'Not found' } }
    if (!token || !this.tokens.has(token)) return { status: 404, body: { message: 'API_CREDENTIAL_NOT_FOUND' } }
    if (!body) return { status: 400, body: { message: 'Invalid JSON' } }
    const missing = REQUIRED.filter((k) => body[k] === undefined || body[k] === null)
    if (missing.length) return { status: 400, body: { message: `Invalid fields: ${missing.join(', ')}` } }
    if (!STATUSES.has(String(body.status))) return { status: 400, body: { message: 'Invalid fields: status' } }
    this.orders.push({ token, orderId: String(body.orderId), status: String(body.status), body })
    return { status: 200, body: { OK: true } }
  }
}
