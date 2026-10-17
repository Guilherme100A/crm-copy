// Cruzamento puro vendas × anúncios (T105): linhas do bundle montadas à mão, sem banco nem Graph.
import { describe, expect, it } from 'vitest'
import type { BundleRow } from '../structure/account'
import { emptyMetrics, fixedFxRates } from '../structure/metrics'
import {
  applyInternalMetrics,
  hasSourceId,
  joinInternalSales,
  roasOf,
  type InternalSaleAggregate,
  type JoinRows,
} from './join'

const row = (
  id: string,
  o: { campaign_id?: string; adset_id?: string; spend?: number | null; currency?: string | null } = {},
): BundleRow => ({
  id,
  name: id,
  status: 'ACTIVE',
  ...(o.campaign_id ? { campaign_id: o.campaign_id } : {}),
  ...(o.adset_id ? { adset_id: o.adset_id } : {}),
  ad_account_id: 'local-1',
  fb_ad_account_id: 'act_1',
  ad_account_label: 'Conta',
  currency: o.currency === undefined ? 'BRL' : o.currency,
  daily_budget: null,
  lifetime_budget: null,
  daily_budget_display: null,
  lifetime_budget_display: null,
  metrics: { ...emptyMetrics(), meta_spend: o.spend ?? 0, meta_spend_display: o.spend === undefined ? 0 : o.spend },
})

/** 1 campanha → 2 conjuntos → 3 anúncios (+ campanha 2 sem anúncios). */
function rows(given: Partial<Record<string, number | null>> = {}): JoinRows {
  const spend = (id: string, d: number) => (id in given ? (given[id] ?? null) : d)
  return {
    campaign: [row('c1', { spend: spend('c1', 300) }), row('c2', { spend: spend('c2', 0) })],
    adset: [
      row('s1', { campaign_id: 'c1', spend: spend('s1', 200) }),
      row('s2', { campaign_id: 'c1', spend: spend('s2', 100) }),
    ],
    ad: [
      row('111', { campaign_id: 'c1', adset_id: 's1', spend: spend('111', 150) }),
      row('222', { campaign_id: 'c1', adset_id: 's1', spend: spend('222', 50) }),
      row('333', { campaign_id: 'c1', adset_id: 's2', spend: spend('333', 100) }),
    ],
  }
}
const agg = (sourceId: string, amountCents: number, count = 1, currency = 'BRL'): InternalSaleAggregate => ({
  sourceId,
  currency,
  count,
  amountCents,
})
const brl = { displayCurrency: 'BRL', fx: fixedFxRates({ 'USD:BRL': 5 }) }

