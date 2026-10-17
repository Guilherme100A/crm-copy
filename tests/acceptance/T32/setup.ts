// Ambiente da suíte T32 (acesso de suporte). Contrato do Operário (Prisma2, brief "Entrega do operário"):
// - usuário `support` inserido direto no banco (T95 ainda não cria) e logado por POST /api/auth/login;
// - lado suporte /api/support/access-requests[/lookup|/:id|/:id/resend], /api/support/access-grants[/:companyId/flows];
// - lado empresa (owner/admin) /api/support-access/requests[/:id/approve|reject], /api/support-access/grants[/:supportUserId];
// - relógio injetável `supportAccess.now` (aqui: Date.now() + env.offsetMs) para a validade de 12 h, sem sleep;
// - eventos `support_access.*` em `<prefix>:<companyId>` e `<prefix>:user:<supportUserId>` (lidos por XRANGE).
import { randomBytes } from 'node:crypto'
import { createDb, users } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { hashPassword, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient, type ApiClient } from '../helpers/http'
import { connectSse, type SseConnection } from '../helpers/sse'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const HOUR = 3_600_000

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  app: Any
  rtPrefix: string
  /** deslocamento do relógio do acesso de suporte (ms) */
  offsetMs: number
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const rtPrefix = `crm:rt:t32-${randomBytes(4).toString('hex')}`
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    const keys: string[] = await redis.keys(`${rtPrefix}*`).catch(() => [])
    if (keys.length) await redis.del(...keys).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const env = { tmp, db, redis, rtPrefix, offsetMs: 0 } as Env
    env.app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: new FakeWaGateway(),
      trustProxy: true,
      realtime: { prefix: rtPrefix },
      supportAccess: { now: () => new Date(Date.now() + env.offsetMs) },
    })
    env.q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    env.close = close
    return env
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
  email: string
  name: string
  /** empresa do cadastro (owner); null para o usuário `support` */
  companyId: string | null
  token: string
}

async function login(env: Env, email: string, password: string, name: string): Promise<User> {
  const c = client(env)
  const res = await c.post('/api/auth/login', { email, password })
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${res.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m?.company_id ?? null)
  return { c, userId: u.id, email, name, companyId: m?.company_id ?? null, token: c.cookies.get('crm_session')! }
}

/** Cadastro pela T15: owner da "Minha empresa", cliente com ela ativa. */
export async function newOwner(env: Env): Promise<User & { companyId: string }> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t32')
  const name = `Pessoa ${uniqueId('t32')}`
  const reg = await client(env).post('/api/auth/register', { name, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  return (await login(env, email, password, name)) as User & { companyId: string }
}

/** Usuário novo vinculado à empresa com o papel dado; cliente apontando para ela. */
export async function newMember(env: Env, companyId: string, role: 'admin' | 'member', keys: string[] | null = null): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4)`, [companyId, u.userId, role, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

/** Usuário de sistema `support` (sem empresa), inserido no banco e logado. */
export async function newSupport(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('suporte')
  const name = `Suporte ${uniqueId('sp')}`
  await env.db.insert(users).values({ email, name, passwordHash: await hashPassword(password), systemRole: 'support' })
  return login(env, email, password, name)
}

/** Suporte pede acesso à empresa do owner (POST /api/support/access-requests). */
export async function requestAccess(sp: User, owner: User, companyId = owner.companyId) {
  const res = await sp.c.post('/api/support/access-requests', { email: owner.email, company_id: companyId })
  if (res.status !== 201) throw new Error(`pedido de acesso → ${res.status} ${res.text}`)
  return res.body.request
}

/** Pede e aprova (pelo owner); devolve { request, grant }. */
export async function grantAccess(sp: User, owner: User) {
  const request = await requestAccess(sp, owner)
  const res = await owner.c.post(`/api/support-access/requests/${request.id}/approve`)
  if (res.status !== 200) throw new Error(`aprovação → ${res.status} ${res.text}`)
  return res.body as { request: Any; grant: Any }
}

export interface StreamEvent {
  id: string
  type: string
  company_id: string
  user_id: string | null
  data: Any
}

/** Eventos de um stream realtime (XRANGE), opcionalmente filtrados por tipo. */
export async function streamEvents(env: Env, key: string, type?: string): Promise<StreamEvent[]> {
  const rows: Array<[string, string[]]> = await env.redis.xrange(key, '-', '+')
  return rows
    .map(([id, flat]) => {
      const f: Record<string, string> = {}
      for (let i = 0; i + 1 < flat.length; i += 2) f[flat[i]!] = flat[i + 1]!
      return { id, type: f.type!, company_id: f.company_id!, user_id: f.user_id ?? null, data: f.data ? JSON.parse(f.data) : null }
    })
    .filter((e) => !type || e.type === type)
}

export const companyStream = (env: Env, companyId: string) => `${env.rtPrefix}:${companyId}`
export const userStream = (env: Env, userId: string) => `${env.rtPrefix}:user:${userId}`

/** Abre o SSE (T16) do usuário na empresa e espera o ping inicial. */
export async function openEvents(env: Env, u: { token: string }, companyId: string): Promise<SseConnection> {
  const conn = await connectSse((path, init) => env.app.request(path, init), `/api/events?company_id=${companyId}`, { cookie: `crm_session=${u.token}` })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((m) => m.event === 'ping', 10_000)
  return conn
}

export const errorCode = (res: { body: Any }) => res.body?.error?.details?.error_code
