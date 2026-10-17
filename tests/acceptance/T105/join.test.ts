// AC-T105-01..04 pela função pura pública (`joinInternalSales`, `applyInternalMetrics`, `roasOf`, `hasSourceId` de
// @crm/core), com linhas de bundle montadas à mão. Sem banco, sem Graph.
import { describe, expect, it } from 'vitest'
import { applyInternalMetrics, fixedFxRates, hasSourceId, joinInternalSales, roasOf } from '@crm/core'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function row(id: string, opts: { campaign?: string; adset?: string; spend?: number | null; currency?: string | null } = {}): Any {
  const spend = opts.spend === undefined ? 100 : opts.spend
  return {
    id,
    name: `Linha ${id}`,
    status: 'ACTIVE',
    campaign_id: opts.campaign ?? null,
    adset_id: opts.adset ?? null,
    ad_account_id: 'local-1',
    fb_ad_account_id: 'act_1',
    ad_account_label: 'Conta 1',
    currency: opts.currency === undefined ? 'BRL' : opts.currency,
    daily_budget: null,
    lifetime_budget: null,
    daily_budget_display: null,
    lifetime_budget_display: null,
    metrics: {
      meta_spend: spend ?? 0,
      meta_spend_display: spend,
      purchase_value_meta: null,
      purchases_pixel: null,
      conversations_meta: null,
      meta_link_clicks: null,
      meta_impressions: null,
      cost_per_purchase_meta: null,
      cost_per_lead_meta: null,
      purchase_value_leona: null,
      purchases_leona: null,
    },
  }
}

const BRL = { displayCurrency: 'BRL', fx: fixedFxRates({ 'USD:BRL': 5 }) }
const agg = (sourceId: string, count: number, amountCents: number, currency = 'BRL') => ({ sourceId, currency, count, amountCents })

describe('T105 — soma por anúncio (AC-T105-01)', () => {
  it('AC-T105-01 purchases_internal e purchase_value_internal do anúncio somam as vendas com source_id = id do anúncio', () => {
    const rows = { campaign: [], adset: [], ad: [row('111'), row('222'), row('333')] }
    const r = joinInternalSales(rows, [agg('111', 2, 15_000), agg('222', 1, 2_550)], BRL)
    expect(r.ad.get('111')).toMatchObject({ purchases_internal: 2, purchase_value_internal: 150 })
    expect(r.ad.get('222')).toMatchObject({ purchases_internal: 1, purchase_value_internal: 25.5 })
    // anúncio sem venda: 0 (não null)
    expect(r.ad.get('333')).toMatchObject({ purchases_internal: 0, purchase_value_internal: 0 })
  })

  it('AC-T105-01 venda de anúncio que não está no bundle não aparece em nenhuma linha', () => {
    const rows = { campaign: [], adset: [], ad: [row('111')] }
    const r = joinInternalSales(rows, [agg('999', 4, 40_000)], BRL)
    expect([...r.ad.keys()]).toEqual(['111'])
    expect(r.ad.get('111')!.purchases_internal).toBe(0)
    expect(r.totals.purchases_internal).toBe(0)
  })

  it('AC-T105-01 vendas em outra moeda são convertidas para a exibição e para a moeda da conta da linha', () => {
    const rows = { campaign: [], adset: [], ad: [row('111', { currency: 'USD', spend: 100 })] }
    // 1 venda R$ 100 + 1 venda US$ 10 (=R$ 50); exibição BRL; conta USD.
    const r = joinInternalSales(rows, [agg('111', 1, 10_000, 'BRL'), agg('111', 1, 1_000, 'USD')], BRL)
    const m = r.ad.get('111')!
    expect(m.purchases_internal).toBe(2)
    expect(m.purchase_value_internal).toBe(150)
    expect(m.purchase_value_internal_account).toBe(30)
    expect(r.warnings).toEqual([])
  })

  it('AC-T105-01 venda sem cotação conta na quantidade, fica fora do valor e gera fx_rate_missing (sem somar em silêncio)', () => {
    const rows = { campaign: [], adset: [], ad: [row('111')] }
    const r = joinInternalSales(rows, [agg('111', 1, 10_000, 'BRL'), agg('111', 3, 9_000, 'EUR')], BRL)
    const m = r.ad.get('111')!
    expect(m.purchases_internal).toBe(4)
    expect(m.purchase_value_internal).toBe(100)
    expect(r.warnings).toContain('fx_rate_missing:EUR->BRL')
  })

  it('AC-T105-01 applyInternalMetrics preenche purchases_leona, purchase_value_leona(_display) e roas_internal nos 3 níveis', () => {
    const rows = {
      campaign: [row('c1', { spend: 200 })],
      adset: [row('s1', { campaign: 'c1', spend: 200 })],
      ad: [row('111', { campaign: 'c1', adset: 's1', spend: 100 })],
    }
    const r = joinInternalSales(rows, [agg('111', 2, 30_000)], BRL)
    applyInternalMetrics(rows, r)
    expect(rows.ad[0].metrics).toMatchObject({ purchases_leona: 2, purchase_value_leona: 300, purchase_value_leona_display: 300, roas_internal: 3 })
    expect(rows.adset[0].metrics).toMatchObject({ purchases_leona: 2, purchase_value_leona_display: 300, roas_internal: 1.5 })
    expect(rows.campaign[0].metrics).toMatchObject({ purchases_leona: 2, purchase_value_leona_display: 300, roas_internal: 1.5 })
  })
})

