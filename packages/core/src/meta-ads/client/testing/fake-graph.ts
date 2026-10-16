// FakeMetaGraph (T99; SPEC 3.10): servidor HTTP local que imita a Graph API da Meta para os testes — OAuth (code →
// token curto → token longo), `/me`, `/me/adaccounts` paginado por `paging.next` — e registra cada requisição
// (caminho com versão, query, `appsecret_proof`). Valida o `appsecret_proof` como a Graph real. Nunca a Graph real.
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeAdAccount {
  /** `act_<n>`. */
  id: string
  account_id?: string
  name?: string
  currency?: string
  account_status?: number
}

export interface FakeMetaUser {
  id: string
  name: string
  pictureUrl?: string | null
  adAccounts: FakeAdAccount[]
}

export interface FakeGraphRequest {
  method: string
  /** Caminho completo, ex.: `/v26.0/me/adaccounts`. */
  path: string
  version: string | null
  /** Caminho sem a versão, ex.: `/me/adaccounts`. */
  endpoint: string
  query: Record<string, string>
  body: Record<string, string>
}

export interface FakeMetaGraphOptions {
  appId?: string
  appSecret?: string
  /** Contas por página em `/me/adaccounts` (default 25, ou o `limit` pedido). */
  pageSize?: number
  /** Validade dos tokens (s). */
  shortTokenTtl?: number
  longTokenTtl?: number
}

interface TokenInfo {
  userId: string
  long: boolean
  expiresIn: number
}

export class FakeMetaGraph {
  readonly appId: string
  readonly appSecret: string
  readonly requests: FakeGraphRequest[] = []
  private readonly users = new Map<string, FakeMetaUser>()
  private readonly codes = new Map<string, { userId: string; redirectUri: string | null }>()
  private readonly tokens = new Map<string, TokenInfo>()
  private readonly opts: FakeMetaGraphOptions
  private server: Server | undefined
  private failures: { status: number; error: Record<string, unknown> }[] = []
  url = ''

  constructor(opts: FakeMetaGraphOptions = {}) {
    this.opts = opts
    this.appId = opts.appId ?? 'fake-app-id'
    this.appSecret = opts.appSecret ?? 'fake-app-secret'
  }

