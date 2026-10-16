// AC-T34-01..05 — vendas (record idempotente, eventos), produtos (faixa de preço), regras de despesa, grupos de filtro,
// listagem com filtros/paginação no fuso da empresa e herança da atribuição do contato.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uniqueId } from '../helpers/factories'
import { allSales, contact, type Env, fieldPaths, newOwner, newUuid, product, PRODUCT, startEnv } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const recordedFor = (list: Env['direct'], companyId: string) => list.filter((e) => e.companyId === companyId && e.type === 'sale.recorded')

describe('T34 — record idempotente', () => {
  it('AC-T34-01 mesmo (origem, external_id) duas vezes cria 1 venda e atualiza o status; sale.recorded uma vez', async () => {
    const o = await newOwner(env)
    const ext = uniqueId('pedido')
    const first = await env.sales.record({ companyId: o.companyId, source: 'webhook', externalId: ext, status: 'pending', amountCents: 19_900, currency: 'BRL' })
    expect(first.created).toBe(true)
    const second = await env.sales.record({ companyId: o.companyId, source: 'webhook', externalId: ext, status: 'approved', amountCents: 19_900, currency: 'BRL' })
    expect(second.created).toBe(false)
    expect(second.sale.id).toBe(first.sale.id)

    const rows = await env.q(`SELECT status FROM crm.sales WHERE company_id = $1 AND external_id = $2`, [o.companyId, ext])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('approved')
    const events = recordedFor(env.direct, o.companyId)
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0]!.data)).toContain(first.sale.id)

    await env.sales.record({ companyId: o.companyId, source: 'webhook', externalId: ext, status: 'refunded', amountCents: 19_900, currency: 'BRL' })
    expect((await env.q(`SELECT status FROM crm.sales WHERE id = $1`, [first.sale.id]))[0].status).toBe('refunded')
    expect(recordedFor(env.direct, o.companyId)).toHaveLength(1)
  })

  it('AC-T34-01 mesmo external_id em outra origem ou outra empresa é outra venda (e outro evento)', async () => {
    const a = await newOwner(env)
    const b = await newOwner(env)
    const ext = uniqueId('pedido')
    await env.sales.record({ companyId: a.companyId, source: 'webhook', externalId: ext, amountCents: 100, currency: 'BRL' })
    const otherSource = await env.sales.record({ companyId: a.companyId, source: 'flow', externalId: ext, amountCents: 100, currency: 'BRL' })
    const otherCompany = await env.sales.record({ companyId: b.companyId, source: 'webhook', externalId: ext, amountCents: 100, currency: 'BRL' })
    expect(otherSource.created).toBe(true)
    expect(otherCompany.created).toBe(true)
    expect(recordedFor(env.direct, a.companyId)).toHaveLength(2)
    expect(recordedFor(env.direct, b.companyId)).toHaveLength(1)
  })

  it('AC-T34-01 records concorrentes com a mesma chave criam 1 venda e 1 evento', async () => {
    const o = await newOwner(env)
    const ext = uniqueId('pedido')
    const results = await Promise.all(
      Array.from({ length: 8 }, () => env.sales.record({ companyId: o.companyId, source: 'webhook', externalId: ext, amountCents: 5_000, currency: 'BRL' })),
    )
    expect(results.filter((r: any) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r: any) => r.sale.id)).size).toBe(1)
    expect(await env.q(`SELECT id FROM crm.sales WHERE company_id = $1`, [o.companyId])).toHaveLength(1)
    expect(recordedFor(env.direct, o.companyId)).toHaveLength(1)
  })

  it('AC-T34-01 vendas sem external_id são sempre novas, cada uma com seu evento', async () => {
    const o = await newOwner(env)
    await env.sales.record({ companyId: o.companyId, source: 'flow', amountCents: 100, currency: 'BRL' })
    await env.sales.record({ companyId: o.companyId, source: 'flow', amountCents: 100, currency: 'BRL' })
    expect(await env.q(`SELECT id FROM crm.sales WHERE company_id = $1`, [o.companyId])).toHaveLength(2)
    expect(recordedFor(env.direct, o.companyId)).toHaveLength(2)
  })

  it('AC-T34-01 pela API: POST /api/sales repetido com o mesmo external_id manual → 1 venda, 1 evento', async () => {
    const o = await newOwner(env)
    const ext = uniqueId('nf')
    const r1 = await o.c.post('/api/sales', { amount_cents: 12_345, currency: 'BRL', external_id: ext, status: 'pending' })
    expect(r1.status, r1.text).toBe(201)
    expect(r1.body.created).toBe(true)
    const r2 = await o.c.post('/api/sales', { amount_cents: 12_345, currency: 'BRL', external_id: ext, status: 'approved' })
    expect(r2.status, r2.text).toBe(200)
    expect(r2.body.created).toBe(false)
    expect(r2.body.sale.status).toBe('approved')
    expect(recordedFor(env.http, o.companyId)).toHaveLength(1)
  })
})