describe('T105 — agregados por conjunto e campanha (AC-T105-02)', () => {
  const rows = () => ({
    campaign: [row('c1', { spend: 300 }), row('c2', { spend: 50 }), row('c3', { spend: 10 })],
    adset: [row('s1', { campaign: 'c1', spend: 200 }), row('s2', { campaign: 'c1', spend: 100 }), row('s3', { campaign: 'c2', spend: 50 })],
    ad: [
      row('a1', { campaign: 'c1', adset: 's1', spend: 100 }),
      row('a2', { campaign: 'c1', adset: 's1', spend: 100 }),
      row('a3', { campaign: 'c1', adset: 's2', spend: 100 }),
      row('a4', { campaign: 'c2', adset: 's3', spend: 50 }),
    ],
  })
  // Valores com terço de centavo após conversão (USD 3,33 × 5) para pegar arredondamento divergente.
  const sales = [agg('a1', 2, 10_001), agg('a2', 1, 333, 'USD'), agg('a2', 1, 1), agg('a3', 3, 33_333), agg('a4', 1, 777, 'USD')]

  it('AC-T105-02 conjunto = soma exata dos anúncios com aquele adset_id (quantidade e valor)', () => {
    const r = joinInternalSales(rows(), sales, BRL)
    const ad = (id: string) => r.ad.get(id)!
    const sum = (ids: string[], k: 'purchases_internal' | 'purchase_value_internal') => Math.round(ids.reduce((s, id) => s + ad(id)[k], 0) * 100) / 100
    expect(r.adset.get('s1')!.purchases_internal).toBe(sum(['a1', 'a2'], 'purchases_internal'))
    expect(r.adset.get('s1')!.purchase_value_internal).toBe(sum(['a1', 'a2'], 'purchase_value_internal'))
    expect(r.adset.get('s2')!.purchase_value_internal).toBe(ad('a3').purchase_value_internal)
    expect(r.adset.get('s3')!.purchases_internal).toBe(1)
    // valores concretos: a1 = 100,01; a2 = 16,65 + 0,01 = 16,66
    expect(ad('a1').purchase_value_internal).toBe(100.01)
    expect(ad('a2').purchase_value_internal).toBe(16.66)
    expect(r.adset.get('s1')).toMatchObject({ purchases_internal: 4, purchase_value_internal: 116.67 })
  })

  it('AC-T105-02 campanha = soma exata dos anúncios com aquele campaign_id; campanha sem anúncios = 0', () => {
    const r = joinInternalSales(rows(), sales, BRL)
    const ad = (id: string) => r.ad.get(id)!
    const c1 = ['a1', 'a2', 'a3']
    expect(r.campaign.get('c1')!.purchases_internal).toBe(c1.reduce((s, id) => s + ad(id).purchases_internal, 0))
    expect(r.campaign.get('c1')!.purchase_value_internal).toBe(Math.round(c1.reduce((s, id) => s + ad(id).purchase_value_internal, 0) * 100) / 100)
    expect(r.campaign.get('c1')).toMatchObject({ purchases_internal: 7, purchase_value_internal: 450 })
    // a campanha também bate com a soma dos conjuntos dela
    expect(r.campaign.get('c1')!.purchase_value_internal).toBe(Math.round((r.adset.get('s1')!.purchase_value_internal + r.adset.get('s2')!.purchase_value_internal) * 100) / 100)
    expect(r.campaign.get('c2')).toMatchObject({ purchases_internal: 1, purchase_value_internal: 38.85 })
    expect(r.campaign.get('c3')).toMatchObject({ purchases_internal: 0, purchase_value_internal: 0 })
  })

  it('AC-T105-02 os totais batem com a soma dos anúncios', () => {
    const r = joinInternalSales(rows(), sales, BRL)
    const ads = [...r.ad.values()]
    expect(r.totals.purchases_internal).toBe(ads.reduce((s, m) => s + m.purchases_internal, 0))
    expect(r.totals.purchase_value_internal).toBe(Math.round(ads.reduce((s, m) => s + m.purchase_value_internal, 0) * 100) / 100)
  })
})

