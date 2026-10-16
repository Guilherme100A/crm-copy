// Dashboard de vendas (T55) com Postgres real: fixture de vendas no fuso America/Sao_Paulo (UTC−3), gasto fake e regras.
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chats, companies, connections, contacts, createDb, expenseRules, messages, products, sales, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { dashboardBootstrap } from '../bootstrap/index'
import { SalesDashboardService, type AdSpendProvider, type DashboardCache } from './service'

let temp: TempDatabase
let db: Database
const rnd = () => randomBytes(4).toString('hex')
let co: string
let connA: string
let connB: string
let p1: string
const spendCalls: { startDate: string; endDate: string; connectionIds: string[] }[] = []
const adSpend: AdSpendProvider = {
  getSpend: async (q) => {
    spendCalls.push(q)
    return 20_000
  },
}
const store = new Map<string, string>()
const cache: DashboardCache = { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) }
let clock = Date.parse('2026-07-02T12:00:00Z')
const svc = (extra: Partial<ConstructorParameters<typeof SalesDashboardService>[0]> = {}) =>
  new SalesDashboardService({ db, adSpend, cache, now: () => new Date((clock += 1000)), ...extra })
const at = (local: string) => new Date(`${local}-03:00`)

async function inbound(contactId: string, connectionId: string, when: string, direction: 'inbound' | 'outbound' = 'inbound') {
  const [existing] = await db.select({ id: chats.id }).from(chats).where(sqlChat(contactId, connectionId))
  const chatId = existing?.id ?? (await db.insert(chats).values({ companyId: co, connectionId, contactId }).returning({ id: chats.id }))[0]!.id
  await db.insert(messages).values({ companyId: co, chatId, direction, senderType: direction === 'inbound' ? 'contact' : 'user', type: 'text', status: 'received', sentAt: at(when) })
}
const sqlChat = (contactId: string, connectionId: string) => and(eq(chats.companyId, co), eq(chats.contactId, contactId), eq(chats.connectionId, connectionId))

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  co = (await db.insert(companies).values({ name: 'C', slug: `c-${rnd()}`, timeZone: 'America/Sao_Paulo' }).returning({ id: companies.id }))[0]!.id
  const conn = async (name: string, phone: string) =>
    (await db.insert(connections).values({ companyId: co, sessionId: `s-${rnd()}`, name, phoneNumber: phone }).returning({ id: connections.id }))[0]!.id
  connA = await conn('Loja A', '5511900000001')
  connB = await conn('Loja B', '5511900000002')
  p1 = (await db.insert(products).values({ companyId: co, name: 'Curso', priceMinCents: 1, priceMaxCents: 100_000, priceFallbackCents: 100 }).returning({ id: products.id }))[0]!.id
  const contact = async (state: string | null) => (await db.insert(contacts).values({ companyId: co, name: 'L', state }).returning({ id: contacts.id }))[0]!.id
  const sp = await contact('SP')
  const none = await contact(null)
  const rj = await contact('RJ')
  const old = await contact('MG')
  const out = await contact('BA')
  const sale = (amount: number, local: string, o: Partial<typeof sales.$inferInsert> = {}) => ({ companyId: co, amountCents: amount, soldAt: at(local), ...o })
  await db.insert(sales).values([
    sale(10_000, '2026-06-01T12:00:00', { connectionId: connA, productId: p1, contactId: sp }),
    sale(20_000, '2026-06-01T23:30:00', { connectionId: connA, contactId: none }),
    sale(30_000, '2026-06-15T09:00:00', { connectionId: connB, productId: p1, contactId: rj }),
    sale(40_000, '2026-06-20T10:00:00', { connectionId: connB, status: 'pending' }),
    sale(50_000, '2026-07-01T00:30:00', { connectionId: connA }),
    sale(5_000, '2026-05-31T23:59:00', { connectionId: connA }),
    sale(1_000, '2026-06-10T10:00:00', { connectionId: connB, currency: 'USD', contactId: rj }),
  ])
  // Leads novos em junho: sp (06-02) e none (06-30 23h local). old começou em maio; out só recebeu mensagem.
  await inbound(sp, connA, '2026-06-02T10:00:00')
  await inbound(none, connB, '2026-06-30T23:00:00')
  await inbound(old, connA, '2026-05-20T10:00:00')
  await inbound(old, connA, '2026-06-10T10:00:00')
  await inbound(out, connA, '2026-06-05T10:00:00', 'outbound')
  await db.insert(expenseRules).values([
    { companyId: co, name: 'Aluguel', kind: 'fixed', amountCents: 30_000, period: 'month' },
    { companyId: co, name: 'Gateway', kind: 'percent', percent: '10.00', percentBase: 'revenue', period: 'month' },
  ])
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

