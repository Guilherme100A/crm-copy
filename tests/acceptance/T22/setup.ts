// Ambiente da suíte T22: banco descartável migrado, Redis real (db 1), MemoryMailer e FakeWaGateway.
// App de `@crm/api` testada sem porta (app.request). Contrato combinado com o Operário (Bigorna):
//  createApp({ db, redis, mailer, waGateway, companySessions, invitations: { resendCooldownMs, now }, webPublicUrl })
//  Cadastro/login pela API da T15; convites em /api/team/invitations (gestão) e /api/invitations/:token (público).
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { connectSse, type SseConnection } from '../helpers/sse'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const WEB_URL_T22 = 'http://web.t22.test'

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  mailer: Any
  gateway: Any
  /** companyId → ids de sessão WA da empresa (lido pela dep companySessions) */
  companySessions: Map<string, string[]>
  app: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t22-blobs-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const mailer = new MemoryMailer()
  const gateway = new FakeWaGateway()
  const companySessions = new Map<string, string[]>()
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
    rmSync(storageDir, { recursive: true, force: true })
  }
  try {
    const app = api.createApp({
      db,
      redis,
      mailer,
      blobStore: new FsBlobStore(storageDir),
      waGateway: gateway,
      companySessions: async (companyId: string) => companySessions.get(companyId) ?? [],
      invitations: { resendCooldownMs: 0 },
      webPublicUrl: WEB_URL_T22,
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, redis, mailer, gateway, companySessions, app, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

/** IP fictício único (rate limit de login por IP+e-mail isolado). */
export const fakeIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export function client(env: Env, ip = fakeIp()): ApiClient {
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export const newPassword = () => `Senha-${randomBytes(5).toString('hex')}`

export interface User {
  userId: string
  email: string
  password: string
  name: string
  /** empresa criada no cadastro ("Minha empresa"), da qual é owner */
  companyId: string
  c: ApiClient
  token: string
}

/** Cadastra (T15) e loga; o cliente fica com o cookie e a empresa do cadastro como ativa. */
export async function newUser(env: Env, email = fakeEmail('t22')): Promise<User> {
  const password = newPassword()
  const name = `Pessoa ${uniqueId('t22')}`
  const reg = await client(env).post('/api/auth/register', { name, email, password, password_confirmation: password })
  if (reg.status < 200 || reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  return login(env, email, password, name)
}

export async function login(env: Env, email: string, password: string, name = ''): Promise<User> {
  const c = client(env)
  const res = await c.post('/api/auth/login', { email, password })
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${res.text}`)
  const [row] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [own] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [row.id])
  const companyId = own?.company_id ?? res.body?.companies?.[0]?.id
  c.setCompany(companyId ?? null)
  return { userId: row.id, email, password, name, companyId, c, token: c.cookies.get('crm_session')! }
}

/** Vincula um usuário a uma empresa pelo banco (atalho de fixture; não testa convites). */
export async function addMember(env: Env, companyId: string, userId: string, role: 'admin' | 'member', keys: string[] | null = null) {
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4)`, [companyId, userId, role, keys])
}

/** Usuário novo já membro da empresa dada, com cliente apontando para ela. */
export async function memberOf(env: Env, companyId: string, role: 'admin' | 'member'): Promise<User> {
  const u = await newUser(env)
  await addMember(env, companyId, u.userId, role)
  u.c.setCompany(companyId)
  return u
}

/** Papéis atuais da empresa, direto do banco. */
export async function rolesOf(env: Env, companyId: string): Promise<Record<string, string>> {
  const rows = await env.q(`SELECT user_id, role FROM crm.company_members WHERE company_id = $1`, [companyId])
  return Object.fromEntries(rows.map((r: Any) => [r.user_id, r.role]))
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex')

/** Token cru a partir do invitation_link (<web>/invitations/<token>). */
export function tokenFromLink(link: string): string {
  const u = new URL(link)
  const parts = u.pathname.split('/').filter(Boolean)
  const i = parts.indexOf('invitations')
  const t = i >= 0 ? parts[i + 1] : parts.pop()
  if (!t) throw new Error(`link sem token: ${link}`)
  return decodeURIComponent(t)
}

export function mailsTo(env: Env, to: string): Any[] {
  const all: Any[] = env.mailer.messages ?? []
  return all.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).some((t: string) => String(t).toLowerCase().includes(to.toLowerCase())))
}

/** Abre o SSE do usuário (T16) e espera o ping inicial. */
export async function openEvents(env: Env, u: { token: string }, companyId: string): Promise<SseConnection> {
  const conn = await connectSse((path, init) => env.app.request(path, init), `/api/events?company_id=${companyId}`, { cookie: `crm_session=${u.token}` })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((m) => m.event === 'ping', 10_000)
  return conn
}

export const errorCode = (res: { body: Any }) => res.body?.error?.details?.error_code
