// Métricas e parâmetros do bundle (T101): `actions[]` por `action_type` (array embaralhado), conversão de moeda,
// períodos no fuso da empresa e chave de cache.
import { describe, expect, it } from 'vitest'
import { actionValue, convert, fixedFxRates, metricsFromInsight, PURCHASE_ACTION_TYPES } from './metrics'
import { bundleKey, BundleParamsError, normalizeBundleParams, presetRange } from './params'
import { usagePct } from './account'

describe('metricsFromInsight (AC-T101-01)', () => {
  it('mapeia actions[] por action_type independentemente da ordem e calcula CPA/CPL', () => {
    const shuffled = {
      spend: '120.50',
      impressions: '10000',
      actions: [
        { action_type: 'video_view', value: '900' },
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '12' },
        { action_type: 'link_click', value: '340' },
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '4' },
        { action_type: 'post_engagement', value: '77' },
      ],
      action_values: [
        { action_type: 'post_engagement', value: '1' },
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '899.90' },
      ],
    }
    const m = metricsFromInsight(shuffled)
    expect(m).toEqual({
      meta_spend: 120.5,
      purchase_value_meta: 899.9,
      purchases_pixel: 4,
      conversations_meta: 12,
      meta_link_clicks: 340,
      meta_impressions: 10000,
      cost_per_purchase_meta: 30.13,
      cost_per_lead_meta: 10.04,
      purchase_value_leona: null,
      purchases_leona: null,
    })
    // Mesmo resultado com a ordem invertida.
    expect(metricsFromInsight({ ...shuffled, actions: [...shuffled.actions].reverse(), action_values: [...shuffled.action_values].reverse() })).toEqual(m)
  })

  it('compras: usa o primeiro tipo presente na ordem de prioridade (sem somar tipos sobrepostos)', () => {
    const actions = [
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
      { action_type: 'omni_purchase', value: '5' },
      { action_type: 'purchase', value: '4' },
    ]
    expect(PURCHASE_ACTION_TYPES[0]).toBe('omni_purchase')
    expect(actionValue(actions, PURCHASE_ACTION_TYPES)).toBe(5)
    expect(metricsFromInsight(undefined)).toMatchObject({ meta_spend: 0, purchases_pixel: null, cost_per_purchase_meta: null })
    expect(metricsFromInsight({ spend: '10', inline_link_clicks: '7' }).meta_link_clicks).toBe(7)
  })

  it('cotação fixa: direta, inversa, mesma moeda e ausente', () => {
    const fx = fixedFxRates({ 'USD:BRL': 5 })
    expect(fx('USD', 'BRL')).toBe(5)
    expect(fx('BRL', 'USD')).toBe(0.2)
    expect(fx('EUR', 'EUR')).toBe(1)
    expect(fx('EUR', 'BRL')).toBeNull()
    expect(convert(10.555, 5)).toBe(52.78)
    expect(convert(10, null)).toBeNull()
  })
})

describe('parâmetros e período', () => {
  const now = new Date('2026-10-16T02:00:00Z') // 15/10 23:00 em São Paulo
  it('presets no fuso da empresa', () => {
    expect(presetRange('today', now, 'America/Sao_Paulo')).toEqual({ since: '2026-10-15', until: '2026-10-15' })
    expect(presetRange('today', now, 'UTC')).toEqual({ since: '2026-10-16', until: '2026-10-16' })
    expect(presetRange('yesterday', now, 'America/Sao_Paulo')).toEqual({ since: '2026-10-14', until: '2026-10-14' })
    expect(presetRange('7d', now, 'America/Sao_Paulo')).toEqual({ since: '2026-10-09', until: '2026-10-15' })
    expect(presetRange('30d', now, 'America/Sao_Paulo')).toEqual({ since: '2026-09-16', until: '2026-10-15' })
    expect(presetRange('month', now, 'America/Sao_Paulo')).toEqual({ since: '2026-10-01', until: '2026-10-15' })
  })

  it('normaliza e valida; custom exige datas; chave ignora ordem das contas e o nível', () => {
    const ctx = { now, timeZone: 'America/Sao_Paulo', defaultCurrency: 'BRL' }
    const p = normalizeBundleParams({ level: 'ad', ad_account_ids: ['b', 'a', 'b'], display_currency: 'usd' }, ctx)
    expect(p).toMatchObject({ level: 'ad', statusFilter: 'active', datePreset: 'today', adAccountIds: ['a', 'b'], displayCurrency: 'USD' })
    expect(normalizeBundleParams({ since: '2026-10-01', until: '2026-10-05' }, ctx)).toMatchObject({ datePreset: 'custom', since: '2026-10-01', until: '2026-10-05' })
    for (const bad of [{ level: 'x' }, { status_filter: 'paused' }, { date_preset: 'custom' }, { since: '2026-10-05', until: '2026-10-01' }, { display_currency: 'REAL' }])
      expect(() => normalizeBundleParams(bad, ctx)).toThrow(BundleParamsError)
    const base = { statusFilter: 'all' as const, since: '2026-10-01', until: '2026-10-05', displayCurrency: 'BRL' }
    expect(bundleKey('c', base, ['b', 'a'])).toBe(bundleKey('c', base, ['a', 'b']))
    expect(bundleKey('c', base, ['a'])).not.toBe(bundleKey('c', { ...base, displayCurrency: 'USD' }, ['a']))
  })

  it('uso da Meta: maior porcentagem dos headers e espera estimada', () => {
    const header = JSON.stringify({ biz: [{ call_count: 30, total_cputime: 80, total_time: 10, estimated_time_to_regain_access: 7 }] })
    expect(usagePct({ business: header, adAccount: null })).toEqual({ pct: 80, waitMs: 7 * 60_000 })
    expect(usagePct({ business: '{}', adAccount: JSON.stringify({ acc_id_util_pct: 91 }) }).pct).toBe(91)
    expect(usagePct({ business: 'lixo', adAccount: null })).toEqual({ pct: 0, waitMs: 5 * 60_000 })
  })
})