describe('AC-T55-01 / AC-T55-06 mês de junho', () => {
  it('KPIs, despesas, séries e quebras no fuso da empresa', async () => {
    const r = await svc().get(co, { start_date: '2026-06-01', end_date: '2026-06-30' }, { includeSales: true, forceRefresh: true })
    expect(r.range).toEqual({ start_date: '2026-06-01', end_date: '2026-06-30', time_zone: 'America/Sao_Paulo', granularity: 'day' })
    expect(r.previous_range).toEqual({ start_date: '2026-05-02', end_date: '2026-05-31' })
    const s = r.sales!
    // 10 000 + 20 000 + 30 000 + 1 000 (USD) = 61 000; 4 vendas; leads 2; gasto 20 000
    // despesas: 30 000 (fixa mensal, 30/30) + 6 100 (10% de 61 000) = 36 100
    expect(s.kpis).toEqual({
      new_leads: 2,
      sales_count: 4,
      revenue_cents: 61_000,
      avg_ticket_cents: 15_250,
      conversion_rate: 2,
      spend_cents: 20_000,
      roas: 3.05,
      profit_pre_fees_cents: 41_000,
      expenses_cents: 36_100,
      profit_cents: 4_900,
    })
    expect(s.revenue_by_currency).toEqual({ BRL: 60_000, USD: 1_000 })
    expect(s.expenses_breakdown.map((e) => [e.name, e.value_cents]).sort()).toEqual([
      ['Aluguel', 30_000],
      ['Gateway', 6_100],
    ])
    expect(s.sales_over_time).toHaveLength(30)
    expect(s.sales_over_time[0]).toEqual({ bucket_start: '2026-06-01', revenue_cents: 30_000, sales_count: 2 })
    expect(s.sales_over_time.find((b) => b.bucket_start === '2026-06-15')).toMatchObject({ revenue_cents: 30_000, sales_count: 1 })
    expect(s.sales_by_hour).toHaveLength(24)
    expect(s.sales_by_hour.filter((h) => h.sales_count).map((h) => [h.hour, h.revenue_cents])).toEqual([
      [9, 30_000],
      [10, 1_000],
      [12, 10_000],
      [23, 20_000],
    ])
    expect(s.sales_by_connection).toEqual([
      { connection_id: connB, connection_name: 'Loja B', connection_number: '5511900000002', sales_count: 2, revenue_cents: 31_000 },
      { connection_id: connA, connection_name: 'Loja A', connection_number: '5511900000001', sales_count: 2, revenue_cents: 30_000 },
    ])
    expect(s.sales_by_state).toEqual([
      { state: 'RJ', sales_count: 2, revenue_cents: 31_000 },
      { state: 'Desconhecido', sales_count: 1, revenue_cents: 20_000 },
      { state: 'SP', sales_count: 1, revenue_cents: 10_000 },
    ])
    expect(s.sales_by_product).toEqual([
      { product_id: p1, product_name: 'Curso', sales_count: 2, revenue_cents: 40_000 },
      { product_id: null, product_name: 'Sem produto', sales_count: 2, revenue_cents: 21_000 },
    ])
    // anterior: 1 venda de 5 000 em 31/05; old foi lead novo em 20/05
    expect(s.previous).toMatchObject({ sales_count: 1, revenue_cents: 5_000, new_leads: 1 })
    expect(s.trends.revenue_cents).toEqual({ direction: 'up', delta_pct: 1120 })
    expect(spendCalls.slice(-2).map((c) => c.startDate).sort()).toEqual(['2026-05-02', '2026-06-01'])
  })

  it('um dia → granularidade hora (24 buckets locais); filtros por conexão e produto', async () => {
    const day = await svc().get(co, { start_date: '2026-06-01', end_date: '2026-06-01' }, { includeSales: true, forceRefresh: true })
    expect(day.range.granularity).toBe('hour')
    expect(day.sales!.sales_over_time).toHaveLength(24)
    expect(day.sales!.sales_over_time.filter((b) => b.sales_count).map((b) => b.bucket_start)).toEqual(['2026-06-01T12:00', '2026-06-01T23:00'])
    const filtered = await svc().get(co, { start_date: '2026-06-01', end_date: '2026-06-30', connection_ids: [connB], product_ids: [p1] }, { includeSales: true, forceRefresh: true })
    expect(filtered.sales!.kpis).toMatchObject({ sales_count: 1, revenue_cents: 30_000, new_leads: 1 })
  })

  it('ROAS nulo com gasto 0 (provedor padrão)', async () => {
    const r = await svc({ adSpend: undefined }).get(co, { start_date: '2026-06-01', end_date: '2026-06-30' }, { includeSales: true, forceRefresh: true })
    expect(r.sales!.kpis).toMatchObject({ spend_cents: 0, roas: null, profit_pre_fees_cents: 61_000 })
  })
})