describe('T34 — produtos', () => {
  it('AC-T34-02 price_max < price_min → 422', async () => {
    const o = await newOwner(env)
    const res = await o.c.post('/api/products', PRODUCT({ price_min_cents: 50_000, price_max_cents: 10_000 }))
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain('price_max_cents')
  })

  it.each([0, -100])('AC-T34-02 price_fallback ≤ 0 (%s) → 422', async (fallback) => {
    const o = await newOwner(env)
    const res = await o.c.post('/api/products', PRODUCT({ price_fallback_cents: fallback }))
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain('price_fallback_cents')
  })

  it('AC-T34-02 PATCH que inverte a faixa → 422 e o produto não muda', async () => {
    const o = await newOwner(env)
    const p = await product(o)
    const res = await o.c.patch(`/api/products/${p.id}`, { price_max_cents: 5_000 })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect((await o.c.get(`/api/products/${p.id}`)).body.product.price_max_cents).toBe(50_000)
  })

  it('AC-T34-02 produto válido é criado (min = max permitido)', async () => {
    const o = await newOwner(env)
    const res = await o.c.post('/api/products', PRODUCT({ price_min_cents: 9_900, price_max_cents: 9_900, price_fallback_cents: 9_900 }))
    expect(res.status, res.text).toBe(201)
    expect(res.body.product.public_id).toBeTruthy()
  })

  it('AC-T34-02 resolvePrice usa o valor dentro da faixa e o fallback fora dela', () => {
    const p = { price_min_cents: 10_000, price_max_cents: 50_000, price_fallback_cents: 29_700 }
    const r = env.core.resolvePrice
    expect(r(p, 10_000)).toBe(10_000) // limite inferior incluído
    expect(r(p, 33_300)).toBe(33_300)
    expect(r(p, 50_000)).toBe(50_000) // limite superior incluído
    expect(r(p, 9_999)).toBe(29_700)
    expect(r(p, 50_001)).toBe(29_700)
    expect(r(p, 0)).toBe(29_700)
    expect(r(p, null)).toBe(29_700)
    expect(r(p, undefined)).toBe(29_700)
  })
})

