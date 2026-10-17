// Cruzamento vendas internas × anúncios Meta (T105; 11 §3.4, §3.7, §5.5): função pura. A venda entra no anúncio cujo
// `id` é exatamente o `source_id` dela; conjunto e campanha são a SOMA dos anúncios já cruzados (nunca outra consulta).
// Valores em centavos na moeda da venda → convertidos por `FxRate`; venda sem cotação fica fora do valor com aviso
// `fx_rate_missing:<FROM>-><TO>` (padrão da T101). ROAS = valor ÷ gasto (2 casas), null com gasto ≤ 0 ou nulo.
import type { BundleRow } from '../structure/account'
import type { FxRate } from '../structure/metrics'

/** Vendas aprovadas agregadas por (anúncio, moeda), como a consulta devolve. */
export interface InternalSaleAggregate {
  sourceId: string
  currency: string
  count: number
  amountCents: number
}

export interface InternalMetrics {
  purchases_internal: number
  /** Na moeda de exibição. */
  purchase_value_internal: number
  /** Na moeda da conta de anúncio da linha (a moeda de `meta_spend`); sem moeda na conta = exibição. */
  purchase_value_internal_account: number
  /** `purchase_value_internal ÷ meta_spend_display`; null se o gasto for ≤ 0 ou nulo. */
  roas_internal: number | null
}

export interface InternalTotals {
  purchases_internal: number
  purchase_value_internal: number
  /** Soma do gasto (`meta_spend_display`) dos anúncios com gasto convertido. */
  meta_spend_display: number
  /** ROAS ponderado = valor ÷ gasto. */
  roas_internal: number | null
}

export interface JoinRows {
  campaign: readonly BundleRow[]
  adset: readonly BundleRow[]
  ad: readonly BundleRow[]
}

export interface JoinResult {
  ad: Map<string, InternalMetrics>
  adset: Map<string, InternalMetrics>
  campaign: Map<string, InternalMetrics>
  totals: InternalTotals
  /** `fx_rate_missing:<FROM>-><TO>` (sem duplicatas, em ordem). */
  warnings: string[]
}

