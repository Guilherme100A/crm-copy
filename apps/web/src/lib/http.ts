// Cliente HTTP da SPA (SPEC 3.4/3.6; spec 21 "Cliente HTTP"): cookie de sessão (mesma origem), `X-Company-Id` da
// empresa ativa, `X-Requested-With: crm` (CSRF), JSON, deduplicação de GETs idênticos em voo e tratamento de 401:
// uma chamada qualquer com 401 dispara UMA sonda em `GET /api/auth/profile` (compartilhada entre chamadas
// simultâneas); se a sonda também der 401, o handler leva ao `/login?redirect=` (AC-T23-06).

import { apiUrl, appPath } from './base'

export const PROFILE_PATH = '/api/auth/profile'
export const CSRF_HEADER = 'X-Requested-With'
export const CSRF_VALUE = 'crm'
export const COMPANY_HEADER = 'X-Company-Id'
/** T54: 403 do suporte com a concessão expirada/revogada na empresa do `X-Company-Id` (decisão da T32). */
export const SUPPORT_ACCESS_EXPIRED = 'support_access_expired'
export const SUPPORT_HOME = '/support/access'
/** T102 (pendência da T53): 403 do `companyActiveGuard` quando a empresa ativa está desativada (T22). */
export const COMPANY_INACTIVE = 'company_inactive'

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown }
}

/** Erro HTTP no formato da SPEC 3.5. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[]

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Objeto vira JSON; FormData/Blob vão como estão. */
  body?: unknown
  query?: Record<string, QueryValue>
  headers?: Record<string, string>
  signal?: AbortSignal
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

interface HttpState {
  companyId: string | null
  fetch: FetchLike
  onUnauthorized: () => void
  onSupportAccessExpired: () => void
  onCompanyInactive: () => void
  probe: Promise<boolean> | null
  inflight: Map<string, Promise<unknown>>
}

const state: HttpState = {
  companyId: null,
  fetch: (input, init) => globalThis.fetch(input, init),
  onUnauthorized: () => undefined,
  // Recarrega a SPA na tela do suporte: o perfil é relido sem o `X-Company-Id` antigo e o cache some junto.
  onSupportAccessExpired: () => {
    if (typeof window !== 'undefined') window.location.assign(appPath(SUPPORT_HOME))
  },
  onCompanyInactive: () => undefined,
  probe: null,
  inflight: new Map(),
}

/** Empresa ativa enviada em `X-Company-Id` (null = a do perfil no servidor). */
export function setActiveCompany(companyId: string | null): void {
  state.companyId = companyId
}

export const activeCompany = (): string | null => state.companyId

/** Para onde ir quando a sessão acabou (o main liga ao router: limpa o cache e navega ao login). */
export function setUnauthorizedHandler(fn: () => void): void {
  state.onUnauthorized = fn
}

/** Aviso de empresa desativada (o main liga ao toast); chamado uma vez por rodada de chamadas. */
export function setCompanyInactiveHandler(fn: () => void): void {
  state.onCompanyInactive = fn
}

/** Testes: troca o fetch e zera o estado. */
export function configureHttp(opts: {
  fetch?: FetchLike
  companyId?: string | null
  onUnauthorized?: () => void
  onSupportAccessExpired?: () => void
  onCompanyInactive?: () => void
}): void {
  if (opts.fetch) state.fetch = opts.fetch
  if (opts.onSupportAccessExpired) state.onSupportAccessExpired = opts.onSupportAccessExpired
  if (opts.onCompanyInactive) state.onCompanyInactive = opts.onCompanyInactive
  companyInactiveAt = 0
  sessionDead = false
  if (opts.companyId !== undefined) state.companyId = opts.companyId
  if (opts.onUnauthorized) state.onUnauthorized = opts.onUnauthorized
  state.probe = null
  state.inflight.clear()
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) for (const item of v) params.append(k, String(item))
    else params.append(k, String(v))
  }
  const qs = params.toString()
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path
}

async function parseError(res: Response): Promise<HttpError> {
  let body: ApiErrorBody | null = null
  try {
    body = (await res.json()) as ApiErrorBody
  } catch {
    // corpo não-JSON (proxy, 502 do servidor web)
  }
  const code = body?.error?.code ?? (res.status >= 500 ? 'INTERNAL' : 'HTTP_ERROR')
  return new HttpError(res.status, code, body?.error?.message ?? res.statusText ?? code, body?.error?.details)
}

