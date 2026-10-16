// Ambiente da suíte T16: banco descartável migrado, Redis real (db 1), app(s) Hono e publisher do @crm/core.
// Contrato combinado com o Operário (Bigorna):
//  - '@crm/core': RealtimePublisher({ redis }).publish(companyId, type, data, { scope?, userId? }) → id do stream;
//    publisher.endSession(sessionId); registerScopeFilter(fn) → unregister; clearScopeFilters(); SessionService.
//  - '@crm/api': createApp({ db, redis, realtime?: { heartbeatMs? } }) monta GET /api/events; stopRealtimeHub(redis).
//  - Fio: 'event: <type>' / 'id: <stream id>' / 'data: <envelope>'; 'event: ping' imediato ao conectar e a cada heartbeat.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { connectSse, type Fetcher, type SseConnection } from './sse'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export async function loadCore(): Promise<Any> {
  const core: Any = await import('@crm/core')
  for (const n of ['RealtimePublisher', 'registerScopeFilter', 'SessionService'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  return core
}

export async function loadApi(): Promise<Any> {
  const api: Any = await import('@crm/api')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  return api
}

export interface Env {
  tmp: TempDatabase
  db: Any
  core: Any
  api: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  /** cria uma conexão Redis (fechada no close) */
  redis: () => Any
  /** cria um app em processo (cada um com sua própria conexão Redis) */
  makeApp: (realtime?: Record<string, unknown>) => Any
  publisher: Any
  sessions: Any
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const core = await loadCore()
  const api = await loadApi()
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const conns: Any[] = []
  const redis = () => {
    const r = redisConnection({})
    r.on?.('error', () => {})
    conns.push(r)
    return r
  }
  const makeApp = (realtime?: Record<string, unknown>) => api.createApp(realtime ? { db, redis: redis(), realtime } : { db, redis: redis() })
  const publisher = new core.RealtimePublisher({ redis: redis() })
  const sessions = new core.SessionService({ db })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  const close = async () => {
    core.clearScopeFilters?.()
    for (const r of conns) {
      await Promise.resolve(api.stopRealtimeHub?.(r)).catch(() => {})
      await Promise.resolve(r.quit?.()).catch(() => r.disconnect?.())
    }
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  return { tmp, db, core, api, q, redis, makeApp, publisher, sessions, close }
}

export async function seedCompany(env: Env): Promise<string> {
  const [row] = await env.q(`INSERT INTO crm.companies (name, slug) VALUES ($1, $2) RETURNING id`, [uniqueId('Empresa'), uniqueId('slug').toLowerCase()])
  return row.id
}

export async function seedUser(env: Env, lastCompanyId: string | null): Promise<string> {
  const [row] = await env.q(`INSERT INTO crm.users (email, password_hash, name, last_company_id) VALUES ($1, $2, $3, $4) RETURNING id`, [
    fakeEmail('t16'),
    `scrypt$${randomBytes(4).toString('hex')}`,
    'Usuário T16',
    lastCompanyId,
  ])
  return row.id
}

export async function addMember(env: Env, companyId: string, userId: string, role: 'owner' | 'admin' | 'member') {
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role) VALUES ($1, $2, $3)`, [companyId, userId, role])
}

export interface Member {
  companyId: string
  userId: string
  token: string
  sessionId: string
}

/** Usuário com sessão válida (SessionService.create), membro com o papel dado; empresa nova se não informada. */
export async function seedMember(env: Env, role: 'owner' | 'admin' | 'member' = 'owner', companyId?: string): Promise<Member> {
  const cid = companyId ?? (await seedCompany(env))
  const userId = await seedUser(env, cid)
  await addMember(env, cid, userId, role)
  const s = await env.sessions.create(userId, {})
  return { companyId: cid, userId, token: s.token, sessionId: s.sessionId }
}

export const appFetcher =
  (app: Any): Fetcher =>
  (path, init) =>
    app.request(path, init)

/** Abre o stream de eventos da empresa e espera o ping inicial (sinal de pronto). */
export async function openStream(fetcher: Fetcher, m: { token: string; companyId: string }, opts: { lastEventId?: string; query?: string } = {}): Promise<SseConnection> {
  const qs = `company_id=${encodeURIComponent(m.companyId)}${opts.query ? `&${opts.query}` : ''}`
  const conn = await connectSse(fetcher, `/api/events?${qs}`, { cookie: `crm_session=${m.token}`, lastEventId: opts.lastEventId })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((x) => x.event === 'ping', 10_000)
  return conn
}

export const updated = (name: string) => ({ name })
