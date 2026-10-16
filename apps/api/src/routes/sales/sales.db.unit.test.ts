import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SalesService } from '@crm/core'
import { companies, companyMembers, contacts, createDb, sales, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const published: { type: string; data: any }[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const CONN = '00000000-0000-4000-8000-0000000000c1'
const CONN2 = '00000000-0000-4000-8000-0000000000c2'

interface Session {
  cookie: string
  companyId: string
  userId: string
  headers: Record<string, string>
}

async function signUp(): Promise<Session> {
  const email = `v-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.34.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'V', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id, headers: {} }
}

const call = (s: Session, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...H, ...s.headers, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json
const paths = async (r: Response) => ((await json(r)).error.details.fields as Json[]).map((f) => f.path)

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    salesPublisher: { publish: async (_c, type, data) => void published.push({ type, data }) },
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('AC-T34-01 record idempotente', () => {
  it('mesmo (origem, external_id) duas vezes → 1 venda, status atualizado, 1 evento', async () => {
    const s = await signUp()
    const pub: { type: string }[] = []
    const svc = new SalesService({ db, publisher: { publish: async (_c, type) => void pub.push({ type }) } })
    const a = await svc.record({ companyId: s.companyId, source: 'webhook', externalId: 'pay-1', status: 'pending', amountCents: 9990, currency: 'brl' })
    const b = await svc.record({ companyId: s.companyId, source: 'webhook', externalId: 'pay-1', status: 'approved', amountCents: 9990, currency: 'BRL' })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.sale.id).toBe(a.sale.id)
    expect(b.sale.status).toBe('approved')
    expect(a.sale.currency).toBe('BRL')
    // outra origem com o mesmo external_id é outra venda
    const c = await svc.record({ companyId: s.companyId, source: 'flow', externalId: 'pay-1', amountCents: 100 })
    expect(c.created).toBe(true)
    expect(pub.filter((p) => p.type === 'sale.recorded')).toHaveLength(2)
    expect(await db.select().from(sales).where(eq(sales.companyId, s.companyId))).toHaveLength(2)
  })

  it('concorrente com o mesmo external_id cria uma só', async () => {
    const s = await signUp()
    const pub: unknown[] = []
    const svc = new SalesService({ db, publisher: { publish: async (...args) => void pub.push(args) } })
    const results = await Promise.all(Array.from({ length: 6 }, () => svc.record({ companyId: s.companyId, source: 'webhook', externalId: 'race', amountCents: 1 })))
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(pub).toHaveLength(1)
  })

  it('POST /api/sales (manual) emite sale.recorded; validação em centavos', async () => {
    const s = await signUp()
    published.length = 0
    const res = await call(s, 'POST', '/api/sales', { amount_cents: 15000, currency: 'BRL', customer_name: 'Ana' })
    expect(res.status).toBe(201)
    const { sale } = await json(res)
    expect(sale).toMatchObject({ source: 'manual', status: 'approved', amount_cents: 15000, customer_name: 'Ana' })
    expect(published).toEqual([{ type: 'sale.recorded', data: expect.objectContaining({ sale_id: sale.id }) }])
    const bad = await call(s, 'POST', '/api/sales', { amount_cents: -1, currency: 'XYZ' })
    expect(bad.status).toBe(422)
    expect(await paths(bad)).toEqual(expect.arrayContaining(['amount_cents', 'currency']))
  })
})

describe('AC-T34-02 produtos', () => {
  it('price_max < price_min ou fallback ≤ 0 → 422; CRUD', async () => {
    const s = await signUp()
    const base = { name: 'Curso', currency: 'BRL', price_min_cents: 1000, price_max_cents: 5000, price_fallback_cents: 2990 }
    const ok = await call(s, 'POST', '/api/products', base)
    expect(ok.status).toBe(201)
    const { product } = await json(ok)
    expect(product.public_id).toMatch(/^[0-9a-f-]{36}$/)
    const bad1 = await call(s, 'POST', '/api/products', { ...base, price_max_cents: 999 })
    expect(bad1.status).toBe(422)
    expect(await paths(bad1)).toContain('price_max_cents')
    for (const fb of [0, -10]) {
      const r = await call(s, 'POST', '/api/products', { ...base, price_fallback_cents: fb })
      expect(r.status).toBe(422)
      expect(await paths(r)).toContain('price_fallback_cents')
    }
    expect(await paths(await call(s, 'POST', '/api/products', { ...base, name: 'A' }))).toContain('name')
    const patch = await call(s, 'PATCH', `/api/products/${product.id}`, { price_min_cents: 6000 })
    expect(patch.status).toBe(422) // faixa final inválida
    expect((await json(await call(s, 'PATCH', `/api/products/${product.id}`, { name: 'Curso 2' }))).product.name).toBe('Curso 2')
    expect((await call(s, 'DELETE', `/api/products/${product.id}`)).status).toBe(204)
  })
})

describe('AC-T34-03 despesas e grupos', () => {
  it('percentual sem percent_base → 422; fixo ok', async () => {
    const s = await signUp()
    const bad = await call(s, 'POST', '/api/sales/expense-rules', { name: 'Gateway', kind: 'percent', percent: 4.99 })
    expect(bad.status).toBe(422)
    expect(await paths(bad)).toContain('percent_base')
    const ok = await json(await call(s, 'POST', '/api/sales/expense-rules', { name: 'Gateway', kind: 'percent', percent: 4.99, percent_base: 'revenue' }))
    expect(ok.expense_rule).toMatchObject({ kind: 'percent', percent: 4.99, percent_base: 'revenue', period: 'month' })
    const fixed = await json(await call(s, 'POST', '/api/sales/expense-rules', { name: 'Ferramentas', amount_cents: 19900, period: 'month', active_from: '2026-01-01' }))
    expect(fixed.expense_rule).toMatchObject({ kind: 'fixed', amount_cents: 19900, currency: 'BRL', percent_base: null })
    expect(await paths(await call(s, 'POST', '/api/sales/expense-rules', { name: 'X', amount_cents: 1, active_from: '2026-02-01', active_to: '2026-01-01' }))).toContain('active_to')
    expect((await json(await call(s, 'GET', '/api/sales/expense-rules'))).items).toHaveLength(2)
  })

  it('nome de grupo repetido (sem caixa, com espaços) → 409; conjunto repetido → 409', async () => {
    const s = await signUp()
    const a = await call(s, 'POST', '/api/sales/filter-groups', { name: 'Loja SP', connection_ids: [CONN] })
    expect(a.status).toBe(201)
    const dup = await call(s, 'POST', '/api/sales/filter-groups', { name: '  loja sp ', connection_ids: [CONN2] })
    expect(dup.status).toBe(409)
    expect((await json(dup)).error.code).toBe('CONFLICT')
    const same = await call(s, 'POST', '/api/sales/filter-groups', { name: 'Outro', connection_ids: [CONN] })
    expect(same.status).toBe(409)
    expect((await json(same)).error.details.reason).toBe('scope_taken')
    const b = await json(await call(s, 'POST', '/api/sales/filter-groups', { name: 'Loja RJ', connection_ids: [CONN2] }))
    expect((await call(s, 'PATCH', `/api/sales/filter-groups/${b.filter_group.id}`, { name: 'LOJA SP' })).status).toBe(409)
    expect((await call(s, 'PATCH', `/api/sales/filter-groups/${b.filter_group.id}`, { name: 'Loja Rio' })).status).toBe(200)
    expect((await json(await call(s, 'GET', '/api/sales/filter-groups'))).items.map((g: Json) => g.name)).toEqual(['Loja Rio', 'Loja SP'])
  })
})

describe('AC-T34-04 histórico', () => {
  it('período no fuso da empresa, conexão, produto, status e páginas de 20', async () => {
    const s = await signUp()
    await db.update(companies).set({ timeZone: 'America/Manaus' }).where(eq(companies.id, s.companyId)) // UTC−4
    const svc = new SalesService({ db })
    const { product } = await json(await call(s, 'POST', '/api/products', { name: 'Prod', price_min_cents: 1, price_max_cents: 10, price_fallback_cents: 5 }))
    // 2026-03-10 23:30 em Manaus = 2026-03-11 03:30Z: pertence ao dia 10 no fuso da empresa
    const late = await svc.record({ companyId: s.companyId, source: 'manual', amountCents: 1, soldAt: '2026-03-11T03:30:00Z', connectionId: CONN, productId: product.id })
    const next = await svc.record({ companyId: s.companyId, source: 'manual', amountCents: 2, soldAt: '2026-03-11T04:30:00Z', connectionId: CONN2, status: 'refunded' })
    const day10 = await json(await call(s, 'GET', '/api/sales?start_date=2026-03-10&end_date=2026-03-10'))
    expect(day10.items.map((i: Json) => i.id)).toEqual([late.sale.id])
    const day11 = await json(await call(s, 'GET', '/api/sales?start_date=2026-03-11&end_date=2026-03-11'))
    expect(day11.items.map((i: Json) => i.id)).toEqual([next.sale.id])
    expect((await json(await call(s, 'GET', `/api/sales?connection_ids=${CONN2}`))).items.map((i: Json) => i.id)).toEqual([next.sale.id])
    expect((await json(await call(s, 'GET', `/api/sales?product_ids=${product.id}`))).items[0]).toMatchObject({ id: late.sale.id, product_name: 'Prod' })
    expect((await json(await call(s, 'GET', '/api/sales?status=refunded,chargeback'))).items.map((i: Json) => i.id)).toEqual([next.sale.id])
    expect((await call(s, 'GET', '/api/sales?start_date=2026-03-10')).status).toBe(422)

    for (let i = 0; i < 23; i++) await svc.record({ companyId: s.companyId, source: 'manual', amountCents: i })
    const p1 = await json(await call(s, 'GET', '/api/sales'))
    expect(p1.items).toHaveLength(20)
    expect(p1.page).toMatchObject({ page: 1, limit: 20, total_count: 25, has_more: true })
    const p2 = await json(await call(s, 'GET', '/api/sales?page=2'))
    expect(p2.items).toHaveLength(5)
    expect(p2.page.has_more).toBe(false)
  })
})

describe('AC-T34-05 atribuição', () => {
  it('venda de contato com source_id herda; explícito vence', async () => {
    const s = await signUp()
    const [ct] = await db.insert(contacts).values({ companyId: s.companyId, name: 'Lead', sourceId: 'ad-123', ctwaClid: 'clid-9' }).returning({ id: contacts.id })
    const svc = new SalesService({ db })
    const inherited = await svc.record({ companyId: s.companyId, source: 'flow', amountCents: 100, contactId: ct!.id })
    expect(inherited.sale).toMatchObject({ source_id: 'ad-123', ctwa_clid: 'clid-9', contact_id: ct!.id })
    const explicit = await svc.record({ companyId: s.companyId, source: 'flow', amountCents: 100, contactId: ct!.id, sourceId: 'ad-999' })
    expect(explicit.sale).toMatchObject({ source_id: 'ad-999', ctwa_clid: 'clid-9' })
    const viaHttp = await json(await call(s, 'POST', '/api/sales', { amount_cents: 1, contact_id: ct!.id }))
    expect(viaHttp.sale.source_id).toBe('ad-123')
    const other = await signUp()
    expect(await paths(await call(other, 'POST', '/api/sales', { amount_cents: 1, contact_id: ct!.id }))).toContain('contact_id')
  })
})

describe('permissões', () => {
  it('member sem dashboard.sales → 403; com dashboard.sales lê mas não cria sem sales.edit', async () => {
    const owner = await signUp()
    const m = await signUp()
    await db.insert(companyMembers).values({ companyId: owner.companyId, userId: m.userId, role: 'member', permissionKeys: ['dashboard.sales'] })
    await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, m.userId))
    const member = { ...m, companyId: owner.companyId, headers: { 'x-company-id': owner.companyId } }
    expect((await call(member, 'GET', '/api/sales')).status).toBe(200)
    expect((await call(member, 'POST', '/api/sales', { amount_cents: 1 })).status).toBe(403)
    await db.update(companyMembers).set({ permissionKeys: ['chat.view'] }).where(eq(companyMembers.userId, m.userId))
    expect((await call(member, 'GET', '/api/sales')).status).toBe(403)
  })
})
