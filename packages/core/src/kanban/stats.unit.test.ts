import { describe, expect, it } from 'vitest'
import { centsToValue, funnelStats, type ColumnTotal } from './stats'

const col = (id: string, position: number, total_count: number, total_value_cents: number, conversion_goal = false): ColumnTotal => ({
  column_id: id,
  name: id,
  position,
  conversion_goal,
  total_count,
  total_value_cents,
})

describe('funil (04 §3.6)', () => {
  it('fixture: 10/6/4 cards, Ganho de conversão', () => {
    // Fora de ordem de propósito: o cálculo ordena por posição.
    const s = funnelStats([col('ganho', 2, 4, 40_000, true), col('novo', 0, 10, 1_000), col('qualif', 1, 6, 30_050)])
    expect(s.total_cards).toBe(20)
    expect(s.stages.map((st) => [st.column_id, st.column_count, st.count, st.conversion_rate_from_previous, st.wave_progress_percent])).toEqual([
      ['novo', 10, 20, null, 100],
      ['qualif', 6, 10, 50, 50],
      ['ganho', 4, 4, 40, 20],
    ])
    expect(s.stages[1]!.total_value).toBe(300.5)
    expect(s.conversion_count).toBe(4)
    expect(s.conversion_rate).toBe(20)
    expect(s.totals).toEqual({ total_leads: 20, overall_conversion_rate: 20, total_purchases: 4, total_revenue_cents: 40_000, total_revenue: 400 })
  })

  it('arredondamento: 1 casa por etapa, 2 casas na conversão geral', () => {
    const s = funnelStats([col('a', 0, 2, 0), col('b', 1, 1, 0, true)])
    expect(s.stages[1]!.conversion_rate_from_previous).toBe(33.3)
    expect(s.stages[1]!.wave_progress_percent).toBe(33.3)
    expect(s.conversion_rate).toBe(33.33)
  })

  it('quadro vazio não divide por zero', () => {
    const s = funnelStats([col('a', 0, 0, 0), col('b', 1, 0, 0, true)])
    expect(s.stages.map((st) => [st.count, st.conversion_rate_from_previous, st.wave_progress_percent])).toEqual([
      [0, null, 0],
      [0, 0, 0],
    ])
    expect([s.total_cards, s.conversion_rate]).toEqual([0, 0])
  })

  it('centavos → reais', () => {
    expect(centsToValue(12_345)).toBe(123.45)
    expect(centsToValue(0)).toBe(0)
  })
})
