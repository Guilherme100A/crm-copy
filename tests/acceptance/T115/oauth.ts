// Cliente OAuth 2.1 de teste da suíte T115 (sem rede, sem SDK no pacote de testes): register → authorize → consent →
// token (PKCE S256) → refresh → revoke, tudo por `app.request()`. Contrato combinado com o Operário (Forja,
// spec/reports/T115-entrega.md):
// - URL do conector = `connector_url` da credencial `oauth` (`<API>/api/mcp/<id>`); 401 sem token traz
//   `WWW-Authenticate: Bearer realm="mcp", resource_metadata="<API>/.well-known/oauth-protected-resource/api/mcp/<id>"`.
// - POST /api/mcp-oauth/register (RFC 7591) → 201; GET /api/mcp-oauth/authorize → 302 `<WEB>/oauth/consent?request=<id>`;
//   GET/POST /api/mcp-oauth/consent (sessão + X-Requested-With) → `{ redirect_to }` com `code`, `state`, `iss`;
//   POST /api/mcp-oauth/token (form) e /api/mcp-oauth/revoke (RFC 7009). Erros `{ error, error_description }`.
import { createHash, randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { McpClient } from '../T94/mcp'
import type { Env, User } from '../T94/setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const API = 'https://api.crm.test'
export const WEB = 'https://app.crm.test'
export const REDIRECT = 'http://127.0.0.1:9/cb'
export const ACCESS_RE = /^crm_mcpat_[A-Za-z0-9_-]+$/
export const REFRESH_RE = /^crm_mcprt_[A-Za-z0-9_-]+$/
export const TOOLS = ['get_contact', 'list_chats', 'list_connections', 'list_contacts', 'list_flows']

/** App com `API_PUBLIC_URL`/`WEB_PUBLIC_URL` fixos (as URLs absolutas do OAuth saem deles). */
export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: new FakeWaGateway(),
      trustProxy: true,
      mcpEnv: { API_PUBLIC_URL: API, WEB_PUBLIC_URL: WEB },
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

export const pathOf = (url: string) => {
  const u = new URL(url)
  return `${u.pathname}${u.search}`
}

export interface Res {
  status: number
  headers: Headers
  body: Any
  text: string
}

async function wrap(res: Response): Promise<Res> {
  const text = await res.text()
  let body: Any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* não-JSON */
  }
  return { status: res.status, headers: res.headers, body, text }
}

/** Requisição anônima (cliente OAuth / MCP): só os headers dados. Aceita URL absoluta da API. */
export async function raw(env: Env, url: string, init: RequestInit = {}): Promise<Res> {
  return wrap(await env.app.request(url.startsWith('http') ? pathOf(url) : url, { redirect: 'manual', ...init }))
}

export const form = (data: Record<string, string | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(data)) if (v !== undefined) p.set(k, v)
  return p.toString()
}

export const postForm = (env: Env, path: string, data: Record<string, string | undefined>, headers: Record<string, string> = {}) =>
  raw(env, path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(data) })

export function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Credencial `oauth` criada pela API (sessão). */
export async function newOAuthCredential(u: User, name = `Claude ${randomBytes(3).toString('hex')}`) {
  const res = await u.c.post('/api/mcp_credentials', { mcp_credential: { name, auth_type: 'oauth' } })
  if (res.status !== 201) throw new Error(`POST /api/mcp_credentials (oauth) → ${res.status} ${res.text}`)
  return { credential: res.body.mcp_credential as Any, body: res.body as Any, connectorUrl: res.body.mcp_credential.connector_url as string }
}

export async function register(env: Env, body: Record<string, unknown> = {}) {
  return raw(env, '/api/mcp-oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...body }),
  })
}

export async function newClient(env: Env, body: Record<string, unknown> = {}) {
  const r = await register(env, body)
  if (r.status !== 201) throw new Error(`register → ${r.status} ${r.text}`)
  return r.body as Any
}

/** GET /authorize; devolve o 302 cru e o `Location` já parseado. */
export async function authorize(env: Env, params: Record<string, string | undefined>) {
  const r = await raw(env, `/api/mcp-oauth/authorize?${form(params)}`)
  const location = r.headers.get('location')
  return { ...r, location, url: location ? new URL(location) : null }
}

export const consentGet = (u: User, request: string) => u.c.get(`/api/mcp-oauth/consent?request=${encodeURIComponent(request)}`)
export const consentPost = (u: User, body: Record<string, unknown>) => u.c.post('/api/mcp-oauth/consent', body)

export interface Flow {
  client: Any
  verifier: string
  state: string
  request: string
  code: string
  tokens: Any
}

/**
 * Fluxo completo até o `/token`. `approver` aprova no consentimento confirmando a empresa da credencial.
 * `stopAt: 'code'` para antes do `/token` (para testar PKCE e reuso de código).
 */
export async function runFlow(
  env: Env,
  approver: User,
  connectorUrl: string,
  opts: { client?: Any; clientName?: string; stopAt?: 'code' } = {},
): Promise<Flow> {
  const client = opts.client ?? (await newClient(env, opts.clientName ? { client_name: opts.clientName } : {}))
  const { verifier, challenge } = pkce()
  const state = randomBytes(8).toString('hex')
  const az = await authorize(env, {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: connectorUrl,
    scope: 'mcp:read',
  })
  if (az.status !== 302 || !az.url) throw new Error(`authorize → ${az.status} ${az.text}`)
  const request = az.url.searchParams.get('request')
  if (!request) throw new Error(`authorize sem request: ${az.location}`)
  const info = await consentGet(approver, request)
  if (info.status !== 200) throw new Error(`consent GET → ${info.status} ${info.text}`)
  const dec = await consentPost(approver, { request, company_id: info.body.authorization_request.company.id, approve: true })
  if (dec.status !== 200) throw new Error(`consent POST → ${dec.status} ${dec.text}`)
  const back = new URL(dec.body.redirect_to)
  const code = back.searchParams.get('code')
  if (!code) throw new Error(`consent sem code: ${dec.body.redirect_to}`)
  if (opts.stopAt === 'code') return { client, verifier, state, request, code, tokens: null }
  const tok = await exchange(env, client, code, verifier)
  if (tok.status !== 200) throw new Error(`token → ${tok.status} ${tok.text}`)
  return { client, verifier, state, request, code, tokens: tok.body }
}

export const exchange = (env: Env, client: Any, code: string, verifier: string | undefined, extra: Record<string, string | undefined> = {}) =>
  postForm(env, '/api/mcp-oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.client_id, ...extra })

export const refresh = (env: Env, client: Any, refreshToken: string) =>
  postForm(env, '/api/mcp-oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id })

/** Cliente MCP (Streamable HTTP) no caminho dado (ex.: `/api/mcp/<id>`) com o Bearer dado. */
export const mcpAt = (env: Env, path: string, token: string | null) => new McpClient((p, init) => env.app.request(p, init), path, token)

/** Status de um `initialize` no caminho dado com o Bearer dado. */
export async function mcpStatus(env: Env, path: string, token: string | null): Promise<number> {
  return (await mcpAt(env, path, token).initialize()).status
}

/** DTO da credencial na listagem da empresa. */
export async function dtoOf(u: User, id: string): Promise<Any> {
  const res = await u.c.get('/api/mcp_credentials')
  if (res.status !== 200) throw new Error(`GET /api/mcp_credentials → ${res.status} ${res.text}`)
  return (res.body.mcp_credentials as Any[]).find((c) => c.id === id)
}
