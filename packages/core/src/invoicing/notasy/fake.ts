// FakeNotasy: servidor HTTP local que imita o endpoint de integração da Notasy (`POST /integrations/endpoint/<token>`,
// ver ./adapter.ts) para os testes. Nunca usar a API real nos testes: aponte `NOTASY_API_URL` para `fake.url`.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { NOTASY_ENDPOINT_PATH } from './adapter'

export interface FakeNotasyRequest {
  method: string
  path: string
  /** Token do endpoint chamado. */
  token: string | null
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

export interface FakeNotasySale {
  id: string
  token: string
  body: Record<string, unknown>
}

interface Forced {
  status: number
  body: unknown
  /** Quantas respostas ainda forçar (`Infinity` = todas). */
  remaining: number
}

export class FakeNotasy {
  readonly requests: FakeNotasyRequest[] = []
  /** Vendas aceitas (HTTP 200). */
  readonly sales: FakeNotasySale[] = []
  private readonly tokens: Set<string>
  private server: Server | null = null
  private forced: Forced | null = null
  url = ''

  /** `tokens`: tokens de integração válidos (qualquer outro → 404, como um endpoint inexistente). */
  constructor(tokens: string[] = []) {
    this.tokens = new Set(tokens)
  }

  addToken(token: string): void {
    this.tokens.add(token)
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

  /** Força as próximas `times` respostas (default 1) — ex.: `failNext(500)` simula a Notasy fora do ar. */
  failNext(status = 500, body: unknown = { success: false, error: { message: 'Erro interno' } }, times = 1): void {
    this.forced = { status, body, remaining: times }
  }

  /** Falha todas as respostas até `reset()`. */
  failAlways(status = 500, body: unknown = { success: false, error: { message: 'Erro interno' } }): void {
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
    const token = url.pathname.startsWith(NOTASY_ENDPOINT_PATH)
      ? decodeURIComponent(url.pathname.slice(NOTASY_ENDPOINT_PATH.length))
      : null
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, token, headers, body })

    if (this.forced) {
      const f = this.forced
      f.remaining -= 1
      if (f.remaining <= 0) this.forced = null
      return { status: f.status, body: f.body }
    }
    if (req.method !== 'POST' || token === null)
      return { status: 404, body: { success: false, error: { message: 'Not found' } } }
    if (!this.tokens.has(token))
      return { status: 404, body: { success: false, error: { message: 'Integração não encontrada' } } }
    if (!body) return { status: 400, body: { success: false, error: { message: 'JSON inválido' } } }
    const id = randomUUID()
    this.sales.push({ id, token, body })
    return { status: 200, body: { success: true, data: { id, status: 'received' } } }
  }
}
