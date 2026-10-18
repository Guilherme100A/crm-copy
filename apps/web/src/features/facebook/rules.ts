// Regras puras do módulo Facebook (T106; 11 §2, §3.4, §4, §5): sub-rota permitida, status das entidades, colunas de
// métricas (ordem persistida por empresa), valores pareados, totais, ordenação, busca, orçamento e estados do bundle.
// Testadas em facebook.unit.test.ts; os componentes só montam a tela sobre elas.
import { hasAny, type Session } from '@/lib/session'
import type { BundleEnvelope, BundleMode, BundleRow, MetaProfile } from './api'

// ---------------------------------------------------------------- sub-rotas e permissões (11 §2, §8)

export const FACEBOOK_SUBS = ['campaigns', 'pixel', 'events', 'links', 'profiles'] as const
export type FacebookSub = (typeof FACEBOOK_SUBS)[number]

export const SUB_PERMISSION: Record<FacebookSub, string> = {
  campaigns: 'facebook.campaigns',
  pixel: 'facebook.pixel',
  events: 'facebook.pixel',
  links: 'facebook.pixel',
  profiles: 'facebook.profiles',
}

type Access = Pick<Session, 'isOwner' | 'perms'>

/** Sub-rotas que a sessão pode abrir, na ordem campaigns → pixel → profiles. */
export function allowedSubs(session: Access | null | undefined): FacebookSub[] {
  if (!session) return []
  return FACEBOOK_SUBS.filter((s) => hasAny(session, [SUB_PERMISSION[s]]))
}

/**
 * Para onde ir ao abrir `/facebook/<sub>` (ou o índice, `sub = null`): `null` = pode ficar; senão a primeira sub-rota
 * permitida. Sem nenhuma, a guarda global já leva à home (aqui devolve `/welcome` por segurança).
 */
export function facebookRedirect(session: Access | null | undefined, sub: FacebookSub | null): string | null {
  const allowed = allowedSubs(session)
  if (sub && allowed.includes(sub)) return null
  return allowed[0] ? `/facebook/${allowed[0]}` : '/welcome'
}

/** Gerir perfis e contas: `facebook.profiles` + owner/admin da empresa ou admin da plataforma (11 §8). */
export function canManageProfiles(session: Pick<Session, 'role' | 'isPlatformAdmin' | 'perms' | 'isOwner'> | null | undefined): boolean {
  if (!session || !hasAny(session, ['facebook.profiles'])) return false
  return session.isPlatformAdmin || session.role === 'owner' || session.role === 'admin'
}

// ---------------------------------------------------------------- status (11 §4.1)

export const KNOWN_STATUSES = [
  'ACTIVE',
  'PAUSED',
  'CAMPAIGN_PAUSED',
  'ADSET_PAUSED',
  'ARCHIVED',
  'DELETED',
  'IN_PROCESS',
  'WITH_ISSUES',
  'PENDING_REVIEW',
  'DISAPPROVED',
  'PENDING_BILLING_INFO',
  'PREAPPROVED',
  'SCHEDULED',
  'COMPLETED',
] as const

/** Linhas com switch: estes status e com `fb_ad_account_id` (sem ele, a linha é só leitura). */
export const TOGGLEABLE_STATUSES = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED'] as const

export const canToggle = (row: Pick<BundleRow, 'status' | 'fb_ad_account_id'>) =>
  !!row.fb_ad_account_id && (TOGGLEABLE_STATUSES as readonly string[]).includes(row.status)

export type StatusTone = 'success' | 'warning' | 'neutral'

export function statusTone(status: string): StatusTone {
  if (status === 'ACTIVE') return 'success'
  if (status === 'PAUSED' || status === 'CAMPAIGN_PAUSED' || status === 'ADSET_PAUSED') return 'warning'
  return 'neutral'
}

/** Chave i18n do status conhecido, ou `null` (a UI mostra "Status ({code})"). */
export const statusKey = (status: string) => ((KNOWN_STATUSES as readonly string[]).includes(status) ? `status.${status}` : null)