describe('joinInternalSales', () => {
  it('AC-T105-01: soma por anúncio as vendas cujo source_id é o id do anúncio (anúncio sem venda = 0)', () => {
    const r = joinInternalSales(rows(), [agg('111', 10_000, 2), agg('111', 2_550, 1), agg('333', 4_000, 1)], brl)
    expect(r.ad.get('111')).toEqual({
      purchases_internal: 3,
      purchase_value_internal: 125.5,
      purchase_value_internal_account: 125.5,
      roas_internal: 0.84,
    })
    expect(r.ad.get('222')).toEqual({
      purchases_internal: 0,
      purchase_value_internal: 0,
      purchase_value_internal_account: 0,
      roas_internal: 0,
    })
    expect(r.ad.get('333')).toMatchObject({ purchases_internal: 1, purchase_value_internal: 40, roas_internal: 0.4 })
    expect(r.warnings).toEqual([])
  })

  it('AC-T105-01: id comparado exatamente (string numérica; sem prefixo nem espaços)', () => {
    const r = joinInternalSales(
      rows(),
      [agg(' 111', 1_000), agg('0111', 1_000), agg('111 ', 1_000), agg('11', 1_000)],
      brl,
    )
    for (const m of r.ad.values()) expect(m.purchases_internal).toBe(0)
  })

  it('AC-T105-02: conjunto e campanha = soma exata dos anúncios', () => {
    const r = joinInternalSales(rows(), [agg('111', 3_333, 1), agg('222', 3_333, 2), agg('333', 3_334, 1, 'USD')], brl)
    const ads = [...r.ad.values()]
    const s1 = r.adset.get('s1')!
    expect(s1.purchases_internal).toBe(r.ad.get('111')!.purchases_internal + r.ad.get('222')!.purchases_internal)
    expect(s1.purchase_value_internal).toBe(66.66)
    expect(r.adset.get('s2')).toMatchObject({ purchases_internal: 1, purchase_value_internal: 166.7 })
    const c1 = r.campaign.get('c1')!
    expect(c1.purchases_internal).toBe(ads.reduce((s, m) => s + m.purchases_internal, 0))
    expect(c1.purchase_value_internal).toBe(
      Math.round(ads.reduce((s, m) => s + m.purchase_value_internal, 0) * 100) / 100,
    )
    expect(c1).toMatchObject({ purchases_internal: 4, purchase_value_internal: 233.36, roas_internal: 0.78 })
    // Campanha sem anúncios cruzados: 0 (não null).
    expect(r.campaign.get('c2')).toEqual({
      purchases_internal: 0,
      purchase_value_internal: 0,
      purchase_value_internal_account: 0,
      roas_internal: null,
    })
    expect(r.totals).toEqual({
      purchases_internal: 4,
      purchase_value_internal: 233.36,
      meta_spend_display: 300,
      roas_internal: 0.78,
    })
  })

  it('AC-T105-03: ROAS nulo com gasto ≤ 0 ou nulo; 2 casas com gasto positivo', () => {
    const r = joinInternalSales(
      rows({ '111': 0, '222': -5, '333': null }),
      [agg('111', 10_000), agg('222', 10_000), agg('333', 10_000)],
      brl,
    )
    expect(r.ad.get('111')!.roas_internal).toBeNull()
    expect(r.ad.get('222')!.roas_internal).toBeNull()
    expect(r.ad.get('333')!.roas_internal).toBeNull()
    expect(r.ad.get('111')!.purchase_value_internal).toBe(100)
    expect(r.totals.roas_internal).toBeNull()
    expect(roasOf(100, 0)).toBeNull()
    expect(roasOf(100, -1)).toBeNull()
    expect(roasOf(100, null)).toBeNull()
    expect(roasOf(null, 10)).toBeNull()
    expect(roasOf(100, 3)).toBe(33.33)
  })

  it('AC-T105-04: venda sem source_id (null, vazio, espaços) não entra em nenhum anúncio', () => {
    const r = joinInternalSales(
      rows(),
      [
        agg('', 5_000),
        agg('   ', 5_000),
        { sourceId: null as unknown as string, currency: 'BRL', count: 1, amountCents: 5_000 },
      ],
      brl,
    )
    for (const m of [...r.ad.values(), ...r.adset.values(), ...r.campaign.values()])
      expect(m.purchases_internal).toBe(0)
    expect(r.totals.purchases_internal).toBe(0)
    expect(hasSourceId('')).toBe(false)
    expect(hasSourceId('  ')).toBe(false)
    expect(hasSourceId(null)).toBe(false)
    expect(hasSourceId('123')).toBe(true)
  })

  it('converte pela FxRate e avisa a cotação que falta (sem somar em silêncio)', () => {
    const r = joinInternalSales(
      rows(),
      [agg('111', 1_000, 1, 'USD'), agg('111', 1_000, 1, 'EUR'), agg('111', 500, 1, 'BRL')],
      brl,
    )
    expect(r.ad.get('111')).toMatchObject({ purchases_internal: 3, purchase_value_internal: 55 })
    expect(r.warnings).toEqual(['fx_rate_missing:EUR->BRL'])
  })

  it('valor na moeda da conta para purchase_value_leona (conta USD, exibição BRL)', () => {
    const rs = rows()
    for (const list of [rs.ad, rs.adset, rs.campaign])
      for (const x of list) (x as { currency: string }).currency = 'USD'
    const r = joinInternalSales(rs, [agg('111', 5_000, 1, 'BRL'), agg('111', 1_000, 1, 'USD')], brl)
    expect(r.ad.get('111')).toMatchObject({ purchase_value_internal: 100, purchase_value_internal_account: 20 })
  })

  it('applyInternalMetrics preenche as chaves _leona e roas_internal das linhas', () => {
    const rs = rows()
    applyInternalMetrics(rs, joinInternalSales(rs, [agg('111', 15_000, 2)], brl))
    expect(rs.ad[0]!.metrics).toMatchObject({
      purchases_leona: 2,
      purchase_value_leona: 150,
      purchase_value_leona_display: 150,
      roas_internal: 1,
    })
    expect(rs.ad[1]!.metrics).toMatchObject({ purchases_leona: 0, purchase_value_leona: 0, roas_internal: 0 })
    expect(rs.adset[0]!.metrics).toMatchObject({
      purchases_leona: 2,
      purchase_value_leona_display: 150,
      roas_internal: 0.75,
    })
    expect(rs.campaign[0]!.metrics).toMatchObject({
      purchases_leona: 2,
      purchase_value_leona_display: 150,
      roas_internal: 0.5,
    })
  })
})
