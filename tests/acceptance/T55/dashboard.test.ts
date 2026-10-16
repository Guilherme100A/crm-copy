// AC-T55-01..06: dashboard de vendas (KPIs, séries, quebras, período anterior, cache, permissão, marcos e lucro).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMessage,
  addSale,
  dashboard,
  dashPath,
  days,
  newConnection,
  newContact,
  newMember,
  newOwner,
  newProduct,
  setTimeZone,
  startEnv,
  type Env,
  type User,
} from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

/**
 * Fixture de junho/2026 no fuso America/Sao_Paulo (UTC−3, sem horário de verão).
 * Vendas aprovadas em [01/06, 30/06]: S1 100,00 (01/06 09:30, C1, P1, SP) · S2 250,00 (01/06 09:45, C1, P2, RJ) ·
 * S3 50,00 (15/06 23:30 local = 16/06 UTC, C2, P1, UF nula) · S4 70,00 (30/06 00:15, C2, sem produto, sem contato) ·
 * S5 30,00 (30/06 23:59 local = 01/07 UTC, C1, P1, UF vazia). Total 500,00 em 5 vendas.
 * Fora: S6 20,00 (01/07 00:05 local) · S7 40,00 (31/05 23:50 local = 01/06 UTC; cai no período anterior) ·
 * S8 reembolsada e S9 pendente em junho.
 * Leads novos (1ª mensagem inbound) em junho: K1 (C1), K3 (C2), K5 (C1, 30/06 23:00 local), K7..K11 (C2) = 8.
 * K2: 1ª inbound em 20/05 (lead novo do período anterior) e outra em 05/06. K4: só outbound. K6: 01/07 00:30 local.
 */
interface June {
  owner: User
  c1: string
  c2: string
  p1: string
  p2: string
}

async function seedJune(): Promise<June> {
  const owner = await newOwner(env)
  const co = owner.companyId
  await setTimeZone(env, co, 'America/Sao_Paulo')
  const c1 = await newConnection(env, co, 'Loja A', '5511900000001')
  const c2 = await newConnection(env, co, 'Loja B', '5511900000002')
  const p1 = await newProduct(env, co, 'Curso')
  const p2 = await newProduct(env, co, 'Mentoria')
  const k1 = await newContact(env, co, 'SP')
  const k2 = await newContact(env, co, 'RJ')
  const k3 = await newContact(env, co, null)
  const k4 = await newContact(env, co, '')
  const k5 = await newContact(env, co, 'MG')
  const k6 = await newContact(env, co, 'BA')

  await addSale(env, co, { amount: 10_000, at: '2026-06-01T09:30:00-03:00', connectionId: c1, productId: p1, contactId: k1 })
  await addSale(env, co, { amount: 25_000, at: '2026-06-01T09:45:00-03:00', connectionId: c1, productId: p2, contactId: k2 })
  await addSale(env, co, { amount: 5_000, at: '2026-06-15T23:30:00-03:00', connectionId: c2, productId: p1, contactId: k3 })
  await addSale(env, co, { amount: 7_000, at: '2026-06-30T00:15:00-03:00', connectionId: c2, productId: null, contactId: null })
  await addSale(env, co, { amount: 3_000, at: '2026-06-30T23:59:00-03:00', connectionId: c1, productId: p1, contactId: k4 })
  await addSale(env, co, { amount: 2_000, at: '2026-07-01T00:05:00-03:00', connectionId: c1, productId: p1, contactId: k1 })
  await addSale(env, co, { amount: 4_000, at: '2026-05-31T23:50:00-03:00', connectionId: c1, productId: p1, contactId: k2 })
  await addSale(env, co, { amount: 1_000, at: '2026-06-10T12:00:00-03:00', status: 'refunded', connectionId: c1, productId: p1, contactId: k1 })
  await addSale(env, co, { amount: 1_500, at: '2026-06-11T12:00:00-03:00', status: 'pending', connectionId: c1, productId: p1, contactId: k1 })

  await addMessage(env, co, c1, k1, '2026-06-01T08:00:00-03:00')
  await addMessage(env, co, c1, k1, '2026-06-02T08:00:00-03:00')
  await addMessage(env, co, c1, k2, '2026-05-20T10:00:00-03:00')
  await addMessage(env, co, c1, k2, '2026-06-05T10:00:00-03:00')
  await addMessage(env, co, c2, k3, '2026-06-15T10:00:00-03:00')
  await addMessage(env, co, c1, k4, '2026-06-20T10:00:00-03:00', 'outbound')
  await addMessage(env, co, c1, k5, '2026-06-30T23:00:00-03:00')
  await addMessage(env, co, c2, k6, '2026-07-01T00:30:00-03:00')
  for (let i = 0; i < 5; i++) await addMessage(env, co, c2, await newContact(env, co, 'PR'), `2026-06-1${i}T12:00:00-03:00`)

  // ruído de outra empresa no mesmo período
  const other = await newOwner(env)
  await addSale(env, other.companyId, { amount: 999_999, at: '2026-06-10T12:00:00-03:00' })
  return { owner, c1, c2, p1, p2 }
}

