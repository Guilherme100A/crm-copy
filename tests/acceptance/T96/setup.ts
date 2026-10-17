// Ambiente da suíte T96 (contrato do Esquadro, spec/briefs/T96.md "Entrega do operário"): createApp + app.request,
// banco temporário, Redis de teste e FakeWaGateway. Injeção: createApp({ waGateway, waProfile, adminOps: { now, queues,
// queuePrefix, waEventsStream, healthTimeoutMs, env } }). platform_admin = crm.users.system_role (SQL) + login normal.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64')

/** Relógio controlável dos avisos/banners do cliente. */
export class Clock {
  constructor(public current = new Date('2026-10-16T12:00:00.000Z')) {}
  readonly now = () => new Date(this.current.getTime())
  set(iso: string) {
    this.current = new Date(iso)
  }
}

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  api: Any
  core: Any
  redis: Any
  wa: FakeWaGateway
  clock: Clock
  /** Monta outro app no mesmo banco/Redis com deps diferentes. */
  makeApp: (extra?: Record<string, unknown>) => Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export interface EnvOptions {
  wa?: FakeWaGateway
  adminOps?: Record<string, unknown>
  extra?: Record<string, unknown>
}

export async function startEnv(o: EnvOptions = {}): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const wa = o.wa ?? new FakeWaGateway()
  const clock = new Clock()
  const makeApp = (extra: Record<string, unknown> = {}) =>
    api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: wa,
      trustProxy: true,
      adminOps: { now: clock.now, ...o.adminOps },
      ...o.extra,
      ...extra,
    })
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const app = makeApp()
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, api, core, redis, wa, clock, makeApp, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

export interface User {
  c: ReturnType<typeof createClient>
  userId: string
  companyId: string
  email: string
}

let ipSeq = 0
const nextIp = () => `10.96.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`

export function clientFor(app: Any) {
  const ip = nextIp()
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return app.request(path, { ...init, headers })
    },
  })
}

/** Cadastra (empresa própria, owner) e loga. */
export async function owner(env: Env, app: Any = env.app): Promise<User> {
  const c = clientFor(app)
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t96')
  const reg = await c.post('/api/auth/register', { name: `Empresa ${uniqueId('t96')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  return { c, userId: u.id, companyId, email }
}

/** Admin da plataforma (papel de sistema). */
export async function platformAdmin(env: Env, app: Any = env.app): Promise<User> {
  const u = await owner(env, app)
  await env.q(`UPDATE crm.users SET system_role = 'platform_admin' WHERE id = $1`, [u.userId])
  return u
}
