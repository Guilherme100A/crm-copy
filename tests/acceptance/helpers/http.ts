// Cliente HTTP caixa-preta da API (SPEC 3.4–3.6): cookie `crm_session`, Bearer `crm_pat_*`,
// `X-Company-Id` e `X-Requested-With: crm` em requisições mutantes.
import { expect } from 'vitest'

export interface ApiResponse<T = any> {
  status: number
  headers: Headers
  body: T
  text: string
}

/** Qualquer coisa com a forma de `app.request()` do Hono ou um `fetch` contra servidor local. */
export type Fetcher = (url: string, init: RequestInit) => Response | Promise<Response>

export interface ApiClientOptions {
  /** Base para fetch real (ex.: http://127.0.0.1:3000). Ignorado se `fetcher` vier. */
  baseUrl?: string
  /** Ex.: `(path, init) => app.request(path, init)` para testar sem rede. */
  fetcher?: Fetcher
  /** Token de integração (`crm_pat_...`). */
  token?: string | null
  companyId?: string | null
}

export const DEFAULT_BASE_URL = process.env.CRM_API_URL ?? 'http://127.0.0.1:3000'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function createClient(opts: ApiClientOptions = {}) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const cookies = new Map<string, string>()
  const state = { token: opts.token ?? null, companyId: opts.companyId ?? null }
  const doFetch: Fetcher = opts.fetcher ?? ((path, init) => fetch(`${baseUrl}${path}`, init))

  function storeCookies(headers: Headers) {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''].filter(Boolean)
    for (const c of list) {
      const [pair] = c.split(';')
      const idx = pair!.indexOf('=')
      if (idx <= 0) continue
      const name = pair!.slice(0, idx).trim()
      const value = pair!.slice(idx + 1).trim()
      if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) cookies.delete(name)
      else cookies.set(name, value)
    }
  }

  async function request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const h: Record<string, string> = { accept: 'application/json' }
    if (state.token) h.authorization = `Bearer ${state.token}`
    if (state.companyId) h['x-company-id'] = state.companyId
    if (MUTATING.has(method)) h['x-requested-with'] = 'crm'
    if (cookies.size) h.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    if (body !== undefined) h['content-type'] = 'application/json'
    Object.assign(h, headers)
    const res = await doFetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    storeCookies(res.headers)
    const text = await res.text()
    let parsed: any = text
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      /* corpo não-JSON: mantém texto */
    }
    return { status: res.status, headers: res.headers, body: parsed as T, text }
  }

  return {
    baseUrl,
    cookies,
    setCompany: (id: string | null) => void (state.companyId = id),
    setToken: (t: string | null) => void (state.token = t),
    request,
    get: <T = any>(p: string, h?: Record<string, string>) => request<T>('GET', p, undefined, h),
    post: <T = any>(p: string, b?: unknown, h?: Record<string, string>) => request<T>('POST', p, b ?? {}, h),
    put: <T = any>(p: string, b?: unknown, h?: Record<string, string>) => request<T>('PUT', p, b ?? {}, h),
    patch: <T = any>(p: string, b?: unknown, h?: Record<string, string>) => request<T>('PATCH', p, b ?? {}, h),
    delete: <T = any>(p: string, h?: Record<string, string>) => request<T>('DELETE', p, undefined, h),
  }
}

export type ApiClient = ReturnType<typeof createClient>

/** Confere o formato de erro da SPEC 3.5: `{ error: { code, message, details? } }`. */
export function expectApiError(res: ApiResponse, code: string, status: number) {
  expect(res.status, `HTTP esperado ${status}; corpo: ${res.text.slice(0, 300)}`).toBe(status)
  expect(res.body?.error?.code).toBe(code)
  expect(typeof res.body?.error?.message).toBe('string')
}

/** Espera até a URL responder (qualquer status HTTP). */
export async function waitForHttp(url: string, timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      await fetch(url)
      return
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  throw new Error(`timeout esperando ${url}: ${String(last)}`)
}
