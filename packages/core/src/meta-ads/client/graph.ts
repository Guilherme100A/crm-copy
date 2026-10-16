// Cliente fino da Graph API da Meta (T99; STACK Bloco E §1): `fetch` próprio (o SDK oficial está defasado), versão
// numa constante só, `appsecret_proof = HMAC-SHA256(token, app_secret)` em toda chamada com token, paginação por
// `paging.next` (sem montar URL na mão) e erros da Graph mapeados para `MetaGraphError`.
import { createHmac } from 'node:crypto'

/** Versão da Graph/Marketing API usada pelo CRM (revisar em fevereiro e julho; STACK E §1.1). */
export const META_GRAPH_VERSION = 'v26.0'
export const DEFAULT_META_GRAPH_URL = 'https://graph.facebook.com'
/** Limite de páginas de um `getAll` (proteção contra laço infinito de `paging.next`). */
export const DEFAULT_MAX_PAGES = 100

const VERSION_RE = /^v\d+\.\d+$/

/** `META_GRAPH_URL` pode trazer a versão (`https://graph.facebook.com/v26.0`): separa base e versão. */
export function parseGraphUrl(raw: string | undefined, fallbackVersion: string = META_GRAPH_VERSION): { graphUrl: string; version: string } {
  const url = (raw?.trim() || DEFAULT_META_GRAPH_URL).replace(/\/+$/, '')
  const last = url.slice(url.lastIndexOf('/') + 1)
  if (VERSION_RE.test(last)) return { graphUrl: url.slice(0, url.lastIndexOf('/')), version: last }
  return { graphUrl: url, version: fallbackVersion }
}

/** `appsecret_proof` (hex): HMAC-SHA256 do access token com o app secret. */
export function appsecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex')
}

export type GraphParams = Record<string, string | number | boolean | null | undefined>

export interface MetaGraphErrorInfo {
  status: number
  code: number | string | null
  subcode: number | null
  type: string | null
  fbtraceId: string | null
}

/** Erro da Graph (corpo `{ error: { message, type, code, error_subcode, fbtrace_id } }`) ou de rede (`code: 'network'`). */
export class MetaGraphError extends Error {
  readonly status: number
  readonly code: number | string | null
  readonly subcode: number | null
  readonly type: string | null
  readonly fbtraceId: string | null

  constructor(message: string, info: MetaGraphErrorInfo) {
    super(message)
    this.name = 'MetaGraphError'
    this.status = info.status
    this.code = info.code
    this.subcode = info.subcode
    this.type = info.type
    this.fbtraceId = info.fbtraceId
  }

  /** Token inválido/expirado/revogado (código 190): o perfil precisa reconectar. */
  get isTokenError(): boolean {
    return this.code === 190 || (this.type === 'OAuthException' && this.code === 102)
  }

  /** Limites de taxa da Marketing API (STACK E §1.5): adiar, não contar como falha. */
  get isRateLimit(): boolean {
    return [4, 17, 32, 613, 80000, 80003, 80004, 80014].includes(Number(this.code))
  }
}

export interface GraphClientOptions {
  /** Base sem versão (ex.: `https://graph.facebook.com`) ou com versão (`META_GRAPH_URL`). Default: a Graph real. */
  graphUrl?: string
  /** Default: a da `graphUrl`, senão `META_GRAPH_VERSION`. */
  version?: string
  appSecret: string
  /** Token padrão das chamadas (o do perfil). */
  accessToken?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export interface GraphCallOptions {
  /** Sobrepõe o token padrão; `null` = sem token (ex.: troca de code por token). */
  accessToken?: string | null
}

interface Paged<T> {
  data?: T[]
  paging?: { next?: string }
}

export class GraphClient {
  readonly graphUrl: string
  readonly version: string
  private readonly opts: GraphClientOptions
  private readonly doFetch: typeof globalThis.fetch
  /** Último `x-business-use-case-usage`/`x-ad-account-usage` visto (métrica de rate limit). */
  lastUsage: { business: string | null; adAccount: string | null } = { business: null, adAccount: null }