describe('AC-T55-03 / AC-T55-04 cache e permissão', () => {
  it('segunda chamada idêntica vem do cache; force_refresh recalcula; filtros diferentes não colidem', async () => {
    store.clear()
    const s = svc()
    const q = { start_date: '2026-06-01', end_date: '2026-06-30' }
    const a = await s.get(co, q, { includeSales: true })
    const b = await s.get(co, q, { includeSales: true })
    expect([a.cached, b.cached]).toEqual([false, true])
    expect(b.computed_at).toBe(a.computed_at)
    expect(b.sales).toEqual(a.sales)
    const c = await s.get(co, q, { includeSales: true, forceRefresh: true })
    expect(c.cached).toBe(false)
    expect(c.computed_at).not.toBe(a.computed_at)
    expect((await s.get(co, { ...q, connection_ids: [connA] }, { includeSales: true })).cached).toBe(false)
  })

  it('sem dashboard.sales não há bloco de vendas; bootstrap sem lifetime_revenue', async () => {
    const r = await svc().get(co, { start_date: '2026-06-01', end_date: '2026-06-30' }, { includeSales: false })
    expect(r.sales).toBeUndefined()
    const boot = await dashboardBootstrap(db, co, { includeSales: false })
    expect(boot.lifetime_revenue).toBeUndefined()
    expect(boot.leads_count).toBe(5)
    const full = await dashboardBootstrap(db, co, { includeSales: true })
    // BRL aprovadas de sempre: 10 000 + 20 000 + 30 000 + 50 000 + 5 000
    expect(full.lifetime_revenue).toMatchObject({ revenue_cents: 115_000, revenue_by_currency: { BRL: 115_000, USD: 1_000 }, milestone: { level: 0 } })
    expect(full.products).toEqual([{ id: p1, name: 'Curso', currency: 'BRL' }])
    expect(full.connections.map((c) => c.name)).toEqual(['Loja A', 'Loja B'])
  })

  it('validação de datas e ids', async () => {
    for (const f of [{ start_date: '2026-06-31' }, { start_date: '2026-06-10', end_date: '2026-06-01' }, { start_date: '2025-01-01', end_date: '2026-06-01' }, { connection_ids: ['x'] }])
      await expect(svc().get(co, f, { includeSales: true })).rejects.toThrow('Filtros inválidos')
  })
})