const pick = (arr: Any[], key: string, value: unknown) => arr.find((x) => x[key] === value)

describe('AC-T55-01 KPIs, séries e quebras no fuso da empresa', () => {
  let f: June
  let d: Any
  beforeAll(async () => {
    f = await seedJune()
    d = await dashboard(f.owner, { start: '2026-06-01', end: '2026-06-30' })
  })

  it('AC-T55-01 KPIs de junho (só approved, intervalo local inclusivo, sem outra empresa)', () => {
    expect(d.range).toMatchObject({ start_date: '2026-06-01', end_date: '2026-06-30', time_zone: 'America/Sao_Paulo', granularity: 'day' })
    expect(d.sales.kpis).toMatchObject({ sales_count: 5, revenue_cents: 50_000, avg_ticket_cents: 10_000, new_leads: 8 })
    expect(d.sales.kpis.conversion_rate).toBeCloseTo(5 / 8, 6)
    expect(d.sales.revenue_by_currency).toEqual({ BRL: 50_000 })
  })

  it('AC-T55-01 série diária: um bucket por dia (inclusive vazios), soma = faturamento', () => {
    const s = d.sales.sales_over_time
    expect(s.map((p: Any) => p.bucket_start)).toEqual(days('2026-06-01', '2026-06-30'))
    expect(pick(s, 'bucket_start', '2026-06-01')).toMatchObject({ revenue_cents: 35_000, sales_count: 2 })
    expect(pick(s, 'bucket_start', '2026-06-15')).toMatchObject({ revenue_cents: 5_000, sales_count: 1 })
    expect(pick(s, 'bucket_start', '2026-06-16')).toMatchObject({ revenue_cents: 0, sales_count: 0 })
    expect(pick(s, 'bucket_start', '2026-06-30')).toMatchObject({ revenue_cents: 10_000, sales_count: 2 })
    expect(s.reduce((a: number, p: Any) => a + p.revenue_cents, 0)).toBe(50_000)
  })

  it('AC-T55-01 por hora do dia (24 itens, hora local)', () => {
    const h = d.sales.sales_by_hour
    expect(h.map((x: Any) => x.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i))
    expect(pick(h, 'hour', 9)).toMatchObject({ sales_count: 2, revenue_cents: 35_000 })
    expect(pick(h, 'hour', 23)).toMatchObject({ sales_count: 2, revenue_cents: 8_000 })
    expect(pick(h, 'hour', 0)).toMatchObject({ sales_count: 1, revenue_cents: 7_000 })
    expect(h.reduce((a: number, x: Any) => a + x.sales_count, 0)).toBe(5)
  })

  it('AC-T55-01 por conexão (ordem por faturamento), por UF (Desconhecido) e por produto (Sem produto)', () => {
    const byConn = d.sales.sales_by_connection
    expect(byConn.map((x: Any) => x.connection_id)).toEqual([f.c1, f.c2])
    expect(byConn[0]).toMatchObject({ connection_name: 'Loja A', sales_count: 3, revenue_cents: 38_000 })
    expect(byConn[1]).toMatchObject({ connection_name: 'Loja B', sales_count: 2, revenue_cents: 12_000 })

    const byState = d.sales.sales_by_state
    expect(pick(byState, 'state', 'SP')).toMatchObject({ sales_count: 1, revenue_cents: 10_000 })
    expect(pick(byState, 'state', 'RJ')).toMatchObject({ sales_count: 1, revenue_cents: 25_000 })
    expect(pick(byState, 'state', 'Desconhecido')).toMatchObject({ sales_count: 3, revenue_cents: 15_000 })
    expect(byState).toHaveLength(3)

    const byProd = d.sales.sales_by_product
    expect(pick(byProd, 'product_id', f.p1)).toMatchObject({ product_name: 'Curso', sales_count: 3, revenue_cents: 18_000 })
    expect(pick(byProd, 'product_id', f.p2)).toMatchObject({ product_name: 'Mentoria', sales_count: 1, revenue_cents: 25_000 })
    expect(pick(byProd, 'product_id', null)).toMatchObject({ product_name: 'Sem produto', sales_count: 1, revenue_cents: 7_000 })
    expect(byProd).toHaveLength(3)
  })

  it('AC-T55-01 um dia → granularidade hora com 24 buckets locais (bordas 00:15 e 23:59)', async () => {
    const one = await dashboard(f.owner, { start: '2026-06-30', end: '2026-06-30' })
    expect(one.range.granularity).toBe('hour')
    const s = one.sales.sales_over_time
    expect(s.map((p: Any) => p.bucket_start)).toEqual(Array.from({ length: 24 }, (_, i) => `2026-06-30T${String(i).padStart(2, '0')}:00`))
    expect(pick(s, 'bucket_start', '2026-06-30T00:00')).toMatchObject({ revenue_cents: 7_000, sales_count: 1 })
    expect(pick(s, 'bucket_start', '2026-06-30T23:00')).toMatchObject({ revenue_cents: 3_000, sales_count: 1 })
    expect(one.sales.kpis).toMatchObject({ sales_count: 2, revenue_cents: 10_000, new_leads: 1 })
    // dois dias já são granularidade dia
    expect((await dashboard(f.owner, { start: '2026-06-29', end: '2026-06-30' })).range.granularity).toBe('day')
  })

  it('AC-T55-01 filtros por conexão e por produto (leads só por conexão)', async () => {
    const byC1 = await dashboard(f.owner, { start: '2026-06-01', end: '2026-06-30', connectionIds: [f.c1] })
    expect(byC1.sales.kpis).toMatchObject({ sales_count: 3, revenue_cents: 38_000, new_leads: 2 })
    expect(byC1.sales.sales_by_connection.map((x: Any) => x.connection_id)).toEqual([f.c1])

    const byP1 = await dashboard(f.owner, { start: '2026-06-01', end: '2026-06-30', productIds: [f.p1] })
    expect(byP1.sales.kpis).toMatchObject({ sales_count: 3, revenue_cents: 18_000, new_leads: 8 })

    const both = await dashboard(f.owner, { start: '2026-06-01', end: '2026-06-30', connectionIds: [f.c1, f.c2], productIds: [f.p2] })
    expect(both.sales.kpis).toMatchObject({ sales_count: 1, revenue_cents: 25_000 })

    const single = await f.owner.c.get(`/api/dashboard?start_date=2026-06-01&end_date=2026-06-30&connection_id=${f.c2}`)
    expect(single.status, single.text).toBe(200)
    expect(single.body.sales.kpis).toMatchObject({ sales_count: 2, revenue_cents: 12_000 })
  })

  it('AC-T55-01 usa o fuso configurado da empresa (Asia/Tokyo desloca dia e hora)', async () => {
    const o = await newOwner(env)
    await setTimeZone(env, o.companyId, 'Asia/Tokyo')
    await addSale(env, o.companyId, { amount: 1_000, at: '2026-06-01T12:30:00Z' }) // 21:30 em Tóquio, 01/06
    await addSale(env, o.companyId, { amount: 2_000, at: '2026-06-01T16:00:00Z' }) // 01:00 em Tóquio, 02/06
    const d1 = await dashboard(o, { start: '2026-06-01', end: '2026-06-01' })
    expect(d1.range.time_zone).toBe('Asia/Tokyo')
    expect(d1.sales.kpis).toMatchObject({ sales_count: 1, revenue_cents: 1_000 })
    expect(pick(d1.sales.sales_by_hour, 'hour', 21)).toMatchObject({ sales_count: 1 })
    expect(pick(d1.sales.sales_over_time, 'bucket_start', '2026-06-01T21:00')).toMatchObject({ revenue_cents: 1_000 })
    const d2 = await dashboard(o, { start: '2026-06-02', end: '2026-06-02' })
    expect(d2.sales.kpis).toMatchObject({ sales_count: 1, revenue_cents: 2_000 })
    expect(pick(d2.sales.sales_by_hour, 'hour', 1)).toMatchObject({ sales_count: 1 })
  })

  it('AC-T55-01 datas inválidas → 422', async () => {
    const r = await f.owner.c.get('/api/dashboard?start_date=2026-06-30&end_date=2026-06-01')
    expect(r.status, r.text).toBe(422)
    expect(r.body?.error?.code).toBe('VALIDATION_ERROR')
  })
})