  /** Sobe em `127.0.0.1` numa porta livre. */
  async start(): Promise<{ url: string; close(): Promise<void> }> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return { url: this.url, close: () => this.close() }
  }

  async close(): Promise<void> {
    if (!this.server) return
    const s = this.server
    this.server = undefined
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      s.closeAllConnections()
    })
  }

  /** Cadastra (ou substitui) um usuário Meta e as contas de anúncio dele. */
  addUser(user: FakeMetaUser): FakeMetaUser {
    this.users.set(user.id, { ...user, adAccounts: [...user.adAccounts] })
    return user
  }

  /** Troca as contas do usuário (ex.: conta nova antes de "Atualizar lista"). */
  setAdAccounts(userId: string, accounts: FakeAdAccount[]): void {
    const u = this.users.get(userId)
    if (!u) throw new Error(`usuário fake inexistente: ${userId}`)
    u.adAccounts = [...accounts]
  }

  /** `code` do diálogo OAuth para o usuário (o que a Meta manda para o redirect_uri). */
  issueCode(userId: string, redirectUri: string | null = null): string {
    if (!this.users.has(userId)) throw new Error(`usuário fake inexistente: ${userId}`)
    const code = `code-${randomBytes(6).toString('hex')}`
    this.codes.set(code, { userId, redirectUri })
    return code
  }

  /** Token longo já emitido para o usuário (atalho para testar o GraphClient direto). */
  issueToken(userId: string, long = true): string {
    if (!this.users.has(userId)) throw new Error(`usuário fake inexistente: ${userId}`)
    const token = `${long ? 'long' : 'short'}-${randomBytes(8).toString('hex')}`
    this.tokens.set(token, { userId, long, expiresIn: long ? (this.opts.longTokenTtl ?? 60 * 86_400) : (this.opts.shortTokenTtl ?? 3600) })
    return token
  }

  /** Invalida um token (o próximo uso responde 190). */
  revokeToken(token: string): void {
    this.tokens.delete(token)
  }

  /** A próxima requisição falha com este erro da Graph. */
  failNext(status: number, error: Record<string, unknown>): void {
    this.failures.push({ status, error })
  }

  requestsTo(endpoint: string): FakeGraphRequest[] {
    return this.requests.filter((r) => r.endpoint === endpoint)
  }

  // ------------------------------------------------------------------ servidor

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url)
    const raw = await new Promise<string>((resolve) => {
      let s = ''
      req.on('data', (c: Buffer) => (s += c.toString('utf8')))
      req.on('end', () => resolve(s))
    })
    const body = Object.fromEntries(new URLSearchParams(raw))
    const query = Object.fromEntries(url.searchParams)
    const m = /^\/(v\d+\.\d+)(\/.*)?$/.exec(url.pathname)
    const version = m?.[1] ?? null
    const endpoint = m ? (m[2] ?? '/') : url.pathname
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, version, endpoint, query, body })
    const params = { ...query, ...body }
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-business-use-case-usage': '{}' })
      res.end(JSON.stringify(json))
    }
    const error = (status: number, code: number, message: string, type = 'OAuthException') =>
      send(status, { error: { message, type, code, fbtrace_id: `trace-${randomBytes(4).toString('hex')}` } })

    const failure = this.failures.shift()
    if (failure) return send(failure.status, { error: failure.error })
    if (!version) return error(400, 2635, 'versão da API ausente no caminho')

    if (endpoint === '/oauth/access_token') return this.oauth(params, send, error)

    const token = params.access_token
    const info = token ? this.tokens.get(token) : undefined
    if (!token || !info) return error(400, 190, 'Invalid OAuth access token.')
    const proof = createHmac('sha256', this.appSecret).update(token).digest('hex')
    if (params.appsecret_proof !== proof) return error(400, 100, 'Invalid appsecret_proof provided in the API argument')
    const user = this.users.get(info.userId)!

    if (endpoint === '/me')
      return send(200, { id: user.id, name: user.name, ...(user.pictureUrl ? { picture: { data: { url: user.pictureUrl } } } : {}) })
    if (endpoint === '/me/adaccounts') {
      const size = Number(params.limit) || this.opts.pageSize || 25
      const offset = Number(params.after ?? 0) || 0
      const slice = user.adAccounts.slice(offset, offset + size).map((a) => ({
        id: a.id,
        account_id: a.account_id ?? a.id.replace(/^act_/, ''),
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.currency !== undefined ? { currency: a.currency } : {}),
        ...(a.account_status !== undefined ? { account_status: a.account_status } : {}),
      }))
      const nextOffset = offset + size
      const paging: Record<string, unknown> = { cursors: { before: String(offset), after: String(nextOffset) } }
      if (nextOffset < user.adAccounts.length) {
        // Como a Graph: o `next` é absoluto e traz os parâmetros da consulta (sem o appsecret_proof).
        const next = new URL(`${this.url}/${version}/me/adaccounts`)
        for (const [k, v] of Object.entries(params)) if (k !== 'appsecret_proof' && k !== 'after') next.searchParams.set(k, v)
        next.searchParams.set('limit', String(size))
        next.searchParams.set('after', String(nextOffset))
        paging.next = next.toString()
      }
      return send(200, { data: slice, paging })
    }
    return error(404, 803, `endpoint fake não suportado: ${endpoint}`, 'GraphMethodException')
  }

  private oauth(params: Record<string, string>, send: (s: number, j: unknown) => void, error: (s: number, c: number, m: string) => void): void {
    if (params.client_id !== this.appId || params.client_secret !== this.appSecret) return error(400, 1, 'Error validating application.')
    if (params.grant_type === 'fb_exchange_token') {
      const short = this.tokens.get(params.fb_exchange_token ?? '')
      if (!short) return error(400, 190, 'Invalid OAuth access token.')
      const token = this.issueToken(short.userId, true)
      return send(200, { access_token: token, token_type: 'bearer', expires_in: this.tokens.get(token)!.expiresIn })
    }
    const entry = this.codes.get(params.code ?? '')
    if (!entry) return error(400, 100, 'Invalid verification code format.')
    if (entry.redirectUri && entry.redirectUri !== params.redirect_uri) return error(400, 100, 'redirect_uri diferente do usado no diálogo')
    this.codes.delete(params.code!)
    const token = this.issueToken(entry.userId, false)
    return send(200, { access_token: token, token_type: 'bearer', expires_in: this.tokens.get(token)!.expiresIn })
  }
}