/** Opções do filtro de status: `active` (padrão), `all`, a lista fixa e qualquer status novo dos dados. */
export function statusOptions(rows: readonly Pick<BundleRow, 'status'>[]): string[] {
  const extra = [...new Set(rows.map((r) => r.status))].filter((s) => s && !(KNOWN_STATUSES as readonly string[]).includes(s)).sort()
  return ['active', 'all', ...KNOWN_STATUSES.filter((s) => s !== 'ACTIVE'), ...extra]
}

/** `?fb_status=` → escopo enviado ao servidor: `active` pede só ativos; o resto pede `all` e filtra no cliente. */
export const serverStatusFilter = (fbStatus: string) => (fbStatus === 'active' ? 'active' : 'all')

/** Filtro de status no cliente: `active` = ACTIVE, `all` = tudo, senão o código exato. */
export function matchesStatus(row: Pick<BundleRow, 'status'>, fbStatus: string): boolean {
  if (fbStatus === 'all') return true
  if (fbStatus === 'active') return row.status === 'ACTIVE'
  return row.status === fbStatus
}

/** Busca por nome (11 §5.2 nº 10): contém, sem caixa, em nome, campanha, conjunto, rótulo da conta e id. */
export function matchesSearch(row: BundleRow, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [row.name, row.campaign_name, row.adset_name, row.ad_account_label, row.id].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle))
}

// ---------------------------------------------------------------- colunas de métricas (11 §3.4)

export const METRIC_COLUMNS = [
  'meta_spend',
  'revenue_pair',
  'profit_pair',
  'purchases',
  'roas_pair',
  'cost_per_purchase_meta',
  'conversations_meta',
  'cost_per_lead_meta',
  'meta_link_clicks',
  'meta_impressions',
] as const
export type MetricColumn = (typeof METRIC_COLUMNS)[number]

/** Colunas com par "<APP_NAME> / Meta" (ou "/ Pixel" nas compras). */
export const PAIR_COLUMNS: readonly MetricColumn[] = ['revenue_pair', 'profit_pair', 'purchases', 'roas_pair']
export const MONEY_COLUMNS: readonly MetricColumn[] = ['meta_spend', 'revenue_pair', 'profit_pair', 'cost_per_purchase_meta', 'cost_per_lead_meta']

/** Versão do formato salvo: muda quando a lista de colunas mudar (chaves antigas são ignoradas). */
export const COLUMN_ORDER_VERSION = 1
export const columnOrderKey = (companyId: string) => `facebook.columns.v${COLUMN_ORDER_VERSION}:${companyId}`

/** Ordem salva → ordem válida: ignora chaves desconhecidas/repetidas e acrescenta as que faltarem na ordem padrão. */
export function parseColumnOrder(raw: string | null | undefined): MetricColumn[] {
  let list: unknown[] = []
  try {
    const saved: unknown = raw ? JSON.parse(raw) : null
    if (Array.isArray(saved)) list = saved
  } catch {
    // valor corrompido: ordem padrão
  }
  const out: MetricColumn[] = []
  for (const k of list) if ((METRIC_COLUMNS as readonly unknown[]).includes(k) && !out.includes(k as MetricColumn)) out.push(k as MetricColumn)
  for (const k of METRIC_COLUMNS) if (!out.includes(k)) out.push(k)
  return out
}

export const isDefaultOrder = (order: readonly MetricColumn[]) => order.every((k, i) => METRIC_COLUMNS[i] === k)

/** Move a coluna `delta` posições (setas) — fora dos limites não muda. */
export function moveColumn(order: readonly MetricColumn[], key: MetricColumn, delta: number): MetricColumn[] {
  const from = order.indexOf(key)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return [...order]
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, key)
  return next
}

/** Arrastar `key` para a posição de `target` (desktop). */
export function dropColumn(order: readonly MetricColumn[], key: MetricColumn, target: MetricColumn): MetricColumn[] {
  if (key === target) return [...order]
  return moveColumn(order, key, order.indexOf(target) - order.indexOf(key))
}