describe('AC-T55-02 período anterior e tendência', () => {
  it('AC-T55-02 período anterior = mesma duração terminando no dia anterior ao início', async () => {
    const f = await seedJune()
    const d = await dashboard(f.owner, { start: '2026-06-01', end: '2026-06-30' })
    expect(d.previous_range).toEqual({ start_date: '2026-05-02', end_date: '2026-05-31' })
    expect(d.sales.previous).toMatchObject({ sales_count: 1, revenue_cents: 4_000, new_leads: 1 })
    // previous bate com a consulta direta do período anterior
    const prev = await dashboard(f.owner, { start: '2026-05-02', end: '2026-05-31' })
    expect(d.sales.previous).toMatchObject({ sales_count: prev.sales.kpis.sales_count, revenue_cents: prev.sales.kpis.revenue_cents, new_leads: prev.sales.kpis.new_leads })
    expect(d.sales.trends.revenue_cents.direction).toBe('up')
    expect(d.sales.trends.revenue_cents.delta_pct).toBeCloseTo(1150, 4)
    expect(d.sales.trends.sales_count).toMatchObject({ direction: 'up' })
    expect(d.sales.trends.sales_count.delta_pct).toBeCloseTo(400, 4)

    expect((await dashboard(f.owner, { start: '2026-03-01', end: '2026-03-10' })).previous_range).toEqual({ start_date: '2026-02-19', end_date: '2026-02-28' })
    expect((await dashboard(f.owner, { start: '2026-06-15', end: '2026-06-15' })).previous_range).toEqual({ start_date: '2026-06-14', end_date: '2026-06-14' })
    expect((await dashboard(f.owner, { start: '2026-01-01', end: '2026-01-07' })).previous_range).toEqual({ start_date: '2025-12-25', end_date: '2025-12-31' })
  })

  it('AC-T55-02 tendência neutra quando o anterior é 0', async () => {
    const f = await seedJune()
    const d = await dashboard(f.owner, { start: '2026-06-15', end: '2026-06-15' }) // S3; 14/06 vazio
    expect(d.sales.kpis.revenue_cents).toBe(5_000)
    expect(d.sales.previous).toMatchObject({ revenue_cents: 0, sales_count: 0 })
    expect(d.sales.trends.revenue_cents).toEqual({ direction: 'neutral', delta_pct: null })
    expect(d.sales.trends.sales_count).toEqual({ direction: 'neutral', delta_pct: null })
  })

  it('AC-T55-02 tendência neutra com |Δ| < 0,05% e up/down acima disso', async () => {
    const o = await newOwner(env)
    await setTimeZone(env, o.companyId, 'America/Sao_Paulo')
    const day = async (date: string, cents: number) => addSale(env, o.companyId, { amount: cents, at: `${date}T12:00:00-03:00` })
    await day('2026-04-01', 1_000_000)
    await day('2026-04-02', 1_000_400) // +0,04%
    await day('2026-04-03', 1_000_000) // −0,04%
    await day('2026-04-04', 1_000_700) // +0,07%
    await day('2026-04-05', 990_000) // −1,07%
    const t = async (date: string) => (await dashboard(o, { start: date, end: date })).sales.trends.revenue_cents
    expect((await t('2026-04-02')).direction).toBe('neutral')
    expect((await t('2026-04-03')).direction).toBe('neutral')
    const up = await t('2026-04-04')
    expect(up.direction).toBe('up')
    expect(up.delta_pct).toBeCloseTo(0.07, 3)
    const down = await t('2026-04-05')
    expect(down.direction).toBe('down')
    expect(down.delta_pct).toBeLessThan(0)
    // sales_count igual (1 vs 1) → neutro
    expect((await dashboard(o, { start: '2026-04-04', end: '2026-04-04' })).sales.trends.sales_count.direction).toBe('neutral')
  })
})

