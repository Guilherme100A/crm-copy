// AC-T105-01..04 pelo contrato HTTP: GET /api/meta/structure-bundle (createApp com a montagem das rotas e o worker real
// do job meta-sync), FakeMetaGraph (nunca a Graph real) e vendas gravadas em crm.sales.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleUrl, connect, owner, startEnv, startMetaWorker, type Account, type Env, type User } from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let env: Env

beforeAll(async () => {
  env = await startEnv()
}, 120_000)

afterAll(async () => {
  await env?.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PERIOD = { date_preset: 'custom', since: '2026-10-10', until: '2026-10-10', display_currency: 'BRL' }

/**
 * Campanha C (gasto 150): conjunto S1 (150) com A1 (100) e A2 (50); conjunto S2 (0) com A3 (0).
 * Campanha C2 (20) sem conjuntos nem anúncios.
 */
function seed(env: Env, acc: Account, spend = { a1: '100', a2: '50', a3: '0', s1: '150', s2: '0', c: '150', c2: '20' }) {
  const t = acc.fb.replace(/\D/g, '').slice(-8)
  const ids = { c: `9${t}1`, c2: `9${t}2`, s1: `9${t}3`, s2: `9${t}4`, a1: `9${t}5`, a2: `9${t}6`, a3: `9${t}7` }
  env.fake.setStructure(acc.fb, {
    campaigns: [
      { id: ids.c, name: 'C', effective_status: 'ACTIVE' },
      { id: ids.c2, name: 'C2', effective_status: 'ACTIVE' },
    ],
    adsets: [
      { id: ids.s1, name: 'S1', campaign_id: ids.c, effective_status: 'ACTIVE' },
      { id: ids.s2, name: 'S2', campaign_id: ids.c, effective_status: 'ACTIVE' },
    ],
    ads: [
      { id: ids.a1, name: 'A1', campaign_id: ids.c, adset_id: ids.s1, effective_status: 'ACTIVE' },
      { id: ids.a2, name: 'A2', campaign_id: ids.c, adset_id: ids.s1, effective_status: 'ACTIVE' },
      { id: ids.a3, name: 'A3', campaign_id: ids.c, adset_id: ids.s2, effective_status: 'ACTIVE' },
    ],
  })
  env.fake.setInsights(acc.fb, 'campaign', [
    { campaign_id: ids.c, spend: spend.c },
    { campaign_id: ids.c2, spend: spend.c2 },
  ])
  env.fake.setInsights(acc.fb, 'adset', [
    { campaign_id: ids.c, adset_id: ids.s1, spend: spend.s1 },
    { campaign_id: ids.c, adset_id: ids.s2, spend: spend.s2 },
  ])
  env.fake.setInsights(acc.fb, 'ad', [
    { campaign_id: ids.c, adset_id: ids.s1, ad_id: ids.a1, spend: spend.a1 },
    { campaign_id: ids.c, adset_id: ids.s1, ad_id: ids.a2, spend: spend.a2 },
    { campaign_id: ids.c, adset_id: ids.s2, ad_id: ids.a3, spend: spend.a3 },
  ])
  env.fake.setInsights(acc.fb, 'account', [{ spend: spend.c }])
  return ids
}

// Revisão 3 (AC-T105-05): venda com source_id gravada pelo SalesService sai confirmed_native; só confirmadas entram.
async function sale(u: User, s: { cents: number; at: string; source: string | null; status?: string; currency?: string }) {
  await env.q(`INSERT INTO crm.sales (company_id, amount_cents, sold_at, source_id, status, currency, attribution_confidence) VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4::text IS NOT NULL THEN 'confirmed_native' ELSE 'none' END)`, [
    u.companyId,
    s.cents,
    s.at,
    s.source,
    s.status ?? 'approved',
    s.currency ?? 'BRL',
  ])
}

/** Vendas do cenário padrão (empresa em America/Sao_Paulo, período 2026-10-10). */
async function seedSales(u: User, ids: ReturnType<typeof seed>) {
  await env.q(`UPDATE crm.companies SET time_zone = 'America/Sao_Paulo' WHERE id = $1`, [u.companyId])
  // A1: 23:30 local do dia 10 (02:30Z do dia 11) + 12:00 local → entram; reembolsada, pendente e 23:59 do dia 9 → fora.
  await sale(u, { cents: 10_000, at: '2026-10-11T02:30:00Z', source: ids.a1 })
  await sale(u, { cents: 5_000, at: '2026-10-10T15:00:00Z', source: ids.a1 })
  await sale(u, { cents: 9_900, at: '2026-10-10T15:00:00Z', source: ids.a1, status: 'refunded' })
  await sale(u, { cents: 9_900, at: '2026-10-10T15:00:00Z', source: ids.a1, status: 'pending' })
  await sale(u, { cents: 9_900, at: '2026-10-10T02:59:00Z', source: ids.a1 })
  await sale(u, { cents: 9_900, at: '2026-10-11T03:00:00Z', source: ids.a1 })
  // A2: R$ 25,50. A3 (gasto 0): R$ 10,00.
  await sale(u, { cents: 2_550, at: '2026-10-10T15:00:00Z', source: ids.a2 })
  await sale(u, { cents: 1_000, at: '2026-10-10T15:00:00Z', source: ids.a3 })
  // Sem source_id (AC-04) e com id quase igual: não entram em nenhum anúncio.
  await sale(u, { cents: 77_700, at: '2026-10-10T15:00:00Z', source: null })
  await sale(u, { cents: 77_700, at: '2026-10-10T15:00:00Z', source: '' })
  await sale(u, { cents: 77_700, at: '2026-10-10T15:00:00Z', source: '   ' })
  await sale(u, { cents: 77_700, at: '2026-10-10T15:00:00Z', source: ` ${ids.a1}` })
}

const metricsById = (rows: Any[]) => Object.fromEntries(rows.map((r: Any) => [r.id, r.metrics]))

function expectScenario(body: Any, ids: ReturnType<typeof seed>) {
  const ad = metricsById(body.ad)
  const set = metricsById(body.adset)
  const cmp = metricsById(body.campaign)
  // AC-01: por anúncio, no fuso da empresa, só approved
  expect(ad[ids.a1], JSON.stringify(ad[ids.a1])).toMatchObject({ purchases_leona: 2, purchase_value_leona: 150, purchase_value_leona_display: 150 })
  expect(ad[ids.a2]).toMatchObject({ purchases_leona: 1, purchase_value_leona: 25.5, purchase_value_leona_display: 25.5 })
  expect(ad[ids.a3]).toMatchObject({ purchases_leona: 1, purchase_value_leona_display: 10 })
  // AC-02: conjunto e campanha = soma dos anúncios; campanha sem anúncios = 0
  expect(set[ids.s1]).toMatchObject({ purchases_leona: 3, purchase_value_leona_display: 175.5 })
  expect(set[ids.s2]).toMatchObject({ purchases_leona: 1, purchase_value_leona_display: 10 })
  expect(cmp[ids.c]).toMatchObject({ purchases_leona: 4, purchase_value_leona_display: 185.5 })
  expect(cmp[ids.c2]).toMatchObject({ purchases_leona: 0, purchase_value_leona_display: 0 })
  // AC-03: ROAS = valor ÷ gasto (2 casas); gasto 0 → null
  expect(ad[ids.a1].roas_internal).toBe(1.5)
  expect(ad[ids.a2].roas_internal).toBe(0.51)
  expect(ad[ids.a3].roas_internal).toBeNull()
  expect(set[ids.s1].roas_internal).toBe(1.17)
  expect(set[ids.s2].roas_internal).toBeNull()
  expect(cmp[ids.c].roas_internal).toBe(1.24)
  expect(cmp[ids.c2].roas_internal).toBe(0)
}

describe('T105 — bundle síncrono pela API (AC-T105-01..04)', () => {
  it('AC-T105-01 AC-T105-02 AC-T105-03 AC-T105-04 GET structure-bundle traz vendas internas por anúncio, conjunto e campanha', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'sync', currency: 'BRL' }])
    const ids = seed(env, acc!)
    await seedSales(o, ids)
    const r = await o.c.get(bundleUrl([acc!], PERIOD))
    expect(r.status, r.text).toBe(200)
    expect(r.body.status).toBe('ready')
    expect(r.body.warnings ?? []).toEqual([])
    expectScenario(r.body, ids)
  })

  it('AC-T105-01 a mesma venda das 02:30Z vai para o dia 11 numa empresa em UTC (fuso da empresa, não do servidor)', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'utc' }])
    const ids = seed(env, acc!)
    await env.q(`UPDATE crm.companies SET time_zone = 'UTC' WHERE id = $1`, [o.companyId])
    await sale(o, { cents: 10_000, at: '2026-10-11T02:30:00Z', source: ids.a1 })
    const d10 = await o.c.get(bundleUrl([acc!], PERIOD))
    expect(d10.status, d10.text).toBe(200)
    expect(metricsById(d10.body.ad)[ids.a1]).toMatchObject({ purchases_leona: 0, purchase_value_leona_display: 0 })
    const d11 = await o.c.get(bundleUrl([acc!], { ...PERIOD, since: '2026-10-11', until: '2026-10-11' }))
    expect(metricsById(d11.body.ad)[ids.a1]).toMatchObject({ purchases_leona: 1, purchase_value_leona_display: 100 })
    expect(metricsById(d11.body.campaign)[ids.c]).toMatchObject({ purchases_leona: 1, purchase_value_leona_display: 100 })
  })

  it('AC-T105-01 conta em USD: purchase_value_leona na moeda da conta e _display na exibição; sem cotação → fx_rate_missing', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'usd', currency: 'USD' }])
    // gastos em USD: A1 = 20 (= R$ 100 na exibição)
    const ids = seed(env, acc!, { a1: '20', a2: '0', a3: '0', s1: '20', s2: '0', c: '20', c2: '0' })
    await env.q(`UPDATE crm.companies SET time_zone = 'America/Sao_Paulo' WHERE id = $1`, [o.companyId])
    await sale(o, { cents: 25_000, at: '2026-10-10T15:00:00Z', source: ids.a1 }) // R$ 250 = US$ 50
    await sale(o, { cents: 3_000, at: '2026-10-10T15:00:00Z', source: ids.a1, currency: 'EUR' }) // sem cotação
    const r = await o.c.get(bundleUrl([acc!], PERIOD))
    expect(r.status, r.text).toBe(200)
    const a1 = metricsById(r.body.ad)[ids.a1]
    expect(a1).toMatchObject({ purchases_leona: 2, purchase_value_leona: 50, purchase_value_leona_display: 250 })
    expect(a1.roas_internal).toBe(2.5)
    expect(r.body.warnings).toContain('fx_rate_missing:EUR->BRL')
  })

  it('AC-T105-03 gasto 0 em todos os níveis → roas_internal null em todos, com as vendas preenchidas', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'zero' }])
    const ids = seed(env, acc!, { a1: '0', a2: '0', a3: '0', s1: '0', s2: '0', c: '0', c2: '0' })
    await env.q(`UPDATE crm.companies SET time_zone = 'America/Sao_Paulo' WHERE id = $1`, [o.companyId])
    await sale(o, { cents: 5_000, at: '2026-10-10T15:00:00Z', source: ids.a1 })
    const r = await o.c.get(bundleUrl([acc!], PERIOD))
    expect(r.status, r.text).toBe(200)
    for (const level of ['ad', 'adset', 'campaign']) for (const row of r.body[level]) expect(row.metrics.roas_internal, `${level} ${row.id}`).toBeNull()
    expect(metricsById(r.body.ad)[ids.a1].purchases_leona).toBe(1)
    expect(metricsById(r.body.campaign)[ids.c].purchase_value_leona_display).toBe(50)
  })

  it('AC-T105-04 só vendas sem source_id: nenhum anúncio, conjunto ou campanha recebe venda', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'nosrc' }])
    seed(env, acc!)
    await env.q(`UPDATE crm.companies SET time_zone = 'America/Sao_Paulo' WHERE id = $1`, [o.companyId])
    for (const source of [null, '', '   ']) await sale(o, { cents: 12_300, at: '2026-10-10T15:00:00Z', source })
    const r = await o.c.get(bundleUrl([acc!], PERIOD))
    expect(r.status, r.text).toBe(200)
    for (const level of ['ad', 'adset', 'campaign'])
      for (const row of r.body[level]) {
        expect(row.metrics.purchases_leona, `${level} ${row.id}`).toBe(0)
        expect(row.metrics.purchase_value_leona_display, `${level} ${row.id}`).toBe(0)
      }
  })
})

describe('T105 — bundle assíncrono pelo job meta-sync do worker (AC-T105-01..03)', () => {
  it('AC-T105-01 AC-T105-02 AC-T105-03 async=1 (worker real) traz as mesmas métricas internas', async () => {
    const o = await owner(env)
    const [acc] = await connect(env, o, [{ suffix: 'async' }])
    const ids = seed(env, acc!)
    await seedSales(o, ids)
    const worker = await startMetaWorker(env)
    try {
      const url = bundleUrl([acc!], { ...PERIOD, async: '1' })
      const first = await o.c.get(url)
      expect([200, 202], first.text).toContain(first.status)
      let body: Any = first.status === 200 && first.body.status === 'ready' ? first.body : null
      for (let i = 0; !body && i < 300; i++) {
        await sleep(100)
        const r = await o.c.get(url)
        if (r.status === 200 && r.body.status === 'ready') body = r.body
      }
      expect(body, 'bundle assíncrono não ficou pronto').toBeTruthy()
      expect(body.warnings ?? []).toEqual([])
      expectScenario(body, ids)
    } finally {
      await worker.stop()
    }
  })
})
