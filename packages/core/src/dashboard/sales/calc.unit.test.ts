import { describe, expect, it } from 'vitest'
import { computeMilestone, milestones } from '../milestones/index'
import { addDays, computeExpenses, computeKpis, daysInclusive, eachDay, isValidDate, previousRange, todayIn, trendOf, type ExpenseRuleLike } from './calc'

describe('datas', () => {
  it('dias inclusivos, soma de dias, validação e hoje no fuso', () => {
    expect(daysInclusive('2026-06-01', '2026-06-30')).toBe(30)
    expect(daysInclusive('2026-06-02', '2026-06-01')).toBe(0)
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(eachDay('2026-06-29', '2026-07-01')).toEqual(['2026-06-29', '2026-06-30', '2026-07-01'])
    expect(isValidDate('2026-02-30')).toBe(false)
    expect(isValidDate('2026-02-28')).toBe(true)
    expect(todayIn('America/Sao_Paulo', new Date('2026-06-02T02:30:00Z'))).toBe('2026-06-01')
  })

  it('AC-T55-02 período anterior: mesma duração terminando no dia anterior ao início', () => {
    expect(previousRange('2026-06-01', '2026-06-30')).toEqual({ start_date: '2026-05-02', end_date: '2026-05-31' })
    expect(previousRange('2026-06-10', '2026-06-10')).toEqual({ start_date: '2026-06-09', end_date: '2026-06-09' })
  })

  it('AC-T55-02 tendência neutra com anterior 0/nulo ou |Δ| < 0,05%', () => {
    expect(trendOf(100, 0)).toEqual({ direction: 'neutral', delta_pct: null })
    expect(trendOf(100, null)).toEqual({ direction: 'neutral', delta_pct: null })
    expect(trendOf(100_040, 100_000).direction).toBe('neutral')
    expect(trendOf(100_050, 100_000).direction).toBe('up')
    expect(trendOf(50, 100)).toEqual({ direction: 'down', delta_pct: -50 })
  })
})

describe('KPIs e despesas', () => {
  const rule = (o: Partial<ExpenseRuleLike>): ExpenseRuleLike => ({
    id: 'r',
    name: 'R',
    kind: 'fixed',
    amount_cents: null,
    percent: null,
    percent_base: null,
    period: 'month',
    active_from: null,
    active_to: null,
    ...o,
  })

  it('fixa rateada por período e vigência; percentual por base; regra fora da vigência some', () => {
    const range = { start: '2026-06-01', end: '2026-06-30' }
    const totals = { revenue_cents: 60_000, spend_cents: 20_000 }
    const r = computeExpenses(
      [
        rule({ id: 'm', amount_cents: 30_000 }),
        rule({ id: 'w', amount_cents: 7_000, period: 'week' }),
        rule({ id: 'd', amount_cents: 100, period: 'day', active_from: '2026-06-21' }),
        rule({ id: 'p', kind: 'percent', percent: 10, percent_base: 'revenue' }),
        rule({ id: 's', kind: 'percent', percent: 5, percent_base: 'spend', active_to: '2026-06-15' }),
        rule({ id: 'x', kind: 'percent', percent: 50, percent_base: 'profit_pre' }),
        rule({ id: 'old', amount_cents: 99_999, active_to: '2026-05-31' }),
      ],
      range,
      totals,
    )
    expect(Object.fromEntries(r.lines.map((l) => [l.rule_id, l.value_cents]))).toEqual({ m: 30_000, w: 30_000, d: 1_000, p: 6_000, s: 500, x: 20_000 })
    expect(r.total_cents).toBe(87_500)
    expect(computeExpenses([rule({ kind: 'percent', percent: 10, percent_base: 'profit_pre' })], range, { revenue_cents: 10, spend_cents: 100 }).total_cents).toBe(0)
  })

  it('AC-T55-06 fórmulas fechadas; ROAS/ticket/conversão nulos sem denominador', () => {
    expect(computeKpis({ new_leads: 2, sales_count: 3, revenue_cents: 60_000, spend_cents: 20_000, expenses_cents: 36_000 })).toEqual({
      new_leads: 2,
      sales_count: 3,
      revenue_cents: 60_000,
      avg_ticket_cents: 20_000,
      conversion_rate: 1.5,
      spend_cents: 20_000,
      roas: 3,
      profit_pre_fees_cents: 40_000,
      expenses_cents: 36_000,
      profit_cents: 4_000,
    })
    expect(computeKpis({ new_leads: 0, sales_count: 0, revenue_cents: 0, spend_cents: 0, expenses_cents: 0 })).toMatchObject({ avg_ticket_cents: null, conversion_rate: null, roas: null })
  })
})

describe('AC-T55-05 computeMilestone', () => {
  it('sem selo abaixo de R$ 50 mil, progresso relativo a 0', () => {
    expect(computeMilestone(2_500_000)).toMatchObject({ level: 0, current: null, next: { name: 'Primeira Marca' }, progress_pct: 50, remaining_cents: 2_500_000, max_reached: false })
  })

  it('75 mil → Primeira Marca com 50% até Tração; limiar exato sobe de nível', () => {
    expect(computeMilestone(7_500_000)).toMatchObject({ level: 1, current: { name: 'Primeira Marca' }, next: { name: 'Tração' }, progress_pct: 50 })
    expect(computeMilestone(10_000_000)).toMatchObject({ level: 2, current: { key: 'traction' }, progress_pct: 0 })
  })

  it('≥ 2 milhões → Referência no Mercado e nível máximo; i18n', () => {
    expect(computeMilestone(250_000_000)).toMatchObject({ level: 6, current: { name: 'Referência no Mercado' }, next: null, progress_pct: 100, remaining_cents: 0, max_reached: true })
    expect(computeMilestone(7_500_000, 'en-US').current?.name).toBe('First Mark')
    expect(computeMilestone(7_500_000, 'es-ES').next?.name).toBe('Tracción')
  })

  it('os 6 níveis com limiares da referência e nomes próprios (lista fechada)', () => {
    expect(milestones().map((m) => [m.name, m.min_cents])).toEqual([
      ['Primeira Marca', 5_000_000],
      ['Tração', 10_000_000],
      ['Escala', 25_000_000],
      ['Expansão', 50_000_000],
      ['Clube do Milhão', 100_000_000],
      ['Referência no Mercado', 200_000_000],
    ])
    expect(milestones('en-US').map((m) => m.name)).toEqual(['First Mark', 'Traction', 'Scale', 'Expansion', 'Million Club', 'Market Reference'])
  })
})