describe('AC-T55-03 cache', () => {
  it('AC-T55-03 segunda chamada idêntica vem do cache; force_refresh=1 recalcula', async () => {
    const f = await seedJune()
    const q = { start: '2026-06-01', end: '2026-06-30' }
    const first = await dashboard(f.owner, q)
    expect(first.cached).toBe(false)
    expect(typeof first.computed_at).toBe('string')

    // dado novo depois da 1ª chamada: o cache ainda mostra o valor antigo
    await addSale(env, f.owner.companyId, { amount: 50_000, at: '2026-06-20T12:00:00-03:00', connectionId: f.c1, productId: f.p1 })
    const second = await dashboard(f.owner, q)
    expect(second.cached).toBe(true)
    expect(second.computed_at).toBe(first.computed_at)
    expect(second.sales.kpis.revenue_cents).toBe(50_000)

    const forced = await dashboard(f.owner, { ...q, force: true })
    expect(forced.cached).toBe(false)
    expect(forced.computed_at).not.toBe(first.computed_at)
    expect(forced.sales.kpis.revenue_cents).toBe(100_000)

    // depois do recálculo, a chamada normal serve o valor novo do cache
    const after = await dashboard(f.owner, q)
    expect(after.cached).toBe(true)
    expect(after.sales.kpis.revenue_cents).toBe(100_000)
  })

  it('AC-T55-03 a chave do cache inclui período, filtros e empresa', async () => {
    const f = await seedJune()
    const base = { start: '2026-06-01', end: '2026-06-30' }
    expect((await dashboard(f.owner, base)).cached).toBe(false)
    expect((await dashboard(f.owner, base)).cached).toBe(true)
    const other = await dashboard(f.owner, { ...base, connectionIds: [f.c2] })
    expect(other.cached).toBe(false)
    expect(other.sales.kpis.revenue_cents).toBe(12_000)
    expect((await dashboard(f.owner, { ...base, productIds: [f.p2] })).cached).toBe(false)
    expect((await dashboard(f.owner, { start: '2026-06-01', end: '2026-06-29' })).cached).toBe(false)

    const stranger = await newOwner(env)
    const s = await dashboard(stranger, base)
    expect(s.cached).toBe(false)
    expect(s.sales.kpis.revenue_cents).toBe(0)
  })
})

