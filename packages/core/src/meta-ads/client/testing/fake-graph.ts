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
  /** T104: corpo JSON cru (quando `content-type: application/json`). */
  json?: unknown
}

/** T103: uma mutação recebida em `POST /{id}` (status, name, daily_budget, lifetime_budget; valores como a Graph recebe, em texto). */
export interface FakeMutation {
  entityId: string
  /** `act_x` dono da entidade. */
  account: string
  level: 'campaign' | 'adset' | 'ad'
  fields: Record<string, string>
}

/** T104: um evento recebido em `POST /{pixel_id}/events` (Conversions API). */
export interface FakeCapiEvent {
  pixelId: string
  accessToken: string
  testEventCode: string | null
  event: Record<string, unknown>
}

/** T101: nível de `/act_x/insights`. */
export type FakeInsightLevel = 'account' | 'campaign' | 'adset' | 'ad'

/** T101: estrutura de uma conta (`/act_x/campaigns|adsets|ads`), filtrada por `effective_status` quando pedido. */
export interface FakeAccountStructure {
  campaigns?: Record<string, unknown>[]
  adsets?: Record<string, unknown>[]
  ads?: Record<string, unknown>[]
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
  // T101: estrutura, insights, falhas e uso por conta de anúncio.
  private readonly structures = new Map<string, Required<FakeAccountStructure>>()
  private readonly insightsByAccount = new Map<string, Record<FakeInsightLevel, Record<string, unknown>[]>>()
  private readonly accountFailures = new Map<string, { status: number; error: Record<string, unknown> }>()
  private readonly usageByAccount = new Map<string, string>()
  // T104: pixels (Conversions API) e os eventos recebidos.
  private readonly pixels = new Map<string, string>()
  readonly capiEvents: FakeCapiEvent[] = []
  private readonly bmModes = new Map<string, 'doc' | 'accept' | 'reject'>()
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
    // T104: a Conversions API recebe JSON; o resto da Graph, formulário.
    let json: unknown
    if (/application\/json/i.test(String(req.headers['content-type'] ?? '')) && raw) {
      try {
        json = JSON.parse(raw)
      } catch {
        json = undefined
      }
    }
    const body: Record<string, string> =
      json && typeof json === 'object' && !Array.isArray(json)
        ? Object.fromEntries(Object.entries(json as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
        : Object.fromEntries(new URLSearchParams(raw))
    const query = Object.fromEntries(url.searchParams)
    const m = /^\/(v\d+\.\d+)(\/.*)?$/.exec(url.pathname)
    const version = m?.[1] ?? null
    const endpoint = m ? (m[2] ?? '/') : url.pathname
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, version, endpoint, query, body, ...(json !== undefined ? { json } : {}) })
    const params = { ...query, ...body }
    // T101: header de uso por conta (`setUsage`); `{}` nas demais.
    const actMatch = /^\/(act_[^/]+)(?:\/|$)/.exec(endpoint)
    const usageHeader = (actMatch && this.usageByAccount.get(actMatch[1]!)) ?? this.usageByAccount.get('*') ?? '{}'
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-business-use-case-usage': usageHeader })
      res.end(JSON.stringify(json))
    }
    const error = (status: number, code: number, message: string, type = 'OAuthException') =>
      send(status, { error: { message, type, code, fbtrace_id: `trace-${randomBytes(4).toString('hex')}` } })

    const failure = this.failures.shift()
    if (failure) return send(failure.status, { error: failure.error })
    if (!version) return error(400, 2635, 'versão da API ausente no caminho')

    if (endpoint === '/oauth/access_token') return this.oauth(params, send, error)
    // T104: Conversions API — token do pixel (sem appsecret_proof).
    const capi = /^\/(\d+)\/events$/.exec(endpoint)
    if (capi && req.method === 'POST') return this.capi(capi[1]!, params, json, send, error)

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
    // ---- T101: estrutura e insights por conta de anúncio ----
    const actEdge = /^\/(act_[^/]+)\/(campaigns|adsets|ads|insights)$/.exec(endpoint)
    if (actEdge) {
      const [, act, edge] = actEdge as unknown as [string, string, string]
      const fail = this.accountFailures.get(act)
      if (fail) return send(fail.status, { error: fail.error })
      let items: Record<string, unknown>[]
      if (edge === 'insights') {
        const level = (params.level ?? 'account') as FakeInsightLevel
        items = [...(this.insightsByAccount.get(act)?.[level] ?? [])]
      } else {
        const s = this.structures.get(act)
        items = [...((edge === 'campaigns' ? s?.campaigns : edge === 'adsets' ? s?.adsets : s?.ads) ?? [])]
        const statuses = params.effective_status ? (JSON.parse(params.effective_status) as string[]) : null
        if (statuses) items = items.filter((e) => statuses.includes(String(e.effective_status ?? e.status ?? '')))
      }
      return send(200, this.page(items, params, `${this.url}/${version}${endpoint}`))
    }
    // ---- T103: mutação de campanha/conjunto/anúncio (`POST /{id}`) ----
    const entityPost = /^\/([^/]+)$/.exec(endpoint)
    if (entityPost && req.method === 'POST') return this.mutate(entityPost[1]!, params, send, error)
    return error(404, 803, `endpoint fake não suportado: ${endpoint}`, 'GraphMethodException')
  }

  // ---------------------------------------------------------------- T103: mutações

  /** Mutações recebidas (sem `access_token`/`appsecret_proof`), na ordem. */
  readonly mutations: FakeMutation[] = []

  /** Entidade da estrutura semeada (`setStructure`) pelo id, com a conta e o nível. */
  entity(entityId: string): { account: string; level: 'campaign' | 'adset' | 'ad'; entity: Record<string, unknown> } | null {
    for (const [account, s] of this.structures) {
      for (const [level, list] of [['campaign', s.campaigns], ['adset', s.adsets], ['ad', s.ads]] as const) {
        const entity = list.find((e) => String(e.id) === entityId)
        if (entity) return { account, level, entity }
      }
    }
    return null
  }

  private mutate(entityId: string, params: Record<string, string>, send: (s: number, j: unknown) => void, error: (s: number, c: number, m: string, t?: string) => void): void {
    const found = this.entity(entityId)
    if (!found) return error(400, 100, `Unsupported post request. Object with ID '${entityId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation`, 'GraphMethodException')
    const fail = this.accountFailures.get(found.account)
    if (fail) return send(fail.status, { error: fail.error })
    const fields = Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'access_token' && k !== 'appsecret_proof'))
    this.mutations.push({ entityId, account: found.account, level: found.level, fields })
    // Aplica na estrutura (a próxima leitura já vê o valor novo), como a Graph.
    if (fields.status) Object.assign(found.entity, { status: fields.status, effective_status: fields.status })
    if (fields.name !== undefined) found.entity.name = fields.name
    if (fields.daily_budget !== undefined) found.entity.daily_budget = fields.daily_budget
    if (fields.lifetime_budget !== undefined) found.entity.lifetime_budget = fields.lifetime_budget
    return send(200, { success: true })
  }

  /** Página de uma lista com `paging.next` absoluto (offset no `after`), como a Graph. */
  private page(items: Record<string, unknown>[], params: Record<string, string>, base: string): { data: Record<string, unknown>[]; paging: Record<string, unknown> } {
    const size = Number(params.limit) || this.opts.pageSize || 25
    const offset = Number(params.after ?? 0) || 0
    const paging: Record<string, unknown> = { cursors: { before: String(offset), after: String(offset + size) } }
    if (offset + size < items.length) {
      const next = new URL(base)
      for (const [k, v] of Object.entries(params)) if (k !== 'appsecret_proof' && k !== 'after') next.searchParams.set(k, v)
      next.searchParams.set('limit', String(size))
      next.searchParams.set('after', String(offset + size))
      paging.next = next.toString()
    }
    return { data: items.slice(offset, offset + size), paging }
  }

  // ---------------------------------------------------------------- T101: semeadura da conta

  /** Campanhas, conjuntos e anúncios da conta (`act_x`), no formato da Graph (orçamentos em centavos, string). */
  setStructure(fbAccountId: string, structure: FakeAccountStructure): void {
    this.structures.set(fbAccountId, { campaigns: [...(structure.campaigns ?? [])], adsets: [...(structure.adsets ?? [])], ads: [...(structure.ads ?? [])] })
  }

  /** Linhas de `/act_x/insights?level=…` (com `actions[]`/`action_values[]`). */
  setInsights(fbAccountId: string, level: FakeInsightLevel, rows: Record<string, unknown>[]): void {
    const cur = this.insightsByAccount.get(fbAccountId) ?? { account: [], campaign: [], adset: [], ad: [] }
    cur[level] = [...rows]
    this.insightsByAccount.set(fbAccountId, cur)
  }

  /** Toda chamada `/act_x/*` responde este erro até `clearAccountFailure`. */
  failAccount(fbAccountId: string, status: number, error: Record<string, unknown>): void {
    this.accountFailures.set(fbAccountId, { status, error })
  }

  clearAccountFailure(fbAccountId: string): void {
    this.accountFailures.delete(fbAccountId)
  }

  /**
   * Header `x-business-use-case-usage` das respostas da conta (`'*'` = todas): um número vira
   * `{ "<biz>": [{ call_count: pct, total_cputime: pct, total_time: pct, estimated_time_to_regain_access }] }`.
   */
  setUsage(fbAccountId: string | '*', usage: number | Record<string, unknown> | null, regainMinutes = 0): void {
    if (usage === null) {
      this.usageByAccount.delete(fbAccountId)
      return
    }
    const value =
      typeof usage === 'number'
        ? { 'fake-biz': [{ type: 'ADS_INSIGHTS', call_count: usage, total_cputime: usage, total_time: usage, estimated_time_to_regain_access: regainMinutes }] }
        : usage
    this.usageByAccount.set(fbAccountId, JSON.stringify(value))
  }

  // ---------------------------------------------------------------- T104: Conversions API

  /** Cadastra um pixel/dataset e o token CAPI aceito por ele. */
  addPixel(pixelId: string, accessToken: string): void {
    this.pixels.set(pixelId, accessToken)
  }

  /**
   * Revisão 3: como o fake trata eventos `action_source: business_messaging` deste pixel.
   * - `doc` (padrão): aceita só o que a doc de Business Messaging descreve para WhatsApp — `messaging_channel: whatsapp`,
   *   `user_data.whatsapp_business_account_id` + `ctwa_clid` e evento da lista suportada; `page_id` sem WABA é recusado.
   * - `accept`: aceita qualquer business_messaging com `ctwa_clid`; `reject`: recusa todos (erro de permissão).
   */
  setBusinessMessagingMode(pixelId: string, mode: 'doc' | 'accept' | 'reject'): void {
    this.bmModes.set(pixelId, mode)
  }

  /** Eventos CAPI recebidos (opcionalmente só de um pixel). */
  capiEventsFor(pixelId?: string): FakeCapiEvent[] {
    return pixelId ? this.capiEvents.filter((e) => e.pixelId === pixelId) : [...this.capiEvents]
  }

  private capi(
    pixelId: string,
    params: Record<string, string>,
    json: unknown,
    send: (s: number, j: unknown) => void,
    error: (s: number, c: number, m: string, t?: string) => void,
  ): void {
    const expected = this.pixels.get(pixelId)
    if (!expected) return error(400, 100, `Unsupported post request. Object with ID '${pixelId}' does not exist`, 'GraphMethodException')
    const token = params.access_token
    if (!token || token !== expected) return error(400, 190, 'Invalid OAuth access token.')
    const src = (json && typeof json === 'object' ? json : null) as Record<string, unknown> | null
    let data: unknown = src?.data
    if (data === undefined && params.data) {
      try {
        data = JSON.parse(params.data)
      } catch {
        data = undefined
      }
    }
    if (!Array.isArray(data) || data.length === 0) return error(400, 100, '(#100) The parameter data is required')
    const testEventCode = typeof src?.test_event_code === 'string' ? src.test_event_code : (params.test_event_code ?? null)
    // Como a Meta: um evento inválido recusa o lote inteiro (using-the-api).
    const nowS = Date.now() / 1000
    for (const event of data as Record<string, unknown>[]) {
      if (typeof event.event_time !== 'number' || nowS - event.event_time > 7 * 24 * 3600)
        return error(400, 100, '(#100) Invalid parameter: event_time must be within the last 7 days')
      if (event.action_source === 'business_messaging') {
        const mode = this.bmModes.get(pixelId) ?? 'doc'
        const ud = (event.user_data ?? {}) as Record<string, unknown>
        const supported = ['Purchase', 'LeadSubmitted', 'InitiateCheckout', 'AddToCart', 'ViewContent', 'OrderCreated', 'QualifiedLead']
        if (mode === 'reject') return error(403, 10, '(#10) Application does not have permission for this action (whatsapp_business_manage_events)')
        if (!ud.ctwa_clid) return error(400, 100, '(#100) ctwa_clid is required for business_messaging events')
        if (mode === 'doc') {
          if (event.messaging_channel !== 'whatsapp' || !ud.whatsapp_business_account_id)
            return error(400, 100, '(#100) Invalid parameter: whatsapp_business_account_id is required for messaging_channel whatsapp')
          if (!supported.includes(String(event.event_name))) return error(400, 100, `(#100) Unsupported event_name for business_messaging: ${String(event.event_name)}`)
        }
      }
    }
    for (const event of data as Record<string, unknown>[]) this.capiEvents.push({ pixelId, accessToken: token, testEventCode, event })
    return send(200, { events_received: data.length, messages: [], fbtrace_id: `trace-${randomBytes(4).toString('hex')}` })
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
