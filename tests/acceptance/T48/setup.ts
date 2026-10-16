// Ambiente da suíte T48 (contrato combinado com o Torno):
//  - dois apps sobre o mesmo banco: `app` com deps.chatPublisher espião e `sseApp` sem ele (RealtimePublisher real → /api/events)
//  - ambos com FakeWaGateway (gateway.sent mostra envios)
//  - sessões reais (register/login); membros por SQL com permission_keys; escopo pela rota da T31
//  - contatos, chats e mensagens semeados por SQL (mensagens ordenadas por created_at)
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Published {
  companyId: string
  type: string
  data: Any
  opts: Any
}

export interface Env {
  tmp: TempDatabase
  app: Any
  sseApp: Any
  gateway: Any
  published: Published[]
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  const core: Any = await import('@crm/core')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const conns: Any[] = []
  const redis = () => {
    const r = redisConnection({})
    r.on?.('error', () => {})
    conns.push(r)
    return r
  }
  const gateway = new FakeWaGateway()
  const published: Published[] = []
  const base = { db, mailer: new MemoryMailer(), waGateway: gateway, trustProxy: true }
  const app = api.createApp({
    ...base,
    redis: redis(),
    chatPublisher: {
      async publish(companyId: string, type: string, data: Any, opts?: Any) {
        published.push({ companyId, type, data, opts })
      },
    },
  })
  const sseApp = api.createApp({ ...base, redis: redis() })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    app,
    sseApp,
    gateway,
    published,
    q,
    close: async () => {
      core.clearScopeFilters?.()
      for (const r of conns) {
        await Promise.resolve(api.stopRealtimeHub?.(r)).catch(() => {})
        await Promise.resolve(r.quit?.()).catch(() => r.disconnect?.())
      }
      await db.$client.end().catch(() => {})
      await tmp.drop()
    },
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export interface User {
  c: ApiClient
  userId: string
  companyId: string
  cookie: string
  name: string
}

export function clientOn(app: Any, cookie: string, companyId: string): ApiClient {
  const ip = randomIp()
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return app.request(path, { ...init, headers })
    },
    companyId,
  })
  const [k, v] = cookie.split('=')
  c.cookies.set(k!, v!)
  return c
}

/** Cadastro + login reais: owner da própria empresa. */
export async function newOwner(env: Env, name = `Dona ${uniqueId('t48')}`): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t48')
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', randomIp())
      return env.app.request(path, { ...init, headers })
    },
  })
  const reg = await c.post('/api/auth/register', { name, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  const cookie = `crm_session=${c.cookies.get('crm_session')}`
  return { c: clientOn(env.app, cookie, companyId), userId: login.body.user.id, companyId, cookie, name }
}

/** Usuário real vinculado à empresa do owner, com papel e permissões explícitas. */
export async function addMember(env: Env, owner: User, role: 'admin' | 'member', keys: string[] | null) {
  const u = await newOwner(env, `Atendente ${uniqueId('m')}`)
  const [m] = await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4) RETURNING id`, [
    owner.companyId,
    u.userId,
    role,
    keys,
  ])
  return { ...u, companyId: owner.companyId, c: clientOn(env.app, u.cookie, owner.companyId), memberId: m.id as string }
}

export async function department(owner: User, name = uniqueId('Depto')) {
  const res = await owner.c.post('/api/departments', { name })
  if (res.status !== 201) throw new Error(`departamento: ${res.status} ${res.text}`)
  return res.body.department.id as string
}

export async function setScope(owner: User, memberId: string, departmentIds: string[], connectionIds: string[] = []) {
  const res = await owner.c.put(`/api/departments/members/${memberId}/scope`, { department_ids: departmentIds, connection_ids: connectionIds })
  if (res.status !== 200) throw new Error(`escopo: ${res.status} ${res.text}`)
}

export interface ChatSeed {
  name?: string
  phone?: string | null
  status?: 'waiting' | 'attending' | 'resolved'
  departmentId?: string | null
  assignedUserId?: string | null
  createdAt?: string
  connectionId?: string
  /** mensagens em ordem cronológica: 'in' = do contato, 'out' = do atendente */
  messages?: Array<'in' | 'out'>
}

let clock = Date.parse('2026-09-01T12:00:00Z')

export async function seedChat(env: Env, companyId: string, s: ChatSeed = {}) {
  const [contact] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, $2, $3) RETURNING id`, [
    companyId,
    s.name ?? uniqueId('Contato'),
    s.phone === undefined ? null : s.phone,
  ])
  const createdAt = s.createdAt ?? new Date((clock += 60_000)).toISOString()
  const msgs = s.messages ?? []
  const lastAt = msgs.length ? new Date(Date.parse(createdAt) + msgs.length * 1000).toISOString() : null
  const lastInbound = msgs.lastIndexOf('in')
  const [chat] = await env.q(
    `INSERT INTO crm.chats (company_id, connection_id, contact_id, status, department_id, assigned_user_id, created_at, opened_at, last_message_at, last_inbound_at, resolved_at)
     VALUES ($1, coalesce($2::uuid, gen_random_uuid()), $3, $4, $5, $6, $7, $7, $8, $9, $10) RETURNING id`,
    [
      companyId,
      s.connectionId ?? null,
      contact.id,
      s.status ?? 'waiting',
      s.departmentId ?? null,
      s.assignedUserId ?? null,
      createdAt,
      lastAt,
      lastInbound >= 0 ? new Date(Date.parse(createdAt) + (lastInbound + 1) * 1000).toISOString() : null,
      s.status === 'resolved' ? createdAt : null,
    ],
  )
  for (let i = 0; i < msgs.length; i++) {
    const inbound = msgs[i] === 'in'
    await env.q(
      `INSERT INTO crm.messages (company_id, chat_id, direction, sender_type, type, body, status, created_at)
       VALUES ($1, $2, $3, $4, 'text', $5, $6, $7)`,
      [companyId, chat.id, inbound ? 'inbound' : 'outbound', inbound ? 'contact' : 'user', `msg ${i}`, inbound ? 'received' : 'sent', new Date(Date.parse(createdAt) + (i + 1) * 1000).toISOString()],
    )
  }
  return chat.id as string
}

/** Todos os itens de uma consulta, seguindo o cursor. */
export async function listAll(c: ApiClient, query = '') {
  const items: Any[] = []
  let cursor: string | null = null
  let counts: Any = null
  for (let guard = 0; guard < 50; guard++) {
    const sep = query ? '&' : ''
    const res = await c.get(`/api/chats?${query}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (res.status !== 200) throw new Error(`GET /api/chats?${query} → ${res.status} ${res.text}`)
    items.push(...res.body.items)
    counts ??= res.body.counts
    cursor = res.body.next_cursor
    if (!cursor) break
  }
  return { items, counts, ids: items.map((x) => x.id as string) }
}

export const fieldPaths = (res: { body: Any }) =>
  (res.body?.error?.details?.fields ?? []).map((f: Any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))