describe('AC-T55-04 permissão dashboard.sales', () => {
  it('AC-T55-04 sem dashboard.sales: dashboard sem bloco sales e bootstrap sem lifetime_revenue', async () => {
    const f = await seedJune()
    const support = await newMember(env, f.owner.companyId, ['dashboard.support'])
    const d = await support.c.get(dashPath({ start: '2026-06-01', end: '2026-06-30' }))
    expect(d.status, d.text).toBe(200)
    expect(d.body).not.toHaveProperty('sales')
    expect(d.text).not.toContain('revenue_cents')
    expect(d.text).not.toContain('lifetime_revenue')

    const b = await support.c.get('/api/dashboard/bootstrap')
    expect(b.status, b.text).toBe(200)
    expect(b.body).not.toHaveProperty('lifetime_revenue')
    expect(b.text).not.toContain('revenue_cents')
    expect(b.body.leads_count).toBeGreaterThan(0)
  })

  it('AC-T55-04 com dashboard.sales (member ou owner) o bloco sales e lifetime_revenue aparecem', async () => {
    const f = await seedJune()
    const seller = await newMember(env, f.owner.companyId, ['dashboard.sales'])
    for (const u of [seller, f.owner]) {
      const d = await dashboard(u, { start: '2026-06-01', end: '2026-06-30' })
      expect(d.sales.kpis.revenue_cents).toBe(50_000)
      const b = await u.c.get('/api/dashboard/bootstrap')
      expect(b.status, b.text).toBe(200)
      // todas as approved de sempre: junho 500,00 + S6 20,00 + S7 40,00
      expect(b.body.lifetime_revenue).toMatchObject({ revenue_cents: 56_000, display_currency: 'BRL' })
    }
  })

  it('AC-T55-04 sem nenhuma permissão de dashboard → 403', async () => {
    const f = await seedJune()
    const nobody = await newMember(env, f.owner.companyId, [])
    const r = await nobody.c.get(dashPath({ start: '2026-06-01', end: '2026-06-30' }))
    expect(r.status, r.text).toBe(403)
    expect((await nobody.c.get('/api/dashboard/bootstrap')).status).toBe(403)
  })

  it('AC-T55-04 bootstrap traz produtos, conexões, grupos de filtro, avisos e leads_count da empresa', async () => {
    const f = await seedJune()
    const b = await f.owner.c.get('/api/dashboard/bootstrap')
    expect(b.status, b.text).toBe(200)
    expect(b.body.products.map((p: Any) => p.name).sort()).toEqual(['Curso', 'Mentoria'])
    expect(b.body.connections.map((c: Any) => c.id).sort()).toEqual([f.c1, f.c2].sort())
    expect(Array.isArray(b.body.filter_groups)).toBe(true)
    expect(Array.isArray(b.body.announcements)).toBe(true)
    expect(Array.isArray(b.body.banners)).toBe(true)
    const [n] = await env.q(`SELECT count(*)::int AS n FROM crm.contacts WHERE company_id = $1`, [f.owner.companyId])
    expect(b.body.leads_count).toBe(Number(n.n))
  })
})