describe('T34 — regras de despesa e grupos de filtro', () => {
  it('AC-T34-03 regra de despesa percentual sem percent_base → 422', async () => {
    const o = await newOwner(env)
    const res = await o.c.post('/api/sales/expense-rules', { name: 'Taxa do gateway', kind: 'percent', percent: 4.99, period: 'month' })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain('percent_base')
    expect((await o.c.get('/api/sales/expense-rules')).body.items ?? []).toHaveLength(0)
  })

  it('AC-T34-03 regra percentual com base e regra fixa sem base são aceitas', async () => {
    const o = await newOwner(env)
    const pct = await o.c.post('/api/sales/expense-rules', { name: 'Imposto', kind: 'percent', percent: 6, percent_base: 'revenue', period: 'month' })
    expect(pct.status, pct.text).toBe(201)
    expect(pct.body.expense_rule.percent_base).toBe('revenue')
    const fixed = await o.c.post('/api/sales/expense-rules', { name: 'Aluguel', kind: 'fixed', amount_cents: 150_000, period: 'month' })
    expect(fixed.status, fixed.text).toBe(201)
    expect(fixed.body.expense_rule.percent_base ?? null).toBeNull()
  })

  it('AC-T34-03 PATCH mudando para percentual sem percent_base → 422', async () => {
    const o = await newOwner(env)
    const fixed = await o.c.post('/api/sales/expense-rules', { name: 'Ferramentas', kind: 'fixed', amount_cents: 9_900, period: 'month' })
    const res = await o.c.patch(`/api/sales/expense-rules/${fixed.body.expense_rule.id}`, { kind: 'percent', percent: 3 })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain('percent_base')
  })

  it('AC-T34-03 nome de grupo de filtro repetido (sem diferenciar caixa) → 409', async () => {
    const o = await newOwner(env)
    const g = await o.c.post('/api/sales/filter-groups', { name: 'Lançamento VIP', connection_ids: [newUuid()], product_ids: [], ad_account_ids: [] })
    expect(g.status, g.text).toBe(201)
    for (const name of ['lançamento vip', 'LANÇAMENTO VIP', '  Lançamento VIP  ']) {
      const dup = await o.c.post('/api/sales/filter-groups', { name, connection_ids: [newUuid()], product_ids: [], ad_account_ids: [] })
      expectApiError(dup, 'CONFLICT', 409)
    }
    expect((await o.c.get('/api/sales/filter-groups')).body.items).toHaveLength(1)
  })

  it('AC-T34-03 renomear grupo para nome existente (outra caixa) → 409', async () => {
    const o = await newOwner(env)
    await o.c.post('/api/sales/filter-groups', { name: 'Perpétuo', connection_ids: [newUuid()], product_ids: [], ad_account_ids: [] })
    const other = await o.c.post('/api/sales/filter-groups', { name: 'Black Friday', connection_ids: [newUuid()], product_ids: [], ad_account_ids: [] })
    const res = await o.c.patch(`/api/sales/filter-groups/${other.body.filter_group.id}`, { name: 'PERPÉTUO' })
    expectApiError(res, 'CONFLICT', 409)
  })

  it('AC-T34-03 o mesmo nome em outra empresa é permitido', async () => {
    const a = await newOwner(env)
    const b = await newOwner(env)
    const body = { name: 'Grupo Comum', connection_ids: [newUuid()], product_ids: [], ad_account_ids: [] }
    expect((await a.c.post('/api/sales/filter-groups', body)).status).toBe(201)
    expect((await b.c.post('/api/sales/filter-groups', body)).status).toBe(201)
  })
})

describe('T34 — listagem de vendas', () => {
  it('AC-T34-04 paginação infinita de 20 (has_more) sem repetir vendas', async () => {
    const o = await newOwner(env)
    for (let i = 0; i < 45; i++)
      await env.sales.record({ companyId: o.companyId, source: 'manual', amountCents: 1_000 + i, currency: 'BRL', soldAt: new Date(Date.UTC(2026, 8, 1, 12, i)) })
    const p1 = await o.c.get('/api/sales')
    expect(p1.status, p1.text).toBe(200)
    expect(p1.body.items).toHaveLength(20)
    expect(p1.body.page).toMatchObject({ page: 1, limit: 20, has_more: true })
    const all = await allSales(o.c)
    expect(all.items).toHaveLength(45)
    expect(new Set(all.ids).size).toBe(45)
    expect(all.pages.map((p: any) => p.has_more)).toEqual([true, true, false])
    // mais recentes primeiro
    const times = all.items.map((s: any) => Date.parse(s.sold_at))
    expect([...times].sort((x, y) => y - x)).toEqual(times)
  })

  it('AC-T34-04 período em datas do fuso da empresa (America/Sao_Paulo)', async () => {
    const o = await newOwner(env)
    const rec = (iso: string) => env.sales.record({ companyId: o.companyId, source: 'manual', amountCents: 100, currency: 'BRL', soldAt: iso })
    // 30/09 23:30 em SP = 01/10 02:30 UTC; 01/10 00:30 em SP = 01/10 03:30 UTC
    const lateSep30 = (await rec('2026-10-01T02:30:00Z')).sale.id
    const earlyOct1 = (await rec('2026-10-01T03:30:00Z')).sale.id
    const startSep30 = (await rec('2026-09-30T03:00:00Z')).sale.id // 30/09 00:00 em SP
    const lateSep29 = (await rec('2026-09-30T02:59:00Z')).sale.id // 29/09 23:59 em SP
    const sep30 = await allSales(o.c, 'start_date=2026-09-30&end_date=2026-09-30')
    expect(sep30.ids.sort()).toEqual([lateSep30, startSep30].sort())
    const oct1 = await allSales(o.c, 'start_date=2026-10-01&end_date=2026-10-01')
    expect(oct1.ids).toEqual([earlyOct1])
    expect((await allSales(o.c, 'start_date=2026-09-29&end_date=2026-09-29')).ids).toEqual([lateSep29])
  })

  it('AC-T34-04 período com só uma das datas → 422', async () => {
    const o = await newOwner(env)
    expectApiError(await o.c.get('/api/sales?start_date=2026-09-01'), 'VALIDATION_ERROR', 422)
    expectApiError(await o.c.get('/api/sales?end_date=2026-09-30'), 'VALIDATION_ERROR', 422)
  })

  it('AC-T34-04 filtra por conexão, produto e status (e combinação)', async () => {
    const o = await newOwner(env)
    const c1 = newUuid()
    const c2 = newUuid()
    const p1 = (await product(o)).id
    const p2 = (await product(o)).id
    const rec = (connectionId: string, productId: string, status: string) =>
      env.sales.record({ companyId: o.companyId, source: 'manual', amountCents: 100, currency: 'BRL', connectionId, productId, status })
    const a = (await rec(c1, p1, 'approved')).sale.id
    const b = (await rec(c1, p2, 'refunded')).sale.id
    const c = (await rec(c2, p1, 'approved')).sale.id
    const d = (await rec(c2, p2, 'pending')).sale.id
    const e = (await rec(c1, p1, 'chargeback')).sale.id

    expect((await allSales(o.c, `connection_ids=${c1}`)).ids.sort()).toEqual([a, b, e].sort())
    expect((await allSales(o.c, `product_ids=${p2}`)).ids.sort()).toEqual([b, d].sort())
    expect((await allSales(o.c, 'status=approved')).ids.sort()).toEqual([a, c].sort())
    expect((await allSales(o.c, 'status=refunded&status=chargeback')).ids.sort()).toEqual([b, e].sort())
    expect((await allSales(o.c, `connection_ids=${c1}&product_ids=${p1}&status=approved`)).ids).toEqual([a])
    expect((await allSales(o.c, `connection_ids=${c1},${c2}&status=pending`)).ids).toEqual([d])
  })

  it('AC-T34-04 vendas de outra empresa não aparecem', async () => {
    const a = await newOwner(env)
    const b = await newOwner(env)
    await env.sales.record({ companyId: b.companyId, source: 'manual', amountCents: 100, currency: 'BRL' })
    expect((await allSales(a.c)).items).toHaveLength(0)
  })
})

