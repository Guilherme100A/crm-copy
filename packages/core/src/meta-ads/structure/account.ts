// Estrutura + insights de UMA conta de anúncio (T101): campanhas, conjuntos e anúncios (estrutura) e os insights dos
// três níveis no período, juntados por id. Depois de cada chamada lê o uso (`x-business-use-case-usage` /
// `x-ad-account-usage`, STACK E §1.5): acima de 75% interrompe com `MetaRateLimitedError` (o job é adiado).
import { MetaGraphError, type GraphClient } from '../client/graph'
import { convert, metricsFromInsight, MONEY_METRICS, type FxRate, type GraphInsightRow, type MetaRowMetrics } from './metrics'
import type { BundleLevel, StatusFilter } from './params'

/** Uso acima disto adia o job (STACK E §1.5). */
export const BUC_THRESHOLD_PCT = 75
/** Espera padrão quando a Meta não informa `estimated_time_to_regain_access` (decaimento de 300 s). */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 60_000

export class MetaRateLimitedError extends Error {
  constructor(
    readonly retryAt: number,
    readonly reason: string,
  ) {
    super(`limite de uso da Meta: ${reason}`)
    this.name = 'MetaRateLimitedError'
  }
}

export interface BundleAccount {
  /** Id local (`crm.meta_ad_accounts.id`). */
  id: string
  fbAccountId: string
  name: string | null
  currency: string | null
}

export interface BundleRow {
  id: string
  name: string
  status: string
  objective?: string | null
  campaign_id?: string | null
  campaign_name?: string | null
  adset_id?: string | null
  adset_name?: string | null
  ad_account_id: string
  fb_ad_account_id: string
  ad_account_label: string
  currency: string | null
  daily_budget: number | null
  lifetime_budget: number | null
  daily_budget_display: number | null
  lifetime_budget_display: number | null
  metrics: MetaRowMetrics & Partial<Record<`${(typeof MONEY_METRICS)[number]}_display`, number | null>>
}

export interface AccountRows {
  campaign: BundleRow[]
  adset: BundleRow[]
  ad: BundleRow[]
  /** A cotação da moeda da conta para a de exibição faltou. */
  fxMissing: boolean
}

interface GraphEntity {
  id: string
  name?: string
  effective_status?: string
  status?: string
  objective?: string
  campaign_id?: string
  adset_id?: string
  daily_budget?: string | number
  lifetime_budget?: string | number
}

const cents = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) / 100 : null
}

/** Maior porcentagem de uso dos headers (`call_count`, `total_cputime`, `total_time`, `acc_id_util_pct`). */
export function usagePct(usage: { business: string | null; adAccount: string | null }): { pct: number; waitMs: number } {
  let pct = 0
  let waitMin = 0
  try {
    const biz = usage.business ? (JSON.parse(usage.business) as Record<string, Record<string, number>[]>) : {}
    for (const entries of Object.values(biz))
      for (const e of entries ?? []) {
        pct = Math.max(pct, Number(e.call_count) || 0, Number(e.total_cputime) || 0, Number(e.total_time) || 0)
        waitMin = Math.max(waitMin, Number(e.estimated_time_to_regain_access) || 0)
      }
  } catch {
    // header inválido: ignora
  }
  try {
    const acc = usage.adAccount ? (JSON.parse(usage.adAccount) as Record<string, number>) : {}
    pct = Math.max(pct, Number(acc.acc_id_util_pct) || 0)
  } catch {
    // idem
  }
  return { pct, waitMs: waitMin > 0 ? waitMin * 60_000 : DEFAULT_RATE_LIMIT_WAIT_MS }
}

/** Erros da Graph que são limite de uso (17, 4, 32, 613, 80000-80014): adiar, não falhar. */
export function isRateLimitError(err: unknown): boolean {
  return err instanceof MetaGraphError && err.isRateLimit
}

export interface FetchAccountOptions {
  since: string
  until: string
  statusFilter: StatusFilter
  displayCurrency: string
  fx: FxRate
  now?: () => number
}