/** Uma única sonda de sessão por vez; `true` se a sessão ainda vale. */
function probeSession(): Promise<boolean> {
  state.probe ??= state
    .fetch(apiUrl(PROFILE_PATH), { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json', [CSRF_HEADER]: CSRF_VALUE } })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      // Libera a próxima sonda depois que todas as chamadas desta rodada viram o resultado.
      setTimeout(() => (state.probe = null), 0)
    })
  return state.probe
}

let redirecting = false
let supportExpired = false

/** O erro é o 403 `support_access_expired`? */
export function isSupportAccessExpired(err: unknown): boolean {
  return (
    err instanceof HttpError &&
    err.status === 403 &&
    (err.details as { error_code?: string } | undefined)?.error_code === SUPPORT_ACCESS_EXPIRED
  )
}

/** T54: zera a empresa ativa e leva o suporte a `/support/access` (uma vez por rodada de chamadas). */
function handleSupportAccessExpired(): void {
  state.companyId = null
  state.inflight.clear()
  if (supportExpired) return
  supportExpired = true
  try {
    state.onSupportAccessExpired()
  } finally {
    setTimeout(() => (supportExpired = false), 1000)
  }
}

/** O erro é o 403 `company_inactive`? */
export function isCompanyInactive(err: unknown): boolean {
  return err instanceof HttpError && err.status === 403 && (err.details as { error_code?: string } | undefined)?.error_code === COMPANY_INACTIVE
}

let companyInactiveAt = 0

/** Várias telas falham juntas com a empresa desativada: um aviso só a cada 5 s. */
function handleCompanyInactive(now = Date.now()): void {
  if (now - companyInactiveAt < 5000) return
  companyInactiveAt = now
  state.onCompanyInactive()
}

/**
 * A sonda já disse que a sessão acabou: os 401 seguintes (ex.: queries da tela que está saindo, disparadas depois do
 * redirect) não sondam de novo até uma resposta OK (o login). Uma só sonda por 401 (AC-T23-06; T102).
 */
let sessionDead = false

async function handle401(err: HttpError): Promise<never> {
  if (sessionDead) throw err
  const alive = await probeSession()
  if (!alive) sessionDead = true
  if (!alive && !redirecting) {
    redirecting = true
    try {
      state.onUnauthorized()
    } finally {
      setTimeout(() => (redirecting = false), 1000)
    }
  }
  throw err
}

async function send<T>(path: string, opts: RequestOptions): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json', [CSRF_HEADER]: CSRF_VALUE, ...opts.headers }
  if (state.companyId) headers[COMPANY_HEADER] = state.companyId
  let body: BodyInit | undefined
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData || opts.body instanceof Blob || typeof opts.body === 'string') body = opts.body as BodyInit
    else {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
  }
  const res = await state.fetch(apiUrl(buildUrl(path, opts.query)), { method, headers, body, credentials: 'same-origin', signal: opts.signal })
  if (res.ok) {
    sessionDead = false
    if (res.status === 204) return undefined as T
    const type = res.headers.get('content-type') ?? ''
    return (type.includes('application/json') ? await res.json() : await res.text()) as T
  }
  const err = await parseError(res)
  // O próprio perfil (GET) é a sonda: o guard decide; nas demais chamadas, sonda única e login se a sessão acabou.
  if (res.status === 401 && !(method === 'GET' && path === PROFILE_PATH)) return handle401(err)
  if (isSupportAccessExpired(err)) handleSupportAccessExpired()
  if (isCompanyInactive(err)) handleCompanyInactive()
  throw err
}

/** Requisição à API. GETs idênticos em voo (mesma URL e empresa) compartilham a mesma promessa. */
export function http<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  if (method !== 'GET' || opts.signal) return send<T>(path, opts)
  const key = `${state.companyId ?? ''} ${buildUrl(path, opts.query)}`
  const existing = state.inflight.get(key)
  if (existing) return existing as Promise<T>
  const p = send<T>(path, opts).finally(() => state.inflight.delete(key))
  state.inflight.set(key, p)
  return p
}

export const api = {
  get: <T = unknown>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}) => http<T>(path, { ...opts, method: 'GET' }),
  post: <T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) => http<T>(path, { ...opts, method: 'POST', body }),
  put: <T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) => http<T>(path, { ...opts, method: 'PUT', body }),
  patch: <T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) => http<T>(path, { ...opts, method: 'PATCH', body }),
  delete: <T = unknown>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}) => http<T>(path, { ...opts, method: 'DELETE' }),
}