  constructor(opts: GraphClientOptions) {
    if (!opts.appSecret) throw new Error('GraphClient: appSecret é obrigatório (appsecret_proof)')
    const parsed = parseGraphUrl(opts.graphUrl)
    this.graphUrl = parsed.graphUrl
    this.version = opts.version ?? parsed.version
    this.opts = opts
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
  }

  /** Mesmo cliente com outro token padrão. */
  withToken(accessToken: string): GraphClient {
    return new GraphClient({ ...this.opts, graphUrl: this.graphUrl, version: this.version, accessToken })
  }

  /** URL de `path` na versão configurada (`/v26.0/<path>`). */
  urlOf(path: string): URL {
    return new URL(`${this.graphUrl}/${this.version}/${path.replace(/^\/+/, '')}`)
  }

  async get<T = unknown>(path: string, params: GraphParams = {}, call: GraphCallOptions = {}): Promise<T> {
    const url = this.urlOf(path)
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    return this.send<T>('GET', url, call)
  }

  async post<T = unknown>(path: string, params: GraphParams = {}, call: GraphCallOptions = {}): Promise<T> {
    const url = this.urlOf(path)
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v))
    return this.send<T>('POST', url, call, body)
  }

  /**
   * Junta todas as páginas seguindo `paging.next`. Só segue links da mesma origem da Graph configurada (o token
   * nunca vai para outro host).
   */
  async getAll<T = unknown>(path: string, params: GraphParams = {}, call: GraphCallOptions & { maxPages?: number } = {}): Promise<T[]> {
    const items: T[] = []
    let page = await this.get<Paged<T>>(path, params, call)
    const origin = new URL(this.graphUrl).origin
    for (let n = 1; ; n++) {
      items.push(...(page.data ?? []))
      const next = page.paging?.next
      if (!next) return items
      if (n >= (call.maxPages ?? DEFAULT_MAX_PAGES)) throw new MetaGraphError('paginação excedeu o limite de páginas', { status: 0, code: 'too_many_pages', subcode: null, type: null, fbtraceId: null })
      const url = new URL(next)
      if (url.origin !== origin) throw new MetaGraphError(`paging.next de outra origem: ${url.origin}`, { status: 0, code: 'foreign_next', subcode: null, type: null, fbtraceId: null })
      page = await this.send<Paged<T>>('GET', url, call)
    }
  }

  private token(call: GraphCallOptions): string | null {
    return call.accessToken === null ? null : (call.accessToken ?? this.opts.accessToken ?? null)
  }

  private async send<T>(method: 'GET' | 'POST', url: URL, call: GraphCallOptions, body?: URLSearchParams): Promise<T> {
    const token = this.token(call)
    // Token e prova vão sempre (inclusive em `paging.next`, que pode trazê-los ou não).
    const target = body ?? url.searchParams
    if (token) {
      target.set('access_token', token)
      target.set('appsecret_proof', appsecretProof(token, this.opts.appSecret))
    }
    let res: Response
    try {
      res = await this.doFetch(url, {
        method,
        ...(body ? { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      })
    } catch (err) {
      throw new MetaGraphError(`Graph inacessível: ${err instanceof Error ? err.message : String(err)}`, { status: 0, code: 'network', subcode: null, type: null, fbtraceId: null })
    }
    this.lastUsage = { business: res.headers.get('x-business-use-case-usage'), adAccount: res.headers.get('x-ad-account-usage') }
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      throw new MetaGraphError(`resposta inválida da Graph (HTTP ${res.status})`, { status: res.status, code: 'invalid_response', subcode: null, type: null, fbtraceId: null })
    }
    const error = (json as { error?: Record<string, unknown> }).error
    if (!res.ok || error) {
      const e = error ?? {}
      throw new MetaGraphError(typeof e.message === 'string' ? e.message : `Graph HTTP ${res.status}`, {
        status: res.status,
        code: typeof e.code === 'number' || typeof e.code === 'string' ? e.code : null,
        subcode: typeof e.error_subcode === 'number' ? e.error_subcode : null,
        type: typeof e.type === 'string' ? e.type : null,
        fbtraceId: typeof e.fbtrace_id === 'string' ? e.fbtrace_id : null,
      })
    }
    return json as T
  }
}
