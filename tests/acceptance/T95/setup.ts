// Ambiente da suíte T95 (admin: usuários, empresas, limites e cotas). Contrato do Operário (Prisma2, brief T95):
// tudo sob /api/admin/* com platform_admin; createApp deps: waGateway (FakeWaGateway), admin.now (relógio injetável).
// platform_admin no teste: cadastro + login e `UPDATE crm.users SET system_role = 'platform_admin'`.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  wa: Any
  clock: { t: Date }
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
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const wa = new FakeWaGateway()
    const clock = { t: new Date('2026-10-31T12:00:00Z') }
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: wa,
      admin: { now: () => clock.t },
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, wa, clock, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export function client(env: Env): ApiClient {
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
  email: string
  password: string
}

export async function login(env: Env, email: string, password: string): Promise<ApiClient | null> {
  const c = client(env)
  const res = await c.post('/api/auth/login', { email, password })
  return res.status === 200 ? c : null
}

/** Cadastro público: cria usuário + empresa própria (owner). */
export async function newOwner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t95')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t95')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const logged = await login(env, email, password)
  if (!logged) throw new Error('login falhou')
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  logged.setCompany(m.company_id)
  return { c: logged, userId: u.id, companyId: m.company_id, email, password }
}

export async function newAdmin(env: Env): Promise<User> {
  const u = await newOwner(env)
  await env.q(`UPDATE crm.users SET system_role = 'platform_admin' WHERE id = $1`, [u.userId])
  return u
}

export const adminLogs = (env: Env, where = 'true', params: unknown[] = []) =>
  env.q(`SELECT * FROM crm.audit_logs WHERE action LIKE 'admin.%' AND ${where} ORDER BY created_at, id`, params)

export const fieldPaths = (res: { body: Any }) =>
  (res.body?.error?.details?.fields ?? []).map((f: Any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))
