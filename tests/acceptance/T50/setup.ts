// Ambiente da suíte T50: banco descartável migrado, Redis real (db 1), app `@crm/api` sem porta.
// Sessões reais (register/login); membros por SQL com permission_keys; escopo pela rota da T31;
// contatos, chats e etiquetas de chat semeados por SQL (crm.chats.connection_id solto até a T40).
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, fakePhone, uniqueId } from '../helpers/factories'
import { connectSse, type SseConnection } from '../helpers/sse'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
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
    core.clearScopeFilters?.()
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const app = api.createApp({ db, redis, mailer: new MemoryMailer(), waGateway: new FakeWaGateway(), trustProxy: true })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, q, close }
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
  token: string
  memberId?: string
}

/** Cadastro + login reais: owner da própria empresa (ativa no cliente). */
export async function newOwner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t50')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t50')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id, token: c.cookies.get('crm_session')! }
}

/** Usuário novo como membro da empresa, com lista explícita de permissões (null = matriz padrão do papel). */
export async function newMember(env: Env, companyId: string, keys: string[] | null, role: 'member' | 'admin' = 'member'): Promise<User> {
  const u = await newOwner(env)
  const [m] = await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4) RETURNING id`, [
    companyId,
    u.userId,
    role,
    keys,
  ])
  u.c.setCompany(companyId)
  return { ...u, companyId, memberId: m.id }
}

export async function department(owner: User, name = uniqueId('Depto')): Promise<string> {
  const res = await owner.c.post('/api/departments', { name })
  if (res.status !== 201) throw new Error(`departamento: ${res.status} ${res.text}`)
  return res.body.department.id
}

/** Escopo do membro (T31): departamentos/conexões que ele enxerga. */
export async function setScope(owner: User, memberId: string, departmentIds: string[], connectionIds: string[] = []) {
  const res = await owner.c.put(`/api/departments/members/${memberId}/scope`, { department_ids: departmentIds, connection_ids: connectionIds })
  if (res.status !== 200) throw new Error(`escopo: ${res.status} ${res.text}`)
}

export interface ChatSeed {
  name?: string
  departmentId?: string | null
  status?: 'waiting' | 'attending' | 'resolved'
}

export async function seedChat(env: Env, companyId: string, s: ChatSeed = {}): Promise<string> {
  const [ct] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, $2, $3) RETURNING id`, [companyId, s.name ?? uniqueId('Contato'), fakePhone()])
  const [ch] = await env.q(
    `INSERT INTO crm.chats (company_id, connection_id, contact_id, status, department_id) VALUES ($1, gen_random_uuid(), $2, $3, $4) RETURNING id`,
    [companyId, ct.id, s.status ?? 'waiting', s.departmentId ?? null],
  )
  return ch.id
}

export async function newLabel(env: Env, companyId: string, name = uniqueId('Etq')): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.labels (company_id, name, color) VALUES ($1, $2, 'blue') RETURNING id`, [companyId, name])
  return r.id
}

export async function labelChat(env: Env, companyId: string, chatId: string, labelId: string) {
  await env.q(`INSERT INTO crm.chat_labels (company_id, chat_id, label_id) VALUES ($1, $2, $3)`, [companyId, chatId, labelId])
}

export async function openEvents(env: Env, u: { token: string }, companyId: string): Promise<SseConnection> {
  const conn = await connectSse((path, init) => env.app.request(path, init), `/api/events?company_id=${companyId}`, { cookie: `crm_session=${u.token}` })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((m) => m.event === 'ping', 10_000)
  return conn
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