const REFERENCE_NAMES = ['Instinto em Ação', 'Novo Predador', 'Ritmo de Caça', 'Força Instintiva', 'Topo da Cadeia', 'Lenda Viva']
const OWN_NAMES = ['Primeira Marca', 'Tração', 'Escala', 'Expansão', 'Clube do Milhão', 'Referência no Mercado']
const MINS = [5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000, 200_000_000]

function assertNoReference(text: string) {
  for (const n of REFERENCE_NAMES) expect(text.toLowerCase()).not.toContain(n.toLowerCase())
  expect(text).not.toMatch(/predador|predator|depredador/i)
}

describe('AC-T55-05 computeMilestone', () => {
  it('AC-T55-05 < 50 mil → sem selo, progresso relativo a 0', () => {
    const { computeMilestone } = env.core
    const zero = computeMilestone(0)
    expect(zero).toMatchObject({ level: 0, current: null, max_reached: false, progress_pct: 0, remaining_cents: 5_000_000 })
    expect(zero.next).toMatchObject({ level: 1, name: 'Primeira Marca', min_cents: 5_000_000 })
    const half = computeMilestone(2_500_000)
    expect(half).toMatchObject({ level: 0, current: null, remaining_cents: 2_500_000 })
    expect(half.progress_pct).toBeCloseTo(50, 6)
    expect(computeMilestone(4_999_999).level).toBe(0)
  })

  it('AC-T55-05 75 mil → "Primeira Marca" com 50% até "Tração"; limiares exatos', () => {
    const { computeMilestone } = env.core
    const m = computeMilestone(7_500_000)
    expect(m).toMatchObject({ level: 1, max_reached: false, remaining_cents: 2_500_000 })
    expect(m.current).toMatchObject({ level: 1, name: 'Primeira Marca', min_cents: 5_000_000 })
    expect(m.next).toMatchObject({ level: 2, name: 'Tração', min_cents: 10_000_000 })
    expect(m.progress_pct).toBeCloseTo(50, 6)
    MINS.forEach((min, i) => {
      const at = computeMilestone(min)
      expect(at.level).toBe(i + 1)
      expect(at.current.name).toBe(OWN_NAMES[i])
      if (i > 0) expect(computeMilestone(min - 1).level).toBe(i)
    })
  })

  it('AC-T55-05 ≥ 2 milhões → "Referência no Mercado" e nível máximo', () => {
    const { computeMilestone } = env.core
    for (const v of [200_000_000, 999_999_999]) {
      const m = computeMilestone(v)
      expect(m).toMatchObject({ level: 6, next: null, max_reached: true, progress_pct: 100 })
      expect(m.current).toMatchObject({ level: 6, name: 'Referência no Mercado', min_cents: 200_000_000 })
    }
  })

  it('AC-T55-05 MILESTONES com nomes e descrições próprios nas três línguas; nada do produto de referência', () => {
    const { computeMilestone, MILESTONES } = env.core
    const list = Array.isArray(MILESTONES) ? MILESTONES : Object.values(MILESTONES)
    expect(JSON.stringify(list)).toBeTruthy()
    assertNoReference(JSON.stringify(MILESTONES))
    for (const locale of ['pt-BR', 'en-US', 'es-ES']) {
      const names: string[] = []
      for (const min of MINS) {
        const cur = computeMilestone(min, locale).current
        expect(typeof cur.name).toBe('string')
        expect(cur.name.length).toBeGreaterThan(0)
        expect(typeof cur.description).toBe('string')
        expect(cur.description.length).toBeGreaterThan(0)
        assertNoReference(`${cur.name} ${cur.description}`)
        names.push(cur.name)
      }
      expect(new Set(names).size).toBe(6)
      if (locale === 'pt-BR') expect(names).toEqual(OWN_NAMES)
    }
  })

  it('AC-T55-05 nenhum nome do produto de referência no código do dashboard nem no i18n', () => {
    const roots = ['packages/core/src/dashboard', 'apps/api/src/routes/dashboard', 'apps/web/src/i18n']
    const files: string[] = []
    const walk = (dir: string) => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|json)$/.test(e)) files.push(p)
      }
    }
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    for (const r of roots) walk(join(root, r))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const n of REFERENCE_NAMES) expect(text.toLowerCase(), `${file} contém "${n}"`).not.toContain(n.toLowerCase())
    }
  })

  it('AC-T55-05 bootstrap: selo calculado sobre o faturamento acumulado (BRL quando houver; senão soma)', async () => {
    const a = await newOwner(env)
    await addSale(env, a.companyId, { amount: 7_000_000, at: '2025-01-10T12:00:00-03:00' })
    await addSale(env, a.companyId, { amount: 500_000, at: '2026-02-10T12:00:00-03:00' })
    await addSale(env, a.companyId, { amount: 9_000, currency: 'USD', at: '2026-02-11T12:00:00-03:00' })
    await addSale(env, a.companyId, { amount: 9_000_000, status: 'refunded', at: '2026-02-12T12:00:00-03:00' })
    const ba = await a.c.get('/api/dashboard/bootstrap')
    expect(ba.status, ba.text).toBe(200)
    expect(ba.body.lifetime_revenue).toMatchObject({ revenue_cents: 7_500_000, revenue_by_currency: { BRL: 7_500_000, USD: 9_000 } })
    expect(ba.body.lifetime_revenue.milestone).toMatchObject({ level: 1 })
    expect(ba.body.lifetime_revenue.milestone.current).toMatchObject({ name: 'Primeira Marca' })
    expect(ba.body.lifetime_revenue.milestone.progress_pct).toBeCloseTo(50, 6)
    assertNoReference(ba.text)

    const b = await newOwner(env)
    await addSale(env, b.companyId, { amount: 300, currency: 'USD', at: '2026-02-11T12:00:00-03:00' })
    await addSale(env, b.companyId, { amount: 200, currency: 'EUR', at: '2026-02-11T12:00:00-03:00' })
    const bb = await b.c.get('/api/dashboard/bootstrap')
    expect(bb.body.lifetime_revenue).toMatchObject({ revenue_cents: 500 })
    expect(bb.body.lifetime_revenue.milestone).toMatchObject({ level: 0, current: null })
  })
})