// ---------------------------------------------------------------- valores (11 §3.4)

type Metrics = BundleRow['metrics']
const round2 = (n: number) => Math.round(n * 100) / 100

/** Valor monetário na moeda de exibição (`_display`), com o original como reserva. */
export function money(m: Metrics, key: 'meta_spend' | 'purchase_value_meta' | 'cost_per_purchase_meta' | 'cost_per_lead_meta' | 'purchase_value_leona'): number | null {
  const display = (m as Record<string, number | null | undefined>)[`${key}_display`]
  if (display !== undefined && display !== null) return display
  const v = m[key]
  return v === undefined ? null : v
}

export interface Pair {
  internal: number | null
  meta: number | null
}

export interface CellValue {
  /** Coluna simples. */
  value?: number | null
  /** Coluna pareada. */
  pair?: Pair
}

const roas = (value: number | null, spend: number | null) => (value === null || spend === null || spend <= 0 ? null : round2(value / spend))

export function cellValue(row: Pick<BundleRow, 'metrics'>, col: MetricColumn): CellValue {
  const m = row.metrics
  const spend = money(m, 'meta_spend')
  const pvMeta = money(m, 'purchase_value_meta')
  const pvInternal = money(m, 'purchase_value_leona')
  switch (col) {
    case 'meta_spend':
      return { value: spend }
    case 'revenue_pair':
      return { pair: { internal: pvInternal, meta: pvMeta } }
    case 'profit_pair':
      return {
        pair: {
          internal: pvInternal === null ? null : round2(pvInternal - (spend ?? 0)),
          meta: pvMeta === null ? null : round2(pvMeta - (spend ?? 0)),
        },
      }
    case 'purchases':
      return { pair: { internal: m.purchases_leona ?? null, meta: m.purchases_pixel ?? null } }
    case 'roas_pair':
      return { pair: { internal: roas(pvInternal, spend), meta: roas(pvMeta, spend) } }
    case 'cost_per_purchase_meta':
      return { value: money(m, 'cost_per_purchase_meta') }
    case 'cost_per_lead_meta':
      return { value: money(m, 'cost_per_lead_meta') }
    case 'conversations_meta':
    case 'meta_link_clicks':
    case 'meta_impressions':
      return { value: m[col] ?? null }
  }
}

/** Número para ordenar a coluna: o valor simples, ou o interno do par (o da Meta se o interno faltar). */
export function sortValue(row: BundleRow, col: SortKey): number | string | null {
  if (col === 'name') return row.name.toLowerCase()
  if (col === 'status') return row.status
  if (col === 'budget') {
    const vals = [row.daily_budget_display ?? row.daily_budget, row.lifetime_budget_display ?? row.lifetime_budget].filter((v): v is number => typeof v === 'number')
    return vals.length ? Math.max(...vals) : null
  }
  if (col === 'default') return null
  const c = cellValue(row, col)
  return c.pair ? (c.pair.internal ?? c.pair.meta) : (c.value ?? null)
}

export type SortKey = 'default' | 'name' | 'status' | 'budget' | MetricColumn
export interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

/** `default` = ativos primeiro, depois nome; nas demais, nulos sempre no fim (11 §4.2). */
export function sortRows(rows: readonly BundleRow[], sort: SortState): BundleRow[] {
  const byName = (a: BundleRow, b: BundleRow) => a.name.localeCompare(b.name)
  if (sort.key === 'default')
    return [...rows].sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') || byName(a, b))
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key)
    const vb = sortValue(b, sort.key)
    if (va === null && vb === null) return byName(a, b)
    if (va === null) return 1
    if (vb === null) return -1
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
    return cmp * sign || byName(a, b)
  })
}

/** Clique no cabeçalho: mesma coluna inverte; outra começa decrescente (métricas) ou crescente (texto). */
export function nextSort(cur: SortState, key: SortKey): SortState {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'name' || key === 'status' ? 'asc' : 'desc' }
}

