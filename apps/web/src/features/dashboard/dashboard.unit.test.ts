import { describe, expect, it } from 'vitest'
import { milestoneLocale } from './api'
import { formatKpi, formatMoney, formatRate, formatRoas, timeIn, trendView } from './format'
import { addDays, cleanSearch, customProblem, dashboardQueryOf, dashboardSearchSchema, displayName, greetingKey, hourIn, periodOf, rangeDays, tabOf, todayIn } from './search'
import { dashboardTab, registerDashboardTab } from './tabs'

// 2026-03-10 02:30 UTC = 2026-03-09 23:30 em São Paulo (UTC\u22123).
const NOW = new Date('2026-03-10T02:30:00Z')
const SP = 'America/Sao_Paulo'

describe('período no fuso da empresa (AC-T78-01)', () => {
  it('hoje e a hora são os do fuso, não os do navegador/UTC', () => {
    expect(todayIn(SP, NOW)).toBe('2026-03-09')
    expect(todayIn('UTC', NOW)).toBe('2026-03-10')
    expect(hourIn(SP, NOW)).toBe(23)
  })

  it('presets: 7 dias = hoje\u22126..hoje, 30 dias, este mês, ontem', () => {
    expect(periodOf({}, SP, NOW)).toEqual({ start_date: '2026-03-09', end_date: '2026-03-09' })
    expect(periodOf({ preset: 'yesterday' }, SP, NOW)).toEqual({ start_date: '2026-03-08', end_date: '2026-03-08' })
    expect(periodOf({ preset: '7d' }, SP, NOW)).toEqual({ start_date: '2026-03-03', end_date: '2026-03-09' })
    expect(periodOf({ preset: '30d' }, SP, NOW)).toEqual({ start_date: '2026-02-08', end_date: '2026-03-09' })
    expect(periodOf({ preset: 'month' }, SP, NOW)).toEqual({ start_date: '2026-03-01', end_date: '2026-03-09' })
    expect(rangeDays('2026-03-03', '2026-03-09')).toBe(7)
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('personalizado: valida ordem e 366 dias; inválido cai em hoje', () => {
    expect(customProblem('2026-01-01', '2026-01-31')).toBeNull()
    expect(customProblem('2026-02-01', '2026-01-01')).toBe('inverted')
    expect(customProblem('2025-01-01', '2026-01-02')).toBe('too_long')
    expect(customProblem('2025-01-01', '2026-01-01')).toBeNull()
    expect(customProblem(undefined, '2026-01-01')).toBe('incomplete')
    expect(periodOf({ preset: 'custom', start_date: '2026-01-05', end_date: '2026-01-10' }, SP, NOW)).toEqual({ start_date: '2026-01-05', end_date: '2026-01-10' })
    expect(periodOf({ preset: 'custom', start_date: '2026-02-05', end_date: '2026-01-10' }, SP, NOW).start_date).toBe('2026-03-09')
  })

  it('URL: valida, limpa e vira a query da T55 (ids por vírgula)', () => {
    const s = dashboardSearchSchema.parse({ preset: '7d', connection_ids: ['c1', 'c1', 'c2'], product_ids: ['p1'], tab: 'lixo', start_date: 'x' })
    expect(s.tab).toBeUndefined()
    expect(dashboardQueryOf(s, SP, NOW)).toEqual({ start_date: '2026-03-03', end_date: '2026-03-09', connection_ids: 'c1,c2', product_ids: 'p1' })
    expect(cleanSearch({ preset: 'today', connection_ids: [], start_date: '2026-01-01' })).toEqual({})
    expect(cleanSearch({ preset: 'custom', start_date: '2026-01-01', end_date: '2026-01-02', group: 'g' })).toEqual({ preset: 'custom', start_date: '2026-01-01', end_date: '2026-01-02', group: 'g' })
  })
})

describe('KPIs (AC-T78-02)', () => {
  it('formatos: centavos, fração, ROAS com 2 casas, nulos', () => {
    expect(formatMoney(123456)).toBe('R$ 1.234,56')
    expect(formatMoney(-5000)).toBe('-R$ 50,00')
    expect(formatRate(0.25)).toBe('25,0%')
    expect(formatRate(null)).toBe('—')
    expect(formatRoas(2.5)).toBe('2,50')
    expect(formatKpi('sales_count', 1200)).toBe('1.200')
    expect(formatKpi('roas', null)).toBe('—')
  })

  it('tendência verde/vermelha, invertida em gasto e despesas; neutra sem anterior', () => {
    expect(trendView('revenue', { direction: 'up', delta_pct: 12.5 })).toEqual({ direction: 'up', good: true, label: '+12,5%' })
    expect(trendView('revenue', { direction: 'down', delta_pct: -3 })).toEqual({ direction: 'down', good: false, label: '\u22123,0%' })
    expect(trendView('spend', { direction: 'up', delta_pct: 10 }).good).toBe(false)
    expect(trendView('expenses', { direction: 'down', delta_pct: -10 }).good).toBe(true)
    expect(trendView('profit', { direction: 'neutral', delta_pct: null })).toEqual({ direction: 'neutral', good: null, label: '—' })
    expect(trendView('profit', undefined).direction).toBe('neutral')
  })

  it('"Última atualização" na hora da empresa', () => {
    expect(timeIn('2026-03-10T02:30:00Z', SP)).toBe('23:30')
  })
})

describe('saudação, abas e marcos (AC-T78-04)', () => {
  it('bom dia < 12h, boa tarde < 18h, boa noite', () => {
    expect(greetingKey(0)).toBe('morning')
    expect(greetingKey(11)).toBe('morning')
    expect(greetingKey(12)).toBe('afternoon')
    expect(greetingKey(17)).toBe('afternoon')
    expect(greetingKey(18)).toBe('evening')
    expect(displayName({ name: 'Olivia Owner' })).toBe('Olivia')
    expect(displayName({ name: ' ', email: 'ana.lima@x.com' })).toBe('ana.lima')
  })

  it('sem dashboard.sales a aba é sempre Atendimento', () => {
    expect(tabOf({}, true)).toBe('sales')
    expect(tabOf({ tab: 'attendance' }, true)).toBe('attendance')
    expect(tabOf({ tab: 'sales' }, false)).toBe('attendance')
  })

  it('locale dos marcos e slot da aba de atendimento', () => {
    expect(milestoneLocale('pt-BR')).toBe('pt-BR')
    expect(milestoneLocale('en')).toBe('en-US')
    expect(milestoneLocale('es')).toBe('es-ES')
    const Panel = () => null
    expect(dashboardTab('attendance')).toBeNull()
    const off = registerDashboardTab('attendance', Panel)
    expect(dashboardTab('attendance')).toBe(Panel)
    off()
    expect(dashboardTab('attendance')).toBeNull()
  })
})
