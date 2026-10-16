// Ambiente da suíte T31: banco descartável migrado, Redis real, app de `@crm/api` (sem porta), sessões reais
// (register/login) e RealtimePublisher de `@crm/core` para o SSE. Contrato combinado com o Torno.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { ensureConnection } from '../helpers/connections'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  core: Any
  app: Any
  publisher: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  for (const n of ['isOpen', 'chatScopeFor', 'RealtimePublisher']) if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const conns: Any[] = []
  const redis = () => {
    const r = redisConnection({})
    r.on?.('error', () => {})
    conns.push(r)
    return r
  }
  const app = api.createApp({ db, redis: redis(), mailer: new MemoryMailer(), trustProxy: true })
  const publisher = new core.RealtimePublisher({ redis: redis() })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    core,
    app,
    publisher,
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

export function clientOn(app: Any, companyId?: string): ApiClient {
  const ip = randomIp()
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return app.request(path, { ...init, headers })
    },
    companyId: companyId ?? null,
  })
}

export interface User {
  c: ApiClient
  userId: string
  companyId: string
  cookie: string
}

/** Cadastro + login reais (owner da própria empresa). */
export async function newOwner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t31')
  const c = clientOn(env.app)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t31')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  return { c, userId: login.body.user.id, companyId, cookie: `crm_session=${c.cookies.get('crm_session')}` }
}

/** Outro usuário real vinculado à empresa do owner com o papel dado; devolve também o company_members.id. */
export async function addMember(env: Env, owner: User, role: 'admin' | 'member') {
  const u = await newOwner(env)
  const [m] = await env.q(`INSERT INTO crm.company_members (company_id, user_id, role) VALUES ($1, $2, $3) RETURNING id`, [owner.companyId, u.userId, role])
  u.c.setCompany(owner.companyId)
  return { ...u, companyId: owner.companyId, memberId: m.id as string }
}

export async function createDepartment(c: ApiClient, name = uniqueId('Depto'), color?: string) {
  const res = await c.post('/api/departments', color === undefined ? { name } : { name, color })
  if (res.status !== 201) throw new Error(`criar departamento falhou: ${res.status} ${res.text}`)
  return res.body.department as { id: string; name: string; color: string }
}

export async function insertFlow(env: Env, companyId: string, name = uniqueId('Fluxo')) {
  const [f] = await env.q(`INSERT INTO crm.flows (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, name])
  return f.id as string
}

export async function insertChat(env: Env, companyId: string, departmentId: string | null) {
  const [contact] = await env.q(`INSERT INTO crm.contacts (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, uniqueId('Contato')])
  const connectionId = await ensureConnection(env.q, companyId)
  const [chat] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id, department_id) VALUES ($1, $4, $2, $3) RETURNING id`, [
    companyId,
    contact.id,
    departmentId,
    connectionId,
  ])
  return chat.id as string
}

export const fieldPaths = (res: { body: Any }) =>
  (res.body?.error?.details?.fields ?? []).map((f: Any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))

export const uuid = () => crypto.randomUUID()

/** Conexão real da empresa (FK connection_id desde a T40). */
export const newConnection = (env: Env, companyId: string) => ensureConnection(env.q, companyId)