/** Linha "Totais / médias" (11 §3.4). */
export function totals(rows: readonly BundleRow[]): Record<MetricColumn, CellValue> {
  let spend = 0
  let pvMeta: number | null = null
  let pvInternal: number | null = null
  let profitMeta: number | null = null
  let profitInternal: number | null = null
  let purchInternal: number | null = null
  let purchPixel: number | null = null
  let conv: number | null = null
  let clicks: number | null = null
  let impr: number | null = null
  const add = (acc: number | null, v: number | null | undefined) => (v === null || v === undefined ? acc : (acc ?? 0) + v)
  for (const r of rows) {
    const m = r.metrics
    const s = money(m, 'meta_spend') ?? 0
    spend += s
    const vm = money(m, 'purchase_value_meta')
    const vi = money(m, 'purchase_value_leona')
    pvMeta = add(pvMeta, vm)
    pvInternal = add(pvInternal, vi)
    if (vm !== null) profitMeta = add(profitMeta, vm - s)
    if (vi !== null) profitInternal = add(profitInternal, vi - s)
    purchInternal = add(purchInternal, m.purchases_leona)
    purchPixel = add(purchPixel, m.purchases_pixel)
    conv = add(conv, m.conversations_meta)
    clicks = add(clicks, m.meta_link_clicks)
    impr = add(impr, m.meta_impressions)
  }
  spend = round2(spend)
  const r2 = (v: number | null) => (v === null ? null : round2(v))
  const purchases = (purchInternal ?? 0) + (purchPixel ?? 0)
  return {
    meta_spend: { value: rows.length ? spend : null },
    revenue_pair: { pair: { internal: r2(pvInternal), meta: r2(pvMeta) } },
    profit_pair: { pair: { internal: r2(profitInternal), meta: r2(profitMeta) } },
    purchases: { pair: { internal: purchInternal, meta: purchPixel } },
    roas_pair: { pair: { internal: roas(pvInternal, spend), meta: roas(pvMeta, spend) } },
    cost_per_purchase_meta: { value: purchases > 0 ? round2(spend / purchases) : null },
    conversations_meta: { value: conv },
    cost_per_lead_meta: { value: conv && conv > 0 ? round2(spend / conv) : null },
    meta_link_clicks: { value: clicks },
    meta_impressions: { value: impr },
  }
}

// ---------------------------------------------------------------- formatação

export function formatMoney(value: number | null | undefined, currency: string, locale: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value)
  } catch {
    return `${currency} ${value.toFixed(2)}`
  }
}

export function formatNumber(value: number | null | undefined, locale: string, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}

/** Texto de uma célula de métrica (par = "interno / Meta"). */
export function formatCell(col: MetricColumn, cell: CellValue, currency: string, locale: string): string {
  const one = (v: number | null | undefined) =>
    (MONEY_COLUMNS as readonly string[]).includes(col) ? formatMoney(v, currency, locale) : formatNumber(v, locale, col === 'roas_pair' ? 2 : 0)
  if (cell.pair) return `${one(cell.pair.internal)} / ${one(cell.pair.meta)}`
  return one(cell.value)
}

/** Moedas ISO-4217 do navegador (lista completa quando houver `Intl.supportedValuesOf`). */
export function currencyList(): string[] {
  const base = ['BRL', 'USD', 'EUR', 'GBP', 'ARS', 'CLP', 'COP', 'MXN', 'PEN', 'UYU', 'PYG', 'BOB', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'INR']
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('currency') ?? []
    return [...new Set([...base, ...all.filter((c) => /^[A-Z]{3}$/.test(c))])]
  } catch {
    return base
  }
}

export const normalizeCurrency = (v: string | null | undefined) => (v && /^[A-Z]{3}$/.test(v) ? v : 'BRL')
export const currencyKey = (companyId: string) => `facebook.currency.v1:${companyId}`

// ---------------------------------------------------------------- período (11 §4.2)

export const PERIODS = ['today', 'yesterday', '7d', '30d', 'month', 'custom'] as const
export type Period = (typeof PERIODS)[number]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v)