describe('T34 — atribuição herdada', () => {
  it('AC-T34-05 venda de contato com source_id herda a atribuição do contato', async () => {
    const o = await newOwner(env)
    const ct = await contact(env, o.companyId, { sourceId: 'AD-120210000000001', ctwaClid: 'clid-t34-abc' })
    const { sale } = await env.sales.record({ companyId: o.companyId, source: 'flow', amountCents: 9_700, currency: 'BRL', contactId: ct })
    const [row] = await env.q(`SELECT source_id, ctwa_clid FROM crm.sales WHERE id = $1`, [sale.id])
    expect(row.source_id).toBe('AD-120210000000001')
    expect(row.ctwa_clid).toBe('clid-t34-abc')
  })

  it('AC-T34-05 pela API: venda manual de contato com source_id herda a atribuição', async () => {
    const o = await newOwner(env)
    const ct = await contact(env, o.companyId, { sourceId: 'AD-API-777' })
    const res = await o.c.post('/api/sales', { amount_cents: 4_990, currency: 'BRL', contact_id: ct })
    expect(res.status, res.text).toBe(201)
    expect(res.body.sale.source_id).toBe('AD-API-777')
  })

  it('AC-T34-05 source_id explícito vence o do contato; contato sem atribuição não inventa nada', async () => {
    const o = await newOwner(env)
    const ct = await contact(env, o.companyId, { sourceId: 'AD-DO-CONTATO' })
    const explicit = await env.sales.record({ companyId: o.companyId, source: 'webhook', amountCents: 100, currency: 'BRL', contactId: ct, sourceId: 'AD-EXPLICITO' })
    expect((await env.q(`SELECT source_id FROM crm.sales WHERE id = $1`, [explicit.sale.id]))[0].source_id).toBe('AD-EXPLICITO')

    const plain = await contact(env, o.companyId)
    const none = await env.sales.record({ companyId: o.companyId, source: 'webhook', amountCents: 100, currency: 'BRL', contactId: plain })
    expect((await env.q(`SELECT source_id FROM crm.sales WHERE id = $1`, [none.sale.id]))[0].source_id).toBeNull()
  })
})
