// Métricas de uma linha do Gerenciador (T101; 11 §3.4): mapeia `actions[]`/`action_values[]` da Graph por
// `action_type` (nunca por posição — STACK E §1.4), calcula custos e converte valores para a moeda de exibição.

export interface GraphAction {
  action_type: string
  value: string | number
}

/** Linha de insights da Graph (`/act_x/insights?level=…`). Valores numéricos chegam como string. */
export interface GraphInsightRow {
  campaign_id?: string
  adset_id?: string
  ad_id?: string
  spend?: string | number
  impressions?: string | number
  inline_link_clicks?: string | number
  actions?: GraphAction[]
  action_values?: GraphAction[]
}

export interface MetaRowMetrics {
  meta_spend: number
  purchase_value_meta: number | null
  purchases_pixel: number | null
  conversations_meta: number | null
  meta_link_clicks: number | null
  meta_impressions: number | null
  cost_per_purchase_meta: number | null
  cost_per_lead_meta: number | null
  /** Vendas internas com `source_id` = id do anúncio (T105); null enquanto não houver. */
  purchase_value_leona: number | null
  purchases_leona: number | null
  /** T105: ROAS das vendas internas (`purchase_value_leona_display ÷ meta_spend_display`); só com `internalSales`. */
  roas_internal?: number | null
  /**
   * Revisão 3: vendas com atribuição só provável (proximidade de tempo), SEPARADAS de `purchases_leona` (que conta só as
   * confirmadas). A tela só as soma com o filtro explícito ligado.
   */
  purchases_leona_probable?: number | null
  purchase_value_leona_probable?: number | null
  purchase_value_leona_probable_display?: number | null
}

/** Compras: a primeira presente, nesta ordem (os tipos se sobrepõem; somar contaria duas vezes). */
export const PURCHASE_ACTION_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'] as const
export const CONVERSATION_ACTION_TYPE = 'onsite_conversion.messaging_conversation_started_7d'
export const LINK_CLICK_ACTION_TYPE = 'link_click'

/** Campos monetários (recebem `<campo>_display` na moeda de exibição). */
export const MONEY_METRICS = ['meta_spend', 'purchase_value_meta', 'cost_per_purchase_meta', 'cost_per_lead_meta', 'purchase_value_leona'] as const

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const round2 = (n: number) => Math.round(n * 100) / 100

/** Valor de um `action_type` (o primeiro que existir da lista). */
export function actionValue(list: readonly GraphAction[] | undefined, types: readonly string[]): number | null {
  if (!list?.length) return null
  for (const t of types) {
    const hit = list.find((a) => a?.action_type === t)
    if (hit) return num(hit.value)
  }
  return null
}

export function emptyMetrics(): MetaRowMetrics {
  return {
    meta_spend: 0,
    purchase_value_meta: null,
    purchases_pixel: null,
    conversations_meta: null,
    meta_link_clicks: null,
    meta_impressions: null,
    cost_per_purchase_meta: null,
    cost_per_lead_meta: null,
    purchase_value_leona: null,
    purchases_leona: null,
  }
}

/** Métricas de uma linha de insights. */
export function metricsFromInsight(row: GraphInsightRow | undefined): MetaRowMetrics {
  if (!row) return emptyMetrics()
  const spend = num(row.spend) ?? 0
  const purchases = actionValue(row.actions, PURCHASE_ACTION_TYPES)
  const conversations = actionValue(row.actions, [CONVERSATION_ACTION_TYPE])
  const clicks = actionValue(row.actions, [LINK_CLICK_ACTION_TYPE]) ?? num(row.inline_link_clicks)
  return {
    meta_spend: round2(spend),
    purchase_value_meta: actionValue(row.action_values, PURCHASE_ACTION_TYPES),
    purchases_pixel: purchases,
    conversations_meta: conversations,
    meta_link_clicks: clicks,
    meta_impressions: num(row.impressions),
    cost_per_purchase_meta: purchases && purchases > 0 ? round2(spend / purchases) : null,
    cost_per_lead_meta: conversations && conversations > 0 ? round2(spend / conversations) : null,
    purchase_value_leona: null,
    purchases_leona: null,
  }
}

/** Cotação `from → to` (ex.: USD → BRL). `null` = sem cotação. */
export type FxRate = (from: string, to: string) => number | null

/** Cotações fixas `{ 'USD:BRL': 5.4 }`; mesma moeda = 1; par inverso calculado. */
export function fixedFxRates(rates: Record<string, number> = {}): FxRate {
  return (from, to) => {
    const a = from.toUpperCase()
    const b = to.toUpperCase()
    if (a === b) return 1
    const direct = rates[`${a}:${b}`]
    if (typeof direct === 'number' && direct > 0) return direct
    const inverse = rates[`${b}:${a}`]
    if (typeof inverse === 'number' && inverse > 0) return 1 / inverse
    return null
  }
}

/** `META_FX_RATES='{"USD:BRL":5.4}'` (opcional). */
export function fxRatesFromEnv(env: Record<string, string | undefined> = process.env): FxRate {
  try {
    const parsed = JSON.parse(env.META_FX_RATES?.trim() || '{}') as Record<string, number>
    return fixedFxRates(parsed && typeof parsed === 'object' ? parsed : {})
  } catch {
    return fixedFxRates({})
  }
}

/** Converte com 2 casas; sem cotação → null. */
export function convert(value: number | null | undefined, rate: number | null): number | null {
  if (value === null || value === undefined || rate === null) return null
  return round2(value * rate)
}
