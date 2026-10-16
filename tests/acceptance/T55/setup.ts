// Ambiente da suíte T55 (dashboard de vendas, bootstrap e marcos). Contrato combinado com o Operário (Bigorna):
// GET /api/dashboard?start_date&end_date (YYYY-MM-DD inclusivos no fuso da empresa)&connection_ids[]&product_ids[]&force_refresh=1
//   → { range, previous_range, cached, computed_at, sales? { kpis, previous, trends, sales_over_time, sales_by_hour,
//       sales_by_connection, sales_by_state, sales_by_product, expenses_breakdown, revenue_by_currency } }
// GET /api/dashboard/bootstrap → { products, connections, filter_groups, announcements, banners, leads_count, lifetime_revenue? }
// createApp deps: adSpendProvider { getSpend({ companyId, startDate, endDate, timeZone, connectionIds }) → centavos }.
// @crm/core: computeMilestone(revenueCents, locale) e MILESTONES.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface SpendQuery {
  companyId: string
  startDate: string
  endDate: string
  timeZone: string
  connectionIds: string[]
}

/** Fake de AdSpendProvider: gasto por (empresa, início, fim); ausente = 0. Registra as chamadas. */
export class FakeAdSpend {
  readonly calls: SpendQuery[] = []
  private readonly table = new Map<string, number>()
  set(companyId: string, startDate: string, endDate: string, cents: number) {
    this.table.set(`${companyId}|${startDate}|${endDate}`, cents)
  }
  // propriedade (não método): funciona mesmo se o provider for desestruturado
  readonly getSpend = async (q: SpendQuery): Promise<number> => {
    this.calls.push({ ...q, connectionIds: [...(q.connectionIds ?? [])] })
    return this.table.get(`${q.companyId}|${q.startDate}|${q.endDate}`) ?? 0
  }
}

export interface Env {
  tmp: TempDatabase
  db: Any
  core: Any
  app: Any
  spend: FakeAdSpend
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
    const spend = new FakeAdSpend()
    const app = api.createApp({ db, redis, mailer: new MemoryMailer(), waGateway: new FakeWaGateway(), adSpendProvider: spend, trustProxy: true })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, core, app, spend, q, close }
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
  const email = fakeEmail('t55')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t55')}`, email, password, password_confirmation: password })
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

export async function setTimeZone(env: Env, companyId: string, tz: string) {
  await env.q(`UPDATE crm.companies SET time_zone = $2 WHERE id = $1`, [companyId, tz])
}

export async function newConnection(env: Env, companyId: string, name: string, phone: string | null = null): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.connections (company_id, session_id, name, phone_number) VALUES ($1, $2, $3, $4) RETURNING id`, [
    companyId,
    `sess-t55-${uniqueId('s').toLowerCase()}`,
    name,
    phone,
  ])
  return r.id
}

export async function newContact(env: Env, companyId: string, state: string | null = null, name = `Lead ${uniqueId('c')}`): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.contacts (company_id, name, state) VALUES ($1, $2, $3) RETURNING id`, [companyId, name, state])
  return r.id
}

export async function newProduct(env: Env, companyId: string, name: string): Promise<string> {
  const [r] = await env.q(
    `INSERT INTO crm.products (company_id, name, price_min_cents, price_max_cents, price_fallback_cents) VALUES ($1, $2, 100, 100000, 100) RETURNING id`,
    [companyId, name],
  )
  return r.id
}

export interface SaleInput {
  amount: number
  /** Instante com offset explícito, ex.: '2026-06-01T09:30:00-03:00'. */
  at: string
  status?: 'approved' | 'refunded' | 'chargeback' | 'pending'
  currency?: string
  connectionId?: string | null
  productId?: string | null
  contactId?: string | null
}

export async function addSale(env: Env, companyId: string, s: SaleInput): Promise<string> {
  const [r] = await env.q(
    `INSERT INTO crm.sales (company_id, amount_cents, currency, sold_at, status, connection_id, product_id, contact_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [companyId, s.amount, s.currency ?? 'BRL', s.at, s.status ?? 'approved', s.connectionId ?? null, s.productId ?? null, s.contactId ?? null],
  )
  return r.id
}

/** Mensagem no chat (contato × conexão), criando o chat se preciso. */
export async function addMessage(env: Env, companyId: string, connectionId: string, contactId: string, at: string, direction: 'inbound' | 'outbound' = 'inbound') {
  const [chat] = await env.q(
    `INSERT INTO crm.chats (company_id, connection_id, contact_id, opened_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, connection_id, contact_id) DO UPDATE SET updated_at = now() RETURNING id`,
    [companyId, connectionId, contactId, at],
  )
  await env.q(
    `INSERT INTO crm.messages (company_id, chat_id, direction, sender_type, type, body, status, sent_at, created_at)
     VALUES ($1, $2, $3, $4, 'text', 'oi', $5, $6, $6)`,
    [companyId, chat.id, direction, direction === 'inbound' ? 'contact' : 'user', direction === 'inbound' ? 'received' : 'sent', at],
  )
}

export interface DashQuery {
  start: string
  end: string
  connectionIds?: string[]
  productIds?: string[]
  force?: boolean
}

export function dashPath(p: DashQuery): string {
  const qs = new URLSearchParams({ start_date: p.start, end_date: p.end })
  for (const id of p.connectionIds ?? []) qs.append('connection_ids[]', id)
  for (const id of p.productIds ?? []) qs.append('product_ids[]', id)
  if (p.force) qs.set('force_refresh', '1')
  return `/api/dashboard?${qs.toString()}`
}

export async function dashboard(u: User, p: DashQuery): Promise<Any> {
  const res = await u.c.get(dashPath(p))
  if (res.status !== 200) throw new Error(`GET ${dashPath(p)} → ${res.status} ${res.text}`)
  return res.body
}

/** Lista de datas YYYY-MM-DD de a até b (inclusivo). */
export function days(a: string, b: string): string[] {
  const out: string[] = []
  for (let d = new Date(`${a}T00:00:00Z`); d <= new Date(`${b}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10))
  return out
}