/** Query de período: preset (o servidor resolve no fuso da empresa) ou `custom` com de/até válidos. */
export function periodQuery(period: Period, since?: string, until?: string): { date_preset: string; since?: string; until?: string } | null {
  if (period !== 'custom') return { date_preset: period }
  if (!isDate(since) || !isDate(until) || since > until) return null
  return { date_preset: 'custom', since, until }
}

// ---------------------------------------------------------------- orçamento e edição (11 §5.3)

/** "12,50" / "1.234,56" / "12.5" → número; vazio → `undefined` (não envia); inválido/negativo → `null`. */
export function parseBudget(raw: string): number | undefined | null {
  const s = raw.trim()
  if (!s) return undefined
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null
  const n = Number(normalized)
  return Number.isFinite(n) && n >= 0 ? round2(n) : null
}

/** Valor inicial do campo: só quando o atual é > 0. */
export const budgetInitial = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? String(v) : '')

export type EditMode = 'name' | 'budget'

/** Modos permitidos: nome em campanha/conjunto; orçamento em campanha/conjunto com conta. Anúncio: nenhum. */
export function editModes(row: Pick<BundleRow, 'fb_ad_account_id'>, level: BundleLevel): EditMode[] {
  if (level === 'ad') return []
  return row.fb_ad_account_id ? ['name', 'budget'] : ['name']
}

export type BundleLevel = 'campaign' | 'adset' | 'ad'
export const LEVELS: readonly BundleLevel[] = ['campaign', 'adset', 'ad']

export interface EntityPatch {
  level: BundleLevel
  fb_ad_account_id: string
  status?: 'ACTIVE' | 'PAUSED'
  name?: string
  daily_budget?: number
  lifetime_budget?: number
}

/** Corpo do PATCH de nome/orçamento: nome com trim (vazio não vai); campo de orçamento vazio não vai. `null` = nada a enviar/inválido. */
export function editPatch(
  row: Pick<BundleRow, 'fb_ad_account_id'>,
  level: BundleLevel,
  mode: EditMode,
  input: { name?: string; daily?: string; lifetime?: string },
): { ok: true; body: EntityPatch } | { ok: false; error: 'name_required' | 'budget_invalid' | 'budget_required' | 'not_editable' } {
  if (!editModes(row, level).includes(mode)) return { ok: false, error: 'not_editable' }
  const body: EntityPatch = { level, fb_ad_account_id: row.fb_ad_account_id }
  if (mode === 'name') {
    const name = (input.name ?? '').trim()
    if (!name) return { ok: false, error: 'name_required' }
    body.name = name
    return { ok: true, body }
  }
  const daily = parseBudget(input.daily ?? '')
  const lifetime = parseBudget(input.lifetime ?? '')
  if (daily === null || lifetime === null) return { ok: false, error: 'budget_invalid' }
  if (daily === undefined && lifetime === undefined) return { ok: false, error: 'budget_required' }
  if (daily !== undefined) body.daily_budget = daily
  if (lifetime !== undefined) body.lifetime_budget = lifetime
  return { ok: true, body }
}

export const togglePatch = (row: Pick<BundleRow, 'fb_ad_account_id' | 'status'>, level: BundleLevel): EntityPatch => ({
  level,
  fb_ad_account_id: row.fb_ad_account_id,
  status: row.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
})

// ---------------------------------------------------------------- atualizar (11 §5.2 nº 5, nº 8)

export const REFRESH_COOLDOWN_MS = 30_000

/** Milissegundos restantes do cooldown do "Atualizar" (0 = liberado). */
export const cooldownLeft = (usedAt: number | null | undefined, now: number) =>
  usedAt === null || usedAt === undefined ? 0 : Math.max(0, usedAt + REFRESH_COOLDOWN_MS - now)

/** "Atualizado há X": unidade e quantidade (o texto é do i18n). */
export function agoParts(at: string | null | undefined, now: number): { unit: 'now' | 'min' | 'h' | 'd'; n: number } | null {
  if (!at) return null
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return null
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return { unit: 'now', n: 0 }
  if (s < 3600) return { unit: 'min', n: Math.floor(s / 60) }
  if (s < 86_400) return { unit: 'h', n: Math.floor(s / 3600) }
  return { unit: 'd', n: Math.floor(s / 86_400) }
}

