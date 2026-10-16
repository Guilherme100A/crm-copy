// Estatísticas do funil (04-kanban-crm.md §3.6, reproduzindo o cálculo do front `yAt`). Entrada: totais por coluna
// (já com os filtros). `count` de cada etapa é ACUMULADO (esta etapa + todas as posteriores: modelo de funil).

export interface ColumnTotal {
  column_id: string
  name: string
  position: number
  conversion_goal: boolean
  total_count: number
  total_value_cents: number
}

export interface FunnelStage {
  column_id: string
  name: string
  position: number
  /** Cards só desta coluna. */
  column_count: number
  /** Acumulado (esta + posteriores). */
  count: number
  /** count / count da etapa anterior × 100 (1 casa); `null` na primeira. */
  conversion_rate_from_previous: number | null
  /** count / total × 100 (1 casa). */
  wave_progress_percent: number
  total_value_cents: number
  total_value: number
}

export interface FunnelStats {
  total_cards: number
  stages: FunnelStage[]
  conversion_count: number
  conversion_rate: number
  totals: { total_leads: number; overall_conversion_rate: number; total_purchases: number; total_revenue_cents: number; total_revenue: number }
}

const round = (v: number, places: number) => {
  const f = 10 ** places
  return Math.round(v * f) / f
}
const pct = (num: number, den: number, places: number) => (den > 0 ? round((num / den) * 100, places) : 0)
export const centsToValue = (cents: number) => round(cents / 100, 2)

export function funnelStats(columns: readonly ColumnTotal[]): FunnelStats {
  const ordered = [...columns].sort((a, b) => a.position - b.position)
  const total = ordered.reduce((s, c) => s + c.total_count, 0)
  const stages: FunnelStage[] = []
  let after = total
  let previous: number | null = null
  for (const c of ordered) {
    const count = after
    after -= c.total_count
    stages.push({
      column_id: c.column_id,
      name: c.name,
      position: c.position,
      column_count: c.total_count,
      count,
      conversion_rate_from_previous: previous === null ? null : pct(count, previous, 1),
      wave_progress_percent: pct(count, total, 1),
      total_value_cents: c.total_value_cents,
      total_value: centsToValue(c.total_value_cents),
    })
    previous = count
  }
  const conversion = ordered.filter((c) => c.conversion_goal)
  const conversionCount = conversion.reduce((s, c) => s + c.total_count, 0)
  const revenueCents = conversion.reduce((s, c) => s + c.total_value_cents, 0)
  const rate = pct(conversionCount, total, 2)
  return {
    total_cards: total,
    stages,
    conversion_count: conversionCount,
    conversion_rate: rate,
    totals: {
      total_leads: total,
      overall_conversion_rate: rate,
      total_purchases: conversionCount,
      total_revenue_cents: revenueCents,
      total_revenue: centsToValue(revenueCents),
    },
  }
}
