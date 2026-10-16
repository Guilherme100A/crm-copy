// Cliente HTTP da SPA (SPEC 3.4/3.6; spec 21 "Cliente HTTP"): cookie de sessão (mesma origem), `X-Company-Id` da
// empresa ativa, `X-Requested-With: crm` (CSRF), JSON, deduplicação de GETs idênticos em voo e tratamento de 401:
// uma chamada qualquer com 401 dispara UMA sonda em `GET /api/auth/profile` (compartilhada entre chamadas
// simultâneas); se a sonda também der 401, o handler leva ao `/login?redirect=` (AC-T23-06).

export const PROFILE_PATH = '/api/auth/profile'
export const CSRF_HEADER = 'X-Requested-With'
export const CSRF_VALUE = 'crm'
export const COMPANY_HEADER = 'X-Company-Id'

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
  probe: Promise<boolean> | null
  inflight: Map<string, Promise<unknown>>
}

const state: HttpState = {
  companyId: null,
  fetch: (input, init) => globalThis.fetch(input, init),
  onUnauthorized: () => undefined,
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

/** Testes: troca o fetch e zera o estado. */
export function configureHttp(opts: { fetch?: FetchLike; companyId?: string | null; onUnauthorized?: () => void }): void {
  if (opts.fetch) state.fetch = opts.fetch
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
    .fetch(PROFILE_PATH, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json', [CSRF_HEADER]: CSRF_VALUE } })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      // Libera a próxima sonda depois que todas as chamadas desta rodada viram o resultado.
      setTimeout(() => (state.probe = null), 0)
    })
  return state.probe
}

let redirecting = false

async function handle401(err: HttpError): Promise<never> {
  const alive = await probeSession()
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
  const res = await state.fetch(buildUrl(path, opts.query), { method, headers, body, credentials: 'same-origin', signal: opts.signal })
  if (res.ok) {
    if (res.status === 204) return undefined as T
    const type = res.headers.get('content-type') ?? ''
    return (type.includes('application/json') ? await res.json() : await res.text()) as T
  }
  const err = await parseError(res)
  // O próprio perfil (GET) é a sonda: o guard decide; nas demais chamadas, sonda única e login se a sessão acabou.
  if (res.status === 401 && !(method === 'GET' && path === PROFILE_PATH)) return handle401(err)
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