// ---------------------------------------------------------------- estados do bundle (11 §2.1, §4.4, §5.2)

export const isPending = (b: Pick<BundleEnvelope, 'status'> | null | undefined) => !!b && b.status !== 'ready'
export const isRateLimited = (b: Pick<BundleEnvelope, 'warnings'> | null | undefined) => !!b?.warnings?.includes('rate_limited')
export const rowCount = (b: Pick<BundleEnvelope, 'campaign' | 'adset' | 'ad'>) => b.campaign.length + b.adset.length + b.ad.length

const sameWarnings = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((w, i) => w === b[i])

/**
 * Bundle novo substitui o exibido? (`shouldReplaceBundle`, 11 §7): pronto nunca vira pendente; pronto novo sempre
 * entra; entre pendentes fica o com mais linhas ou mais contas processadas, ou o com avisos diferentes (ex.:
 * `rate_limited`) desde que não perca linhas nem progresso.
 */
export function shouldReplace(cur: BundleEnvelope | null | undefined, next: BundleEnvelope): boolean {
  if (!cur || cur.bundle_key !== next.bundle_key) return true
  if (next.status === 'ready') return true
  if (cur.status === 'ready') return false
  if (cur.status === 'refreshing') return true
  if (rowCount(next) > rowCount(cur) || next.targets_done > cur.targets_done || next.status !== cur.status) return true
  return !sameWarnings(cur.warnings, next.warnings) && rowCount(next) >= rowCount(cur) && next.targets_done >= cur.targets_done
}

/**
 * SSE `meta.bundle.progress` sobre o bundle pendente da tela: em que modo reler (`null` = ignora). Parcial e pronto
 * releem em `async`: o estado do servidor já tem o pronto com erros de conta ou com `rate_limited` (T129), enquanto o
 * `sync` sem `force_refresh` devolve o cache sem o aviso do limite.
 */
export function progressReadMode(
  current: Pick<BundleEnvelope, 'bundle_key' | 'status'> | null | undefined,
  p: { bundle_key: string; status: string },
): BundleMode | null {
  if (!current || p.bundle_key !== current.bundle_key || current.status === 'ready') return null
  return p.status === 'ready' || p.status === 'partial' ? 'async' : null
}

/**
 * Limite da Meta sobre o bundle exibido: o aviso dele, ou o do envelope mais recente da mesma chave (refresh pendente
 * que caiu no limite enquanto o pronto continua na tela).
 */
export const shownRateLimited = (shown: BundleEnvelope, latest: BundleEnvelope | null | undefined) =>
  isRateLimited(shown) || (!!latest && latest.bundle_key === shown.bundle_key && isRateLimited(latest))

export type ManagerView =
  | { kind: 'no_accounts' }
  | { kind: 'none_included' }
  | { kind: 'rate_limited_error' }
  | { kind: 'loading'; done: number; total: number }
  | { kind: 'data'; partial: boolean; done: number; total: number; rateLimited: boolean; refreshing: boolean }

/**
 * Estado da tela (AC-T106-02). `profiles` = perfis da empresa quando a sessão pode lê-los (senão `null`): distingue
 * "sem perfil/contas" de "nenhuma conta incluída".
 */
