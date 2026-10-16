// Ambiente da suíte T28: banco descartável migrado, Redis real (db 1), app `@crm/api` sem porta.
// Contrato combinado com o Operário (Bigorna): rotas /api/flows*, /api/flow-folders*; PUT /api/flows/:id/definition
// substitui o rascunho; dep `flowReferenceSources: [fn(ctx, flowId) => Ref[]]` para configs de conexão (T61 ainda não existe).
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

export interface Ref {
  kind: 'connection_flow_config' | 'business_hour_config'
  id: string
  name?: string
}

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  app: Any
  /** flowId → referências de configs (lidas pela fonte registrada) */
  refs: Map<string, Ref[]>
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const refs = new Map<string, Ref[]>()
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
      flowReferenceSources: [async (_ctx: Any, flowId: string) => refs.get(flowId) ?? []],
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, redis, app, refs, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

const fakeIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export function client(env: Env, ip = fakeIp()): ApiClient {
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export interface User {
  userId: string
  email: string
  companyId: string
  c: ApiClient
  token: string
}

/** Cadastro + login (T15); o usuário é owner da empresa criada no cadastro, que fica ativa no cliente. */
export async function newOwner(env: Env): Promise<User> {
  const email = fakeEmail('t28')
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const reg = await client(env).post('/api/auth/register', { name: `Pessoa ${uniqueId('t28')}`, email, password, password_confirmation: password })
  if (reg.status < 200 || reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const c = client(env)
  const res = await c.post('/api/auth/login', { email, password })
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${res.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { userId: u.id, email, companyId: m.company_id, c, token: c.cookies.get('crm_session')! }
}

/** Usuário novo como membro da empresa, com lista explícita de permissões. */
export async function newMember(env: Env, companyId: string, keys: string[] | null, role: 'member' | 'admin' = 'member'): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4)`, [companyId, u.userId, role, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

export async function newContact(env: Env, companyId: string): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, $2, $3) RETURNING id`, [companyId, `Contato ${uniqueId('c')}`, fakePhone()])
  return r.id
}

export async function openEvents(env: Env, u: { token: string }, companyId: string): Promise<SseConnection> {
  const conn = await connectSse((path, init) => env.app.request(path, init), `/api/events?company_id=${companyId}`, { cookie: `crm_session=${u.token}` })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((m) => m.event === 'ping', 10_000)
  return conn
}

// ---------- definições (FlowDefinition crm.flow/v1, T10) ----------

const pos = (i: number) => ({ x: 200 * i, y: 40 * i })

export const msgNode = (id: string, i: number, text = `Mensagem ${id}`) => ({
  id,
  type: 'message',
  name: `Nó ${id}`,
  position: pos(i),
  actions: [{ id: `${id}-a1`, type: 'send_message', order: 0, config: { message_text: text } }],
})

export const startNode = () => ({ id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] })

export const edge = (from: string, handle: string, to: string, id = `e-${from}-${to}`) => ({ id, from, handle, to })

export const def = (nodes: Any[], edges: Any[]) => ({ schema: 'crm.flow/v1', entry: 'start', nodes: [startNode(), ...nodes], edges, variables: [], refs: {} })

/** start → m1 → m2 (válida). */
export const validDef = () => def([msgNode('m1', 1), msgNode('m2', 2)], [edge('start', 'source', 'm1'), edge('m1', 'source', 'm2')])

export async function createFlow(u: User, name = uniqueId('Fluxo'), extra: Record<string, unknown> = {}): Promise<Any> {
  const res = await u.c.post('/api/flows', { name, ...extra })
  if (res.status !== 201) throw new Error(`POST /api/flows → ${res.status} ${res.text}`)
  return res.body.flow
}

export async function putDefinition(u: User, flowId: string, d: Any) {
  const res = await u.c.put(`/api/flows/${flowId}/definition`, d)
  if (res.status !== 200) throw new Error(`PUT definition → ${res.status} ${res.text}`)
  return res.body.definition
}

export async function bundle(u: User, flowId: string): Promise<{ flow: Any; definition: Any }> {
  const res = await u.c.get(`/api/flows/${flowId}/editor-bundle`)
  if (res.status !== 200) throw new Error(`editor-bundle → ${res.status} ${res.text}`)
  return res.body
}