describe('AC-T55-06 ticket, conversão, ROAS, lucro e despesas', () => {
  /** Empresa com 2 vendas (1.000,00 + 500,00) e 4 leads novos em 01–10/06/2026. */
  async function seedProfit(): Promise<{ owner: User; conn: string }> {
    const owner = await newOwner(env)
    const co = owner.companyId
    await setTimeZone(env, co, 'America/Sao_Paulo')
    const conn = await newConnection(env, co, 'Loja Lucro')
    await addSale(env, co, { amount: 100_000, at: '2026-06-02T10:00:00-03:00', connectionId: conn })
    await addSale(env, co, { amount: 50_000, at: '2026-06-05T10:00:00-03:00', connectionId: conn })
    for (let i = 1; i <= 4; i++) await addMessage(env, co, conn, await newContact(env, co, 'SP'), `2026-06-0${i}T09:00:00-03:00`)
    return { owner, conn }
  }

  async function rule(u: User, body: Record<string, unknown>): Promise<string> {
    const r = await u.c.post('/api/sales/expense-rules', body)
    expect(r.status, r.text).toBe(201)
    return r.body.expense_rule.id
  }

  const R = { start: '2026-06-01', end: '2026-06-10' }

  it('AC-T55-06 fixa mensal rateada + percentual sobre faturamento: valores calculados à mão', async () => {
    const { owner } = await seedProfit()
    env.spend.set(owner.companyId, '2026-06-01', '2026-06-10', 60_000)
    const fixed = await rule(owner, { name: 'Aluguel', kind: 'fixed', amount_cents: 300_000, period: 'month' })
    const pct = await rule(owner, { name: 'Imposto', kind: 'percent', percent: 10, percent_base: 'revenue', period: 'month' })

    const k = (await dashboard(owner, R)).sales
    // ticket = 150000 / 2; conversão = 2 / 4; ROAS = 150000 / 60000
    // lucro antes das taxas = 150000 − 60000; despesas = 300000 × 10/30 + 150000 × 10% = 100000 + 15000
    expect(k.kpis).toMatchObject({
      revenue_cents: 150_000,
      sales_count: 2,
      new_leads: 4,
      avg_ticket_cents: 75_000,
      spend_cents: 60_000,
      profit_pre_fees_cents: 90_000,
      expenses_cents: 115_000,
      profit_cents: -25_000,
    })
    expect(k.kpis.conversion_rate).toBeCloseTo(0.5, 6)
    expect(k.kpis.roas).toBeCloseTo(2.5, 6)
    expect(pick(k.expenses_breakdown, 'rule_id', fixed)).toMatchObject({ name: 'Aluguel', kind: 'fixed', period: 'month', value_cents: 100_000 })
    expect(pick(k.expenses_breakdown, 'rule_id', pct)).toMatchObject({ name: 'Imposto', kind: 'percent', percent_base: 'revenue', value_cents: 15_000 })
  })

  it('AC-T55-06 gasto vem do AdSpendProvider (período atual e anterior, fuso e conexões)', async () => {
    const { owner, conn } = await seedProfit()
    const before = env.spend.calls.length
    await dashboard(owner, { ...R, connectionIds: [conn], force: true })
    const calls = env.spend.calls.slice(before).filter((c) => c.companyId === owner.companyId)
    expect(calls).toEqual(
      expect.arrayContaining([
        { companyId: owner.companyId, startDate: '2026-06-01', endDate: '2026-06-10', timeZone: 'America/Sao_Paulo', connectionIds: [conn] },
        { companyId: owner.companyId, startDate: '2026-05-22', endDate: '2026-05-31', timeZone: 'America/Sao_Paulo', connectionIds: [conn] },
      ]),
    )
  })

  it('AC-T55-06 ROAS é nulo com gasto 0 (e lucro antes das taxas = faturamento)', async () => {
    const { owner } = await seedProfit()
    const k = (await dashboard(owner, R)).sales.kpis
    expect(k.spend_cents).toBe(0)
    expect(k.roas).toBeNull()
    expect(k).toMatchObject({ profit_pre_fees_cents: 150_000, expenses_cents: 0, profit_cents: 150_000 })
    // sem vendas: ticket nulo; sem leads: conversão nula
    const empty = (await dashboard(owner, { start: '2026-07-01', end: '2026-07-05' })).sales.kpis
    expect(empty).toMatchObject({ sales_count: 0, revenue_cents: 0, avg_ticket_cents: null, conversion_rate: null, roas: null })
  })

  it('AC-T55-06 vigência das regras, períodos dia/semana e bases spend/profit_pre', async () => {
    const { owner } = await seedProfit()
    env.spend.set(owner.companyId, '2026-06-01', '2026-06-10', 60_000)
    // semanal de 70,00 vigente de 06/06: 5 dias → 7000 × 5/7 = 5000
    await rule(owner, { name: 'Ferramenta', kind: 'fixed', amount_cents: 7_000, period: 'week', active_from: '2026-06-06' })
    // diária de 10,00 até 03/06: 3 dias → 3000
    await rule(owner, { name: 'Diária', kind: 'fixed', amount_cents: 1_000, period: 'day', active_to: '2026-06-03' })
    // vencida antes do período: não entra
    await rule(owner, { name: 'Antiga', kind: 'fixed', amount_cents: 999_999, period: 'month', active_to: '2026-05-31' })
    // 20% do gasto (60000) → 12000; 5% do lucro antes das taxas (90000) → 4500
    await rule(owner, { name: 'Agência', kind: 'percent', percent: 20, percent_base: 'spend', period: 'month' })
    await rule(owner, { name: 'Sócio', kind: 'percent', percent: 5, percent_base: 'profit_pre', period: 'month' })
    // 10% do faturamento, vigente de 06/06: 150000 × 10% × 5/10 = 7500
    await rule(owner, { name: 'Taxa parcial', kind: 'percent', percent: 10, percent_base: 'revenue', period: 'month', active_from: '2026-06-06' })

    const s = (await dashboard(owner, R)).sales
    const byName = (n: string) => pick(s.expenses_breakdown, 'name', n)
    expect(byName('Ferramenta').value_cents).toBe(5_000)
    expect(byName('Diária').value_cents).toBe(3_000)
    expect(byName('Antiga')?.value_cents ?? 0).toBe(0)
    expect(byName('Agência').value_cents).toBe(12_000)
    expect(byName('Sócio').value_cents).toBe(4_500)
    expect(byName('Taxa parcial').value_cents).toBe(7_500)
    expect(s.kpis.expenses_cents).toBe(32_000)
    expect(s.kpis.profit_cents).toBe(90_000 - 32_000)
  })

  it('AC-T55-06 lucro antes das taxas negativo não gera despesa percentual negativa', async () => {
    const { owner } = await seedProfit()
    env.spend.set(owner.companyId, '2026-06-01', '2026-06-10', 200_000)
    await rule(owner, { name: 'Sócio', kind: 'percent', percent: 5, percent_base: 'profit_pre', period: 'month' })
    const k = (await dashboard(owner, R)).sales.kpis
    expect(k.profit_pre_fees_cents).toBe(-50_000)
    expect(k.roas).toBeCloseTo(0.75, 6)
    expect(k.expenses_cents).toBe(0)
    expect(k.profit_cents).toBe(-50_000)
  })
})