export function managerView(
  bundle: BundleEnvelope,
  profiles: readonly Pick<MetaProfile, 'ad_accounts_count' | 'ad_accounts_included_count'>[] | null,
  refreshing = false,
  latest: BundleEnvelope | null = null,
): ManagerView {
  if (bundle.warnings.includes('no_ad_accounts')) {
    if (profiles && profiles.some((p) => p.ad_accounts_count > 0) && !profiles.some((p) => p.ad_accounts_included_count > 0)) return { kind: 'none_included' }
    return { kind: 'no_accounts' }
  }
  const rateLimited = shownRateLimited(bundle, latest)
  const hasRows = rowCount(bundle) > 0
  // Sem linhas e no limite: aviso (nunca spinner nem tabela vazia). Cobre `loading` + aviso e o `ready` vazio que o
  // servidor devolve quando não há último pronto (T129).
  if (rateLimited && !hasRows) return { kind: 'rate_limited_error' }
  if (bundle.status !== 'ready' && !hasRows) return { kind: 'loading', done: bundle.targets_done, total: bundle.targets_total }
  return { kind: 'data', partial: bundle.status !== 'ready', done: bundle.targets_done, total: bundle.targets_total, rateLimited, refreshing }
}

/** Mensagem dos erros por conta (11 §5.2 nº 7): 1 conta → "<conta>: <erro>"; várias → contagem. */
export function accountErrorsSummary(errors: BundleEnvelope['errors'], label: (e: BundleEnvelope['errors'][number]) => string): { single: string } | { count: number } | null {
  if (!errors.length) return null
  if (errors.length === 1) return { single: `${label(errors[0]!)}: ${errors[0]!.error}` }
  return { count: errors.length }
}

// ---------------------------------------------------------------- perfis (11 §2.3, §5.1)

/** Retorno do OAuth na URL (`?meta_oauth=success|error&meta_message=`). */
export function oauthResult(search: Record<string, unknown>): { status: 'success' | 'error'; message: string | null } | null {
  const s = search.meta_oauth
  if (s !== 'success' && s !== 'error') return null
  const m = search.meta_message
  return { status: s, message: typeof m === 'string' && m.trim() ? m.trim() : null }
}

