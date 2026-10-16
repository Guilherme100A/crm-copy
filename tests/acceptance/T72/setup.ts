// Ambiente da suíte T72 (webhooks de entrada). Contrato combinado com o Operário (Bigorna):
// CRUD em /api/inbound-webhooks (webhooks.view|edit|delete), histórico em GET /api/inbound-webhooks/:id/requests.
// Público: POST /api/hooks/in/:token → 202 { ok, request_id, status } | 404 | 429.
// createApp deps: inboundWebhooksEnqueue(data) (captura o job sem BullMQ), inboundWebhookRateLimit { limit, windowMs }.
// Sem inboundWebhooksEnqueue, o job vai para a fila BullMQ 'inbound-webhooks' (prefixo CRM_QUEUE_PREFIX), jobId `iwr-<requestId>`.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const RATE_LIMIT_SMALL = 3

export interface Env {
  tmp: TempDatabase
  db: Any
  core: Any
  /** App com enqueue capturado e rate limit padrão. */
  app: Any
  /** App com enqueue capturado e rate limit reduzido (RATE_LIMIT_SMALL por 60 s). */
  appRl: Any
  /** App sem enqueue injetado: enfileira na fila BullMQ real. */
  appBull: Any
  enqueued: Any[]
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
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
    const enqueued: Any[] = []
    const base = { db, redis, mailer: new MemoryMailer(), waGateway: new FakeWaGateway(), trustProxy: true }
    const capture = async (data: Any) => void enqueued.push(data)
    const app = api.createApp({ ...base, inboundWebhooksEnqueue: capture })
    const appRl = api.createApp({ ...base, inboundWebhooksEnqueue: capture, inboundWebhookRateLimit: { limit: RATE_LIMIT_SMALL, windowMs: 60_000 } })
    const appBull = api.createApp({ ...base })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, core, app, appRl, appBull, enqueued, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

function client(env: Env): ApiClient {
  const ip = randomIp()
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export interface User {
  c: ApiClient
  userId: string
  companyId: string
}

export async function newOwner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t72')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t72')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id }
}

export async function newMember(env: Env, companyId: string, keys: string[] | null): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

/** Cria um webhook pela API e devolve o DTO. */
export async function newWebhook(u: User, body: Record<string, unknown> = {}): Promise<Any> {
  const res = await u.c.post('/api/inbound-webhooks', { name: `Webhook ${uniqueId('wh')}`, ...body })
  if (res.status !== 201) throw new Error(`POST /api/inbound-webhooks → ${res.status} ${res.text}`)
  return res.body.webhook
}

export interface HookResponse {
  status: number
  headers: Headers
  body: Any
  text: string
  ms: number
}

/** POST público (sem sessão nem CSRF) em /api/hooks/in/:token. */
export async function postHook(
  app: Any,
  token: string,
  body: string | Uint8Array = '{"ok":true}',
  contentType = 'application/json',
): Promise<HookResponse> {
  const t0 = performance.now()
  const res: Response = await app.request(`/api/hooks/in/${token}`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-forwarded-for': randomIp() },
    body,
  })
  const ms = performance.now() - t0
  const text = await res.text()
  let parsed: Any = text
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, headers: res.headers, body: parsed, text, ms }
}

/** Histórico do webhook (todas as páginas, mais recentes primeiro). */
export async function listRequests(u: User, webhookId: string): Promise<Any[]> {
  const all: Any[] = []
  for (let page = 1; ; page++) {
    const res = await u.c.get(`/api/inbound-webhooks/${webhookId}/requests?page=${page}&limit=100`)
    if (res.status !== 200) throw new Error(`GET requests → ${res.status} ${res.text}`)
    all.push(...res.body.items)
    if (!res.body.page?.has_more) return all
  }
}

export async function findRequest(u: User, webhookId: string, requestId: string): Promise<Any> {
  const res = await u.c.get(`/api/inbound-webhooks/${webhookId}/requests?page=1&limit=100`)
  if (res.status !== 200) throw new Error(`GET requests → ${res.status} ${res.text}`)
  return res.body.items.find((r: Any) => r.id === requestId)
}

/** Token público aleatório no mesmo formato (base64url de 32 bytes) que não existe no banco. */
export const randomToken = () => randomBytes(32).toString('base64url')