const LEVEL_FIELDS: Record<BundleLevel, string> = {
  campaign: 'id,name,effective_status,status,objective,daily_budget,lifetime_budget',
  adset: 'id,name,campaign_id,effective_status,status,daily_budget,lifetime_budget',
  ad: 'id,name,campaign_id,adset_id,effective_status,status',
}
const EDGE: Record<BundleLevel, string> = { campaign: 'campaigns', adset: 'adsets', ad: 'ads' }
const INSIGHT_FIELDS = 'campaign_id,adset_id,ad_id,spend,impressions,inline_link_clicks,actions,action_values'

export async function fetchAccountRows(graph: GraphClient, account: BundleAccount, opts: FetchAccountOptions): Promise<AccountRows> {
  const now = opts.now ?? Date.now
  const guard = () => {
    const { pct, waitMs } = usagePct(graph.lastUsage)
    if (pct > BUC_THRESHOLD_PCT) throw new MetaRateLimitedError(now() + waitMs, `uso ${pct}% acima de ${BUC_THRESHOLD_PCT}%`)
  }
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn()
      guard()
      return out
    } catch (err) {
      if (err instanceof MetaRateLimitedError) throw err
      if (isRateLimitError(err)) throw new MetaRateLimitedError(now() + DEFAULT_RATE_LIMIT_WAIT_MS, `erro ${(err as MetaGraphError).code}`)
      throw err
    }
  }
  const act = account.fbAccountId
  const statusParam = opts.statusFilter === 'active' ? { effective_status: JSON.stringify(['ACTIVE']) } : {}
  const timeRange = JSON.stringify({ since: opts.since, until: opts.until })

  const structure: Record<BundleLevel, GraphEntity[]> = { campaign: [], adset: [], ad: [] }
  const insights: Record<BundleLevel, Map<string, GraphInsightRow>> = { campaign: new Map(), adset: new Map(), ad: new Map() }
  for (const level of ['campaign', 'adset', 'ad'] as const) {
    structure[level] = await call(() => graph.getAll<GraphEntity>(`${act}/${EDGE[level]}`, { fields: LEVEL_FIELDS[level], limit: 200, ...statusParam }))
    const rows = await call(() => graph.getAll<GraphInsightRow>(`${act}/insights`, { level, fields: INSIGHT_FIELDS, time_range: timeRange, limit: 500 }))
    for (const r of rows) {
      const id = level === 'campaign' ? r.campaign_id : level === 'adset' ? r.adset_id : r.ad_id
      if (id) insights[level].set(id, r)
    }
  }

  const currency = account.currency
  const rate = currency ? opts.fx(currency, opts.displayCurrency) : null
  const fxMissing = Boolean(currency) && rate === null
  const label = account.name || act
  const campaignNames = new Map(structure.campaign.map((c) => [c.id, c.name ?? c.id]))
  const adsetNames = new Map(structure.adset.map((s) => [s.id, s.name ?? s.id]))

  const toRow = (level: BundleLevel, e: GraphEntity): BundleRow => {
    const metrics = metricsFromInsight(insights[level].get(e.id)) as BundleRow['metrics']
    for (const k of MONEY_METRICS) metrics[`${k}_display`] = convert(metrics[k], rate)
    const daily = cents(e.daily_budget)
    const lifetime = cents(e.lifetime_budget)
    return {
      id: e.id,
      name: e.name ?? e.id,
      status: e.effective_status ?? e.status ?? 'UNKNOWN',
      ...(level === 'campaign' ? { objective: e.objective ?? null } : {}),
      ...(level !== 'campaign' ? { campaign_id: e.campaign_id ?? null, campaign_name: e.campaign_id ? (campaignNames.get(e.campaign_id) ?? null) : null } : {}),
      ...(level === 'ad' ? { adset_id: e.adset_id ?? null, adset_name: e.adset_id ? (adsetNames.get(e.adset_id) ?? null) : null } : {}),
      ad_account_id: account.id,
      fb_ad_account_id: act,
      ad_account_label: label,
      currency,
      daily_budget: daily,
      lifetime_budget: lifetime,
      daily_budget_display: convert(daily, rate),
      lifetime_budget_display: convert(lifetime, rate),
      metrics,
    }
  }
  return {
    campaign: structure.campaign.map((e) => toRow('campaign', e)),
    adset: structure.adset.map((e) => toRow('adset', e)),
    ad: structure.ad.map((e) => toRow('ad', e)),
    fxMissing,
  }
}