/** Iniciais do avatar (nome ou id). */
export function initials(name: string | null | undefined, fallback: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return fallback.slice(0, 2).toUpperCase()
  return ((parts[0]![0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '')).toUpperCase()
}

/** Toggle otimista de conta: aplica `included` e ajusta o contador do perfil. */
export function applyAccountToggle<P extends Pick<MetaProfile, 'id' | 'ad_accounts' | 'ad_accounts_included_count'>>(profiles: readonly P[], accountId: string, included: boolean): P[] {
  return profiles.map((p) => {
    if (!p.ad_accounts.some((a) => a.id === accountId)) return p
    const ad_accounts = p.ad_accounts.map((a) => (a.id === accountId ? { ...a, included_in_dashboard: included } : a))
    return { ...p, ad_accounts, ad_accounts_included_count: ad_accounts.filter((a) => a.included_in_dashboard).length }
  })
}

// ---------------------------------------------------------------- pixel (11 §3.3)

export const onlyDigits = (v: string) => v.replace(/\D+/g, '')

export function validatePixel(input: { name: string; pixel_id: string; access_token: string }, editing: boolean): Partial<Record<'name' | 'pixel_id' | 'access_token', 'required' | 'name_length' | 'digits'>> {
  const errs: Partial<Record<'name' | 'pixel_id' | 'access_token', 'required' | 'name_length' | 'digits'>> = {}
  const name = input.name.trim()
  if (!name) errs.name = 'required'
  else if (name.length < 2 || name.length > 255) errs.name = 'name_length'
  if (!input.pixel_id.trim()) errs.pixel_id = 'required'
  else if (!/^\d+$/.test(input.pixel_id.trim())) errs.pixel_id = 'digits'
  if (!editing && !input.access_token.trim()) errs.access_token = 'required'
  return errs
}

// ---------------------------------------------------------------- revisão 3: rastreamento Meta

/** Campos opcionais do pixel (revisão 3): Página/WABA só dígitos; código de teste sem espaços; país ISO de 2 letras. */
export function validatePixelExtras(input: { page_id: string; whatsapp_business_account_id: string; test_event_code: string; default_country: string }): Partial<
  Record<'page_id' | 'whatsapp_business_account_id' | 'test_event_code' | 'default_country', 'digits' | 'test_code' | 'country'>
> {
  const errs: Partial<Record<'page_id' | 'whatsapp_business_account_id' | 'test_event_code' | 'default_country', 'digits' | 'test_code' | 'country'>> = {}
  if (input.page_id.trim() && !/^\d{3,32}$/.test(input.page_id.trim())) errs.page_id = 'digits'
  if (input.whatsapp_business_account_id.trim() && !/^\d{3,32}$/.test(input.whatsapp_business_account_id.trim())) errs.whatsapp_business_account_id = 'digits'
  if (input.test_event_code.trim() && !/^[A-Za-z0-9_-]{2,64}$/.test(input.test_event_code.trim())) errs.test_event_code = 'test_code'
  if (!/^[a-zA-Z]{2}$/.test(input.default_country.trim())) errs.default_country = 'country'
  return errs
}

/** Países mais comuns no seletor do país padrão (ISO alfa-2 minúsculo). */
export const PIXEL_COUNTRIES = ['br', 'pt', 'us', 'ar', 'mx', 'co', 'cl', 'pe', 'uy', 'py', 'es', 'ao', 'mz'] as const

/** Modo "mensagem de anúncio" (business_messaging) configurado no pixel. */
export const pixelHasAdMessaging = (p: { page_id?: string | null; whatsapp_business_account_id?: string | null }) => Boolean(p.page_id || p.whatsapp_business_account_id)

/** URL pública do link rastreável (a API responde 302 direto para o wa.me). */
export const trackedLinkUrl = (origin: string, path: string) => `${origin.replace(/\/+$/, '')}${path}`

/** Slug sugerido a partir do nome (mesma regra do servidor). */
export const suggestSlug = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

export function validateTrackedLink(input: { name: string; slug: string; connection_id: string; phone: string; message: string; match_window_minutes: string }): Partial<
  Record<'name' | 'slug' | 'destination' | 'phone' | 'message' | 'match_window_minutes', 'required' | 'name_length' | 'slug' | 'phone' | 'message_length' | 'window'>
> {
  const errs: ReturnType<typeof validateTrackedLink> = {}
  const name = input.name.trim()
  if (!name) errs.name = 'required'
  else if (name.length < 2 || name.length > 120) errs.name = 'name_length'
  if (input.slug.trim() && !/^[a-z0-9][a-z0-9-]{2,62}$/.test(input.slug.trim())) errs.slug = 'slug'
  const phone = onlyDigits(input.phone)
  if (phone && (phone.length < 8 || phone.length > 15)) errs.phone = 'phone'
  if (!input.connection_id && !phone) errs.destination = 'required'
  if (input.message.trim().length > 500) errs.message = 'message_length'
  const w = Number(input.match_window_minutes)
  if (!Number.isInteger(w) || w < 1 || w > 1440) errs.match_window_minutes = 'window'
  return errs
}

/**
 * Linha com as métricas <APP>/Meta ajustadas: sem o filtro, as confirmadas (como vêm do servidor); com o filtro
 * explícito, soma as de atribuição provável (`*_probable`). Nunca mistura sem o filtro ligado.
 */
export function applyProbable(row: BundleRow, include: boolean): BundleRow {
  if (!include) return row
  const m = row.metrics as Record<string, number | null | undefined>
  const n = m.purchases_leona_probable ?? 0
  if (!n) return row
  const add = (a: number | null | undefined, b: number | null | undefined) => Math.round(((a ?? 0) + (b ?? 0)) * 100) / 100
  return {
    ...row,
    metrics: {
      ...row.metrics,
      purchases_leona: (m.purchases_leona ?? 0) + n,
      purchase_value_leona: add(m.purchase_value_leona, m.purchase_value_leona_probable),
      purchase_value_leona_display: add(m.purchase_value_leona_display, m.purchase_value_leona_probable_display),
    },
  }
}

/** Vendas de atribuição provável no nível campanha (soma dos anúncios), para a legenda. */
export const probableSales = (campaigns: readonly BundleRow[]) => campaigns.reduce((n, r) => n + ((r.metrics as Record<string, number | null | undefined>).purchases_leona_probable ?? 0), 0)
