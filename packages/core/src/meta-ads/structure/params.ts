// Parâmetros do bundle (T101; 11 §4.2, §5.2): nível, escopo de status, período no fuso da empresa, contas e moeda de
// exibição; e a chave de cache (empresa + contas ordenadas + datas + nível + escopo + moeda).
import { createHash } from 'node:crypto'

export const BUNDLE_LEVELS = ['campaign', 'adset', 'ad'] as const
export type BundleLevel = (typeof BUNDLE_LEVELS)[number]
export const STATUS_FILTERS = ['active', 'all'] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]
export const DATE_PRESETS = ['today', 'yesterday', '7d', '30d', 'month', 'custom'] as const
export type DatePreset = (typeof DATE_PRESETS)[number]

export interface BundleParams {
  level: BundleLevel
  statusFilter: StatusFilter
  datePreset: DatePreset
  /** `YYYY-MM-DD` no fuso da empresa (resolvidos a partir do preset quando não é `custom`). */
  since: string
  until: string
  /** Ids LOCAIS (`crm.meta_ad_accounts.id`), ordenados; vazio = todas as incluídas no dashboard. */
  adAccountIds: string[]
  displayCurrency: string
}

export class BundleParamsError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
    this.name = 'BundleParamsError'
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_RE = /^[A-Z]{3}$/

/** Data `YYYY-MM-DD` de `at` no fuso. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Soma dias numa data `YYYY-MM-DD` (calendário, sem fuso). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Período do preset no fuso da empresa: today, yesterday, 7d (hoje − 6), 30d (hoje − 29), month (dia 1 → hoje). */
export function presetRange(preset: Exclude<DatePreset, 'custom'>, now: Date, timeZone: string): { since: string; until: string } {
  const today = localDate(now, timeZone)
  switch (preset) {
    case 'today':
      return { since: today, until: today }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { since: y, until: y }
    }
    case '7d':
      return { since: addDays(today, -6), until: today }
    case '30d':
      return { since: addDays(today, -29), until: today }
    case 'month':
      return { since: `${today.slice(0, 8)}01`, until: today }
  }
}

export interface RawBundleQuery {
  level?: string
  status_filter?: string
  date_preset?: string
  since?: string
  until?: string
  ad_account_ids?: string[]
  display_currency?: string
}

/** Normaliza e valida (erro com o campo). `since/until` sem preset = `custom`. */
export function normalizeBundleParams(q: RawBundleQuery, ctx: { now: Date; timeZone: string; defaultCurrency: string }): BundleParams {
  const level = (q.level ?? 'campaign') as BundleLevel
  if (!(BUNDLE_LEVELS as readonly string[]).includes(level)) throw new BundleParamsError('level', 'Use campaign, adset ou ad')
  const statusFilter = (q.status_filter ?? 'active').toLowerCase() as StatusFilter
  if (!(STATUS_FILTERS as readonly string[]).includes(statusFilter)) throw new BundleParamsError('status_filter', 'Use active ou all')
  const datePreset = (q.date_preset ?? (q.since || q.until ? 'custom' : 'today')) as DatePreset
  if (!(DATE_PRESETS as readonly string[]).includes(datePreset)) throw new BundleParamsError('date_preset', 'Período inválido')
  let since: string
  let until: string
  if (datePreset === 'custom') {
    if (!q.since || !DATE_RE.test(q.since)) throw new BundleParamsError('since', 'Informe a data inicial (YYYY-MM-DD)')
    if (!q.until || !DATE_RE.test(q.until)) throw new BundleParamsError('until', 'Informe a data final (YYYY-MM-DD)')
    if (q.since > q.until) throw new BundleParamsError('until', 'A data final deve ser depois da inicial')
    since = q.since
    until = q.until
  } else {
    ;({ since, until } = presetRange(datePreset, ctx.now, ctx.timeZone))
  }
  const displayCurrency = (q.display_currency?.trim().toUpperCase() || ctx.defaultCurrency).toUpperCase()
  if (!CURRENCY_RE.test(displayCurrency)) throw new BundleParamsError('display_currency', 'Moeda ISO-4217 (3 letras)')
  const adAccountIds = [...new Set((q.ad_account_ids ?? []).map((s) => s.trim()).filter(Boolean))].sort()
  return { level, statusFilter, datePreset, since, until, adAccountIds, displayCurrency }
}

/**
 * Chave do bundle: a estrutura e os insights saem por conta para os 3 níveis num job só, então o nível NÃO entra
 * (as três abas usam o mesmo bundle). Entram empresa, contas efetivas, período, escopo e moeda.
 */
export function bundleKey(companyId: string, p: Pick<BundleParams, 'statusFilter' | 'since' | 'until' | 'displayCurrency'>, accountIds: readonly string[]): string {
  const raw = JSON.stringify([companyId, [...accountIds].sort(), p.since, p.until, p.statusFilter, p.displayCurrency])
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}