describe('T105 — ROAS (AC-T105-03)', () => {
  it('AC-T105-03 roasOf é null com gasto 0, negativo, nulo ou não finito; senão valor ÷ gasto com 2 casas', () => {
    expect(roasOf(100, 0)).toBeNull()
    expect(roasOf(100, -5)).toBeNull()
    expect(roasOf(100, null)).toBeNull()
    expect(roasOf(100, undefined)).toBeNull()
    expect(roasOf(100, Number.NaN)).toBeNull()
    expect(roasOf(0, 0)).toBeNull()
    expect(roasOf(125.5, 150)).toBe(0.84)
    expect(roasOf(0, 50)).toBe(0)
  })

  it('AC-T105-03 nas linhas: gasto 0, negativo ou nulo dá roas_internal null em anúncio, conjunto e campanha', () => {
    const rows = {
      campaign: [row('c0', { spend: 0 }), row('cn', { spend: -1 }), row('cok', { spend: 150 })],
      adset: [row('s0', { campaign: 'c0', spend: 0 }), row('sx', { campaign: 'cn', spend: null }), row('sok', { campaign: 'cok', spend: 150 })],
      ad: [
        row('a0', { campaign: 'c0', adset: 's0', spend: 0 }),
        row('an', { campaign: 'cn', adset: 'sx', spend: -10 }),
        row('ax', { campaign: 'cn', adset: 'sx', spend: null }),
        row('aok', { campaign: 'cok', adset: 'sok', spend: 150 }),
      ],
    }
    const r = joinInternalSales(rows, [agg('a0', 1, 5_000), agg('an', 1, 5_000), agg('ax', 1, 5_000), agg('aok', 1, 12_550)], BRL)
    for (const id of ['a0', 'an', 'ax']) {
      expect(r.ad.get(id)!.roas_internal, id).toBeNull()
      expect(r.ad.get(id)!.purchase_value_internal, id).toBe(50)
    }
    expect(r.adset.get('s0')!.roas_internal).toBeNull()
    expect(r.adset.get('sx')!.roas_internal).toBeNull()
    expect(r.campaign.get('c0')!.roas_internal).toBeNull()
    expect(r.campaign.get('cn')!.roas_internal).toBeNull()
    expect(r.ad.get('aok')!.roas_internal).toBe(0.84)
    expect(r.adset.get('sok')!.roas_internal).toBe(0.84)
    expect(r.campaign.get('cok')!.roas_internal).toBe(0.84)
  })

  it('AC-T105-03 ROAS dos totais é null quando o gasto total é 0', () => {
    const rows = { campaign: [], adset: [], ad: [row('a', { spend: 0 }), row('b', { spend: 0 })] }
    const r = joinInternalSales(rows, [agg('a', 1, 10_000)], BRL)
    expect(r.totals.purchase_value_internal).toBe(100)
    expect(r.totals.roas_internal).toBeNull()
  })
})

describe('T105 — vendas sem source_id (AC-T105-04)', () => {
  it('AC-T105-04 hasSourceId: null, vazio e só espaços contam como ausente', () => {
    expect(hasSourceId(null)).toBe(false)
    expect(hasSourceId(undefined)).toBe(false)
    expect(hasSourceId('')).toBe(false)
    expect(hasSourceId('   ')).toBe(false)
    expect(hasSourceId('\t')).toBe(false)
    expect(hasSourceId('111')).toBe(true)
  })

  it('AC-T105-04 agregados com source_id vazio/espaços não entram em nenhum anúncio, nem num anúncio de id vazio', () => {
    const rows = { campaign: [row('c', { spend: 10 })], adset: [], ad: [row('111', { campaign: 'c' }), row('', { campaign: 'c' }), row('   ', { campaign: 'c' })] }
    const r = joinInternalSales(rows, [agg('', 5, 50_000), agg('   ', 2, 20_000)], BRL)
    for (const m of r.ad.values()) expect(m.purchases_internal).toBe(0)
    expect(r.campaign.get('c')!.purchases_internal).toBe(0)
    expect(r.totals.purchases_internal).toBe(0)
  })
})