export interface JoinOptions {
  displayCurrency: string
  fx: FxRate
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** ROAS = valor ÷ gasto, 2 casas; null se o valor for nulo ou o gasto for ≤ 0 / nulo / não finito (AC-T105-03). */
export function roasOf(value: number | null | undefined, spend: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (spend === null || spend === undefined || !Number.isFinite(spend) || spend <= 0) return null
  return round2(value / spend)
}

/** `source_id` utilizável: string não vazia depois de `trim` (vazio / só espaços = ausente, AC-T105-04). */
export function hasSourceId(sourceId: string | null | undefined): sourceId is string {
  return typeof sourceId === 'string' && sourceId.trim() !== ''
}

const spendOf = (row: BundleRow): number | null => {
  const v = row.metrics.meta_spend_display
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Cruza as vendas com as linhas do bundle. Todo anúncio de `rows.ad` ganha métricas (0 sem venda); conjunto e campanha
 * de `rows.adset`/`rows.campaign` recebem a soma dos anúncios com aquele `adset_id`/`campaign_id`.
 */
export function joinInternalSales(
  rows: JoinRows,
  aggregates: readonly InternalSaleAggregate[],
  opts: JoinOptions,
): JoinResult {
  const display = opts.displayCurrency.toUpperCase()
  const warnings = new Set<string>()
  const bySource = new Map<string, InternalSaleAggregate[]>()
  for (const a of aggregates) {
    if (!hasSourceId(a.sourceId)) continue
    const list = bySource.get(a.sourceId) ?? []
    list.push(a)
    bySource.set(a.sourceId, list)
  }

  const rate = (from: string, to: string): number | null => {
    const r = opts.fx(from, to)
    if (r === null || !Number.isFinite(r)) {
      warnings.add(`fx_rate_missing:${from.toUpperCase()}->${to.toUpperCase()}`)
      return null
    }
    return r
  }

  // Valores acumulados em centavos-convertidos (sem arredondar) e arredondados só na saída.
  interface Acc {
    count: number
    value: number
    valueAccount: number
    spend: number | null
  }
  const out = (acc: Acc): InternalMetrics => {
    const value = round2(acc.value)
    return {
      purchases_internal: acc.count,
      purchase_value_internal: value,
      purchase_value_internal_account: round2(acc.valueAccount),
      roas_internal: roasOf(value, acc.spend),
    }
  }

  const adAcc = new Map<string, Acc & { row: BundleRow }>()
  for (const row of rows.ad) {
    const accountCurrency = (row.currency ?? display).toUpperCase()
    const acc = { row, count: 0, value: 0, valueAccount: 0, spend: spendOf(row) }
    for (const s of bySource.get(row.id) ?? []) {
      acc.count += s.count
      const amount = s.amountCents / 100
      const toDisplay = rate(s.currency, display)
      if (toDisplay !== null) acc.value += amount * toDisplay
      const toAccount = rate(s.currency, accountCurrency)
      if (toAccount !== null) acc.valueAccount += amount * toAccount
    }
    adAcc.set(row.id, acc)
  }

  // Conjunto e campanha: soma exata das linhas de anúncio (gasto do ROAS = gasto da própria linha do nível).
  const rollup = (parents: readonly BundleRow[], key: 'adset_id' | 'campaign_id') => {
    const sums = new Map<string, Acc>()
    for (const p of parents) sums.set(p.id, { count: 0, value: 0, valueAccount: 0, spend: spendOf(p) })
    for (const a of adAcc.values()) {
      const parent = a.row[key]
      const s = parent ? sums.get(parent) : undefined
      if (!s) continue
      s.count += a.count
      s.value += round2(a.value)
      s.valueAccount += round2(a.valueAccount)
    }
    return new Map([...sums].map(([id, s]) => [id, out(s)]))
  }

  const ad = new Map([...adAcc].map(([id, a]) => [id, out(a)]))
  const totals = { purchases_internal: 0, purchase_value_internal: 0, meta_spend_display: 0 }
  for (const m of ad.values()) {
    totals.purchases_internal += m.purchases_internal
    totals.purchase_value_internal = round2(totals.purchase_value_internal + m.purchase_value_internal)
  }
  for (const a of adAcc.values())
    if (a.spend !== null) totals.meta_spend_display = round2(totals.meta_spend_display + a.spend)

  return {
    ad,
    adset: rollup(rows.adset, 'adset_id'),
    campaign: rollup(rows.campaign, 'campaign_id'),
    totals: { ...totals, roas_internal: roasOf(totals.purchase_value_internal, totals.meta_spend_display) },
    warnings: [...warnings],
  }
}

/**
 * Grava o resultado nas linhas do bundle (contrato T101/T106): `purchases_leona`, `purchase_value_leona` (moeda da
 * conta), `purchase_value_leona_display` (moeda de exibição) e `roas_internal`. Linha fora do resultado fica como está.
 */
export function applyInternalMetrics(rows: JoinRows, result: JoinResult): void {
  const put = (list: readonly BundleRow[], map: Map<string, InternalMetrics>) => {
    for (const row of list) {
      const m = map.get(row.id)
      if (!m) continue
      row.metrics.purchases_leona = m.purchases_internal
      row.metrics.purchase_value_leona = m.purchase_value_internal_account
      row.metrics.purchase_value_leona_display = m.purchase_value_internal
      row.metrics.roas_internal = m.roas_internal
    }
  }
  put(rows.ad, result.ad)
  put(rows.adset, result.adset)
  put(rows.campaign, result.campaign)
}

/**
 * Revisão 3: vendas com atribuição só `probable` (proximidade de tempo), separadas das confirmadas. Nunca somadas em
 * `purchases_leona`: a UI só as junta ao total com o filtro explícito ligado, e com legenda.
 */
export function applyProbableMetrics(rows: JoinRows, result: JoinResult): void {
  const put = (list: readonly BundleRow[], map: Map<string, InternalMetrics>) => {
    for (const row of list) {
      const m = map.get(row.id)
      if (!m) continue
      row.metrics.purchases_leona_probable = m.purchases_internal
      row.metrics.purchase_value_leona_probable = m.purchase_value_internal_account
      row.metrics.purchase_value_leona_probable_display = m.purchase_value_internal
    }
  }
  put(rows.ad, result.ad)
  put(rows.adset, result.adset)
  put(rows.campaign, result.campaign)
}
