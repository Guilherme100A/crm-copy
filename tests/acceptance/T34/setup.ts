// Ambiente da suíte T34 (contrato combinado com o Torno):
//  - SalesService({ db, publisher }) e resolvePrice de `@crm/core`
//  - app de `@crm/api` com deps.salesPublisher espião; sessão real (register/login)
//  - rotas /api/products, /api/sales, /api/sales/expense-rules, /api/sales/filter-groups
import { randomBytes, randomUUID } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Published {
  companyId: string
  type: string
  data: Any
}

export interface Env {
  tmp: TempDatabase
  db: Any
  core: Any
  app: Any
  /** eventos publicados pelo SalesService direto */
  direct: Published[]
  /** eventos publicados pela API (deps.salesPublisher) */
  http: Published[]
  sales: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  for (const n of ['SalesService', 'resolvePrice']) if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const redis = redisConnection({})
  redis.on?.('error', () => {})
  const direct: Published[] = []
  const http: Published[] = []
  const spy = (into: Published[]) => ({
    async publish(companyId: string, type: string, data: Any) {
      into.push({ companyId, type, data })
      return `${Date.now()}-0`
    },
  })
  const app = api.createApp({ db, redis, mailer: new MemoryMailer(), salesPublisher: spy(http), trustProxy: true })
  const sales = new core.SalesService({ db, publisher: spy(direct) })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    core,
    app,
    direct,
    http,
    sales,
    q,
    close: async () => {
      await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
      await Promise.resolve(redis.quit()).catch(() => redis.disconnect())
      await db.$client.end().catch(() => {})
      await tmp.drop()
    },
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export interface Owner {
  c: ApiClient
  userId: string
  companyId: string
}

export async function newOwner(env: Env): Promise<Owner> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t34')
  const ip = randomIp()
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t34')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  return { c, userId: login.body.user.id, companyId }
}

export async function contact(env: Env, companyId: string, attrib: { sourceId?: string | null; ctwaClid?: string | null } = {}) {
  const [row] = await env.q(`INSERT INTO crm.contacts (company_id, name, source_id, ctwa_clid) VALUES ($1, $2, $3, $4) RETURNING id`, [
    companyId,
    uniqueId('Contato'),
    attrib.sourceId ?? null,
    attrib.ctwaClid ?? null,
  ])
  return row.id as string
}

export const PRODUCT = (over: Record<string, unknown> = {}) => ({
  name: uniqueId('Curso'),
  currency: 'BRL',
  price_min_cents: 10_000,
  price_max_cents: 50_000,
  price_fallback_cents: 29_700,
  ...over,
})

export async function product(o: Owner, over: Record<string, unknown> = {}) {
  const res = await o.c.post('/api/products', PRODUCT(over))
  if (res.status !== 201) throw new Error(`produto: ${res.status} ${res.text}`)
  return res.body.product as { id: string }
}

export const newUuid = () => randomUUID()

export const fieldPaths = (res: { body: Any }) =>
  (res.body?.error?.details?.fields ?? []).map((f: Any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))

/** Todas as vendas de uma consulta, página a página (limit padrão). */
export async function allSales(c: ApiClient, query = '') {
  const items: Any[] = []
  const pages: Any[] = []
  for (let page = 1; page < 50; page++) {
    const res = await c.get(`/api/sales?${query}${query ? '&' : ''}page=${page}`)
    if (res.status !== 200) throw new Error(`GET /api/sales?${query} → ${res.status} ${res.text}`)
    items.push(...res.body.items)
    pages.push(res.body.page)
    if (!res.body.page.has_more) break
  }
  return { items, pages, ids: items.map((s) => s.id as string) }
}
