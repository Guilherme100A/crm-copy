// T106: regras puras do módulo Facebook (sub-rotas, estados do bundle, colunas, valores, edição, perfis, pixel) e
// as chaves de i18n/marca dos textos.
import { describe, expect, it } from 'vitest'
import { MESSAGES } from '@/i18n/core'
import type { BundleEnvelope, BundleRow, MetaProfile } from './api'
import {
  accountErrorsSummary,
  agoParts,
  applyAccountToggle,
  budgetInitial,
  canManageProfiles,
  canToggle,
  cellValue,
  columnOrderKey,
  cooldownLeft,
  dropColumn,
  editModes,
  editPatch,
  facebookRedirect,
  formatCell,
  initials,
  isDefaultOrder,
  managerView,
  matchesSearch,
  matchesStatus,
  METRIC_COLUMNS,
  moveColumn,
  nextSort,
  normalizeCurrency,
  oauthResult,
  onlyDigits,
  parseBudget,
  parseColumnOrder,
  periodQuery,
  REFRESH_COOLDOWN_MS,
  serverStatusFilter,
  progressReadMode,
  shouldReplace,
  sortRows,
  statusKey,
  statusOptions,
  statusTone,
  togglePatch,
  totals,
  validatePixel,
} from './rules'
import { campaignsSearchSchema, profilesSearchSchema } from './search'

const access = (perms: string[], extra: Partial<{ isOwner: boolean; role: 'owner' | 'admin' | 'member'; isPlatformAdmin: boolean }> = {}) => ({
  isOwner: false,
  isPlatformAdmin: false,
  role: 'member' as const,
  perms: new Set(perms) as never,
  ...extra,
})

function row(over: Omit<Partial<BundleRow>, 'metrics'> & { id: string; metrics?: Partial<BundleRow['metrics']> }): BundleRow {
  return {
    name: over.id,
    status: 'ACTIVE',
    ad_account_id: 'acc-1',
    fb_ad_account_id: 'act_1',
    ad_account_label: 'Conta 1',
    currency: 'BRL',
    daily_budget: null,
    lifetime_budget: null,
    daily_budget_display: null,
    lifetime_budget_display: null,
    ...over,
    metrics: {
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
      ...over.metrics,
    },
  }
}

function envelope(over: Partial<BundleEnvelope> = {}): BundleEnvelope {
  return {
    bundle_key: 'k1',
    status: 'ready',
    campaign: [],
    adset: [],
    ad: [],
    targets_done: 1,
    targets_total: 1,
    errors: [],
    display_currency: 'BRL',
    since: '2026-10-17',
    until: '2026-10-17',
    status_filter: 'active',
    warnings: [],
    cached: false,
    generated_at: '2026-10-17T12:00:00.000Z',
    ...over,
  }
}

describe('AC-T106-01 sub-rotas permitidas', () => {
  it('índice vai para a primeira permitida (campaigns → pixel → profiles)', () => {
    expect(facebookRedirect(access(['facebook.pixel']), null)).toBe('/facebook/pixel')
    expect(facebookRedirect(access(['facebook.profiles', 'facebook.pixel']), null)).toBe('/facebook/pixel')
    expect(facebookRedirect(access(['facebook.campaigns', 'facebook.pixel']), null)).toBe('/facebook/campaigns')
    expect(facebookRedirect(access([], { isOwner: true }), null)).toBe('/facebook/campaigns')
  })
  it('sub-rota sem a permissão redireciona; com a permissão fica', () => {
    expect(facebookRedirect(access(['facebook.pixel']), 'campaigns')).toBe('/facebook/pixel')
    expect(facebookRedirect(access(['facebook.pixel']), 'profiles')).toBe('/facebook/pixel')
    expect(facebookRedirect(access(['facebook.pixel']), 'pixel')).toBeNull()
    expect(facebookRedirect(access([]), 'pixel')).toBe('/welcome')
  })
  it('gestão de perfis exige facebook.profiles + owner/admin ou admin da plataforma', () => {
    expect(canManageProfiles(access(['facebook.profiles']))).toBe(false)
    expect(canManageProfiles(access(['facebook.profiles'], { role: 'admin' }))).toBe(true)
    expect(canManageProfiles(access(['facebook.profiles'], { isPlatformAdmin: true }))).toBe(true)
    expect(canManageProfiles(access([], { role: 'admin' }))).toBe(false)
    expect(canManageProfiles(access([], { isOwner: true, role: 'owner' }))).toBe(true)
  })
})

describe('AC-T106-02 estados do Gerenciador', () => {
  it('sem perfil/contas × nenhuma conta incluída', () => {
    const b = envelope({ warnings: ['no_ad_accounts'], targets_total: 0 })
    expect(managerView(b, [])).toEqual({ kind: 'no_accounts' })
    expect(managerView(b, null)).toEqual({ kind: 'no_accounts' })
    expect(managerView(b, [{ ad_accounts_count: 2, ad_accounts_included_count: 0 }])).toEqual({ kind: 'none_included' })
    expect(managerView(b, [{ ad_accounts_count: 0, ad_accounts_included_count: 0 }])).toEqual({ kind: 'no_accounts' })
  })
  it('carregando, parcial e pronto', () => {
    expect(managerView(envelope({ status: 'loading', targets_done: 0, targets_total: 2 }), null)).toEqual({ kind: 'loading', done: 0, total: 2 })
    expect(managerView(envelope({ status: 'partial', targets_done: 1, targets_total: 2, campaign: [row({ id: 'c1' })] }), null)).toMatchObject({ kind: 'data', partial: true, done: 1, total: 2 })
    expect(managerView(envelope({ campaign: [row({ id: 'c1' })] }), null)).toMatchObject({ kind: 'data', partial: false, rateLimited: false })
  })
  it('limite da Meta: com cache mostra dados + aviso; sem cache é erro', () => {
    expect(managerView(envelope({ warnings: ['rate_limited'], cached: true, campaign: [row({ id: 'c1' })] }), null)).toMatchObject({ kind: 'data', rateLimited: true })
    expect(managerView(envelope({ status: 'loading', warnings: ['rate_limited'] }), null)).toEqual({ kind: 'rate_limited_error' })
  })
  it('erros por conta: 1 conta com rótulo, várias com contagem', () => {
    const label = (e: { fb_ad_account_id: string }) => `L-${e.fb_ad_account_id}`
    expect(accountErrorsSummary([], label)).toBeNull()
    expect(accountErrorsSummary([{ ad_account_id: 'a', fb_ad_account_id: 'act_1', error: 'boom' }], label)).toEqual({ single: 'L-act_1: boom' })
    expect(
      accountErrorsSummary(
        [
          { ad_account_id: 'a', fb_ad_account_id: 'act_1', error: 'x' },
          { ad_account_id: 'b', fb_ad_account_id: 'act_2', error: 'y' },
        ],
        label,
      ),
    ).toEqual({ count: 2 })
  })
  it('pronto nunca é trocado por pendente; pendentes trocam pelo mais avançado', () => {
    const ready = envelope({ campaign: [row({ id: 'c1' })] })
    expect(shouldReplace(ready, envelope({ status: 'refreshing', targets_done: 0 }))).toBe(false)
    expect(shouldReplace(ready, envelope({ generated_at: 'x' }))).toBe(true)
    expect(shouldReplace(envelope({ status: 'loading', targets_done: 0 }), envelope({ status: 'partial', targets_done: 1 }))).toBe(true)
    expect(shouldReplace(envelope({ status: 'partial', targets_done: 2 }), envelope({ status: 'partial', targets_done: 1 }))).toBe(false)
    expect(shouldReplace(null, envelope({ status: 'loading' }))).toBe(true)
    expect(shouldReplace(ready, envelope({ bundle_key: 'other', status: 'loading' }))).toBe(true)
  })
  it('limite da Meta sem cache: envelope com rate_limited (mesmo status/linhas/progresso) substitui e vira erro', () => {
    const loading = envelope({ status: 'loading', targets_done: 0, targets_total: 2 })
    const limited = envelope({ status: 'loading', targets_done: 0, targets_total: 2, warnings: ['rate_limited'] })
    expect(shouldReplace(loading, limited)).toBe(true)
    expect(shouldReplace(limited, limited)).toBe(false)
    // aviso novo não troca um pendente mais avançado
    expect(shouldReplace(envelope({ status: 'partial', targets_done: 2, campaign: [row({ id: 'c1' })] }), envelope({ status: 'partial', targets_done: 1, warnings: ['rate_limited'] }))).toBe(false)
    expect(managerView(limited, null)).toEqual({ kind: 'rate_limited_error' })
    // mesmo sem a troca, o envelope mais recente com o aviso leva ao erro
    expect(managerView(loading, null, false, limited)).toEqual({ kind: 'rate_limited_error' })
  })
  it('limite da Meta sem último pronto (T129): ready vazio com rate_limited é aviso, não tabela vazia', () => {
    const readyEmpty = envelope({ warnings: ['rate_limited'] })
    expect(managerView(readyEmpty, null)).toEqual({ kind: 'rate_limited_error' })
    expect(managerView(envelope({ cached: true, warnings: ['rate_limited'] }), null)).toEqual({ kind: 'rate_limited_error' })
    // o pendente exibido é trocado pelo pronto vazio com aviso (sync e async)
    expect(shouldReplace(envelope({ status: 'loading', targets_done: 0, targets_total: 2 }), readyEmpty)).toBe(true)
    // pronto exibido vazio sem aviso + refresh que caiu no limite: aviso
    expect(managerView(envelope({}), null, false, envelope({ status: 'refreshing', warnings: ['rate_limited'] }))).toEqual({ kind: 'rate_limited_error' })
    // caso antigo continua: loading + rate_limited
    expect(managerView(envelope({ status: 'loading', warnings: ['rate_limited'] }), null)).toEqual({ kind: 'rate_limited_error' })
    // pronto vazio sem limite continua sendo dados (tabela com "sem resultados")
    expect(managerView(envelope({}), null)).toMatchObject({ kind: 'data', rateLimited: false })
  })
  it('limite da Meta com cache: o pronto cached com rate_limited do refresh entra e mostra o aviso com os dados', () => {
    const ready = envelope({ campaign: [row({ id: 'c1' })] })
    const cachedLimited = envelope({ cached: true, warnings: ['rate_limited'], campaign: [row({ id: 'c1' })] })
    expect(shouldReplace(ready, cachedLimited)).toBe(true)
    expect(managerView(cachedLimited, null)).toMatchObject({ kind: 'data', rateLimited: true, partial: false })
    // refresh pendente com o aviso: o pronto fica na tela e o aviso aparece
    const refreshingLimited = envelope({ status: 'refreshing', targets_done: 0, warnings: ['rate_limited'] })
    expect(shouldReplace(ready, refreshingLimited)).toBe(false)
    expect(managerView(ready, null, false, refreshingLimited)).toMatchObject({ kind: 'data', rateLimited: true })
    expect(managerView(ready, null, false, envelope({ bundle_key: 'other', warnings: ['rate_limited'] }))).toMatchObject({ rateLimited: false })
  })
  it('SSE do bundle pendente relê em async (o sync sem force perde o rate_limited do refresh)', () => {
    const refreshing = envelope({ status: 'refreshing', targets_done: 0 })
    expect(progressReadMode(refreshing, { bundle_key: 'k1', status: 'ready' })).toBe('async')
    expect(progressReadMode(envelope({ status: 'loading' }), { bundle_key: 'k1', status: 'ready' })).toBe('async')
    expect(progressReadMode(envelope({ status: 'loading' }), { bundle_key: 'k1', status: 'partial' })).toBe('async')
    // ignora: outro bundle, já pronto, sem dado em cache, status sem novidade
    expect(progressReadMode(refreshing, { bundle_key: 'other', status: 'ready' })).toBeNull()
    expect(progressReadMode(envelope({}), { bundle_key: 'k1', status: 'ready' })).toBeNull()
    expect(progressReadMode(undefined, { bundle_key: 'k1', status: 'ready' })).toBeNull()
    expect(progressReadMode(refreshing, { bundle_key: 'k1', status: 'refreshing' })).toBeNull()
  })
})

describe('AC-T106-03 atualizar, colunas e rótulos', () => {
  it('cooldown de 30 s', () => {
    expect(REFRESH_COOLDOWN_MS).toBe(30_000)
    expect(cooldownLeft(null, 1000)).toBe(0)
    expect(cooldownLeft(1000, 1000)).toBe(30_000)
    expect(cooldownLeft(1000, 30_999)).toBe(1)
    expect(cooldownLeft(1000, 31_000)).toBe(0)
  })
  it('"Atualizado há X"', () => {
    const at = '2026-10-17T12:00:00.000Z'
    const t0 = Date.parse(at)
    expect(agoParts(at, t0 + 10_000)).toEqual({ unit: 'now', n: 0 })
    expect(agoParts(at, t0 + 5 * 60_000)).toEqual({ unit: 'min', n: 5 })
    expect(agoParts(at, t0 + 3 * 3_600_000)).toEqual({ unit: 'h', n: 3 })
    expect(agoParts(null, t0)).toBeNull()
  })
  it('ordem salva: chave versionada por empresa, ignora chaves obsoletas e completa as que faltam', () => {
    expect(columnOrderKey('co-1')).toBe('facebook.columns.v1:co-1')
    expect(columnOrderKey('co-1')).not.toBe(columnOrderKey('co-2'))
    expect(parseColumnOrder(null)).toEqual([...METRIC_COLUMNS])
    expect(parseColumnOrder('{nope')).toEqual([...METRIC_COLUMNS])
    const order = parseColumnOrder(JSON.stringify(['meta_impressions', 'old_column', 'meta_spend', 'meta_impressions']))
    expect(order.slice(0, 2)).toEqual(['meta_impressions', 'meta_spend'])
    expect(order).toHaveLength(METRIC_COLUMNS.length)
    expect(new Set(order).size).toBe(METRIC_COLUMNS.length)
  })
  it('mover por setas e arrastar; restaurar = ordem padrão', () => {
    const base = [...METRIC_COLUMNS]
    const up = moveColumn(base, 'revenue_pair', -1)
    expect(up.slice(0, 2)).toEqual(['revenue_pair', 'meta_spend'])
    expect(moveColumn(base, 'meta_spend', -1)).toEqual(base)
    expect(moveColumn(base, 'meta_impressions', 1)).toEqual(base)
    const dragged = dropColumn(base, 'meta_impressions', 'meta_spend')
    expect(dragged[0]).toBe('meta_impressions')
    expect(isDefaultOrder(dragged)).toBe(false)
    expect(isDefaultOrder(base)).toBe(true)
  })
  it('pares "interno / Meta": valores, lucro, ROAS e nulos como —', () => {
    const r = row({
      id: 'a1',
      metrics: { meta_spend: 100, purchase_value_meta: 300, purchase_value_leona: 250, purchases_leona: 2, purchases_pixel: 3 },
    })
    expect(cellValue(r, 'revenue_pair')).toEqual({ pair: { internal: 250, meta: 300 } })
    expect(cellValue(r, 'profit_pair')).toEqual({ pair: { internal: 150, meta: 200 } })
    expect(cellValue(r, 'roas_pair')).toEqual({ pair: { internal: 2.5, meta: 3 } })
    expect(cellValue(r, 'purchases')).toEqual({ pair: { internal: 2, meta: 3 } })
    const empty = row({ id: 'a2' })
    expect(cellValue(empty, 'roas_pair')).toEqual({ pair: { internal: null, meta: null } })
    expect(formatCell('revenue_pair', cellValue(empty, 'revenue_pair'), 'BRL', 'pt-BR')).toBe('— / —')
    expect(formatCell('meta_impressions', { value: 1234 }, 'BRL', 'en')).toBe('1,234')
  })
  it('prefere o valor na moeda de exibição (`_display`)', () => {
    const r = row({ id: 'a1', metrics: { meta_spend: 10, meta_spend_display: 55 } })
    expect(cellValue(r, 'meta_spend')).toEqual({ value: 55 })
  })
  it('totais / médias ponderadas', () => {
    const rows = [
      row({ id: 'a', metrics: { meta_spend: 100, purchase_value_meta: 300, purchases_pixel: 2, conversations_meta: 4, meta_impressions: 1000 } }),
      row({ id: 'b', metrics: { meta_spend: 50, purchase_value_meta: null, purchases_pixel: 1, conversations_meta: 1, meta_impressions: 500 } }),
    ]
    const t = totals(rows)
    expect(t.meta_spend).toEqual({ value: 150 })
    expect(t.revenue_pair.pair).toEqual({ internal: null, meta: 300 })
    expect(t.profit_pair.pair).toEqual({ internal: null, meta: 200 })
    expect(t.roas_pair.pair).toEqual({ internal: null, meta: 2 })
    expect(t.cost_per_purchase_meta).toEqual({ value: 50 })
    expect(t.cost_per_lead_meta).toEqual({ value: 30 })
    expect(t.meta_impressions).toEqual({ value: 1500 })
  })
  it('rótulos visíveis: pares com {app} e nenhum texto com a marca de referência', () => {
    for (const locale of ['pt-BR', 'en', 'es']) {
      const json = JSON.stringify(MESSAGES[locale]?.facebook)
      expect(json, locale).toBeTruthy()
      expect(json.toLowerCase()).not.toContain(['le', 'ona'].join(''))
      expect(json).toContain('{app} / Meta')
    }
  })
})

describe('AC-T106-04 status e edição', () => {
  it('switch só para status alternáveis com conta', () => {
    expect(canToggle({ status: 'ACTIVE', fb_ad_account_id: 'act_1' })).toBe(true)
    expect(canToggle({ status: 'ARCHIVED', fb_ad_account_id: 'act_1' })).toBe(true)
    expect(canToggle({ status: 'DELETED', fb_ad_account_id: 'act_1' })).toBe(false)
    expect(canToggle({ status: 'ACTIVE', fb_ad_account_id: '' })).toBe(false)
  })
  it('toggle envia o oposto (ACTIVE ↔ PAUSED)', () => {
    expect(togglePatch({ status: 'ACTIVE', fb_ad_account_id: 'act_1' }, 'campaign')).toEqual({ level: 'campaign', fb_ad_account_id: 'act_1', status: 'PAUSED' })
    expect(togglePatch({ status: 'CAMPAIGN_PAUSED', fb_ad_account_id: 'act_1' }, 'ad')).toMatchObject({ status: 'ACTIVE', level: 'ad' })
  })
  it('anúncio não tem nome nem orçamento; sem conta só nome', () => {
    expect(editModes({ fb_ad_account_id: 'act_1' }, 'ad')).toEqual([])
    expect(editModes({ fb_ad_account_id: 'act_1' }, 'campaign')).toEqual(['name', 'budget'])
    expect(editModes({ fb_ad_account_id: '' }, 'adset')).toEqual(['name'])
    expect(editPatch({ fb_ad_account_id: 'act_1' }, 'ad', 'name', { name: 'x' })).toEqual({ ok: false, error: 'not_editable' })
  })
  it('nome com trim; vazio não vai', () => {
    expect(editPatch({ fb_ad_account_id: 'act_1' }, 'campaign', 'name', { name: '  Nova  ' })).toEqual({ ok: true, body: { level: 'campaign', fb_ad_account_id: 'act_1', name: 'Nova' } })
    expect(editPatch({ fb_ad_account_id: 'act_1' }, 'campaign', 'name', { name: '   ' })).toEqual({ ok: false, error: 'name_required' })
  })
  it('orçamento: vírgula decimal, campo vazio não é enviado, negativo/inválido recusa', () => {
    expect(parseBudget('12,50')).toBe(12.5)
    expect(parseBudget('1.234,56')).toBe(1234.56)
    expect(parseBudget('7.5')).toBe(7.5)
    expect(parseBudget('')).toBeUndefined()
    expect(parseBudget('-3')).toBeNull()
    expect(parseBudget('abc')).toBeNull()
    expect(editPatch({ fb_ad_account_id: 'act_1' }, 'adset', 'budget', { daily: '20,5', lifetime: '' })).toEqual({ ok: true, body: { level: 'adset', fb_ad_account_id: 'act_1', daily_budget: 20.5 } })
    expect(editPatch({ fb_ad_account_id: 'act_1' }, 'adset', 'budget', { daily: '', lifetime: '' })).toEqual({ ok: false, error: 'budget_required' })
    expect(editPatch({ fb_ad_account_id: 'act_1' }, 'adset', 'budget', { daily: 'x' })).toEqual({ ok: false, error: 'budget_invalid' })
    expect(budgetInitial(0)).toBe('')
    expect(budgetInitial(null)).toBe('')
    expect(budgetInitial(12.5)).toBe('12.5')
  })
})

describe('filtros, ordenação e período', () => {
  const rows = [row({ id: 'b', name: 'Beta', status: 'PAUSED' }), row({ id: 'a', name: 'Alfa', status: 'PAUSED' }), row({ id: 'c', name: 'Gama', status: 'ACTIVE', campaign_name: 'Black Friday' })]
  it('status: active ↔ servidor; filtro no cliente', () => {
    expect(serverStatusFilter('active')).toBe('active')
    expect(serverStatusFilter('all')).toBe('all')
    expect(serverStatusFilter('PAUSED')).toBe('all')
    expect(rows.filter((r) => matchesStatus(r, 'active')).map((r) => r.id)).toEqual(['c'])
    expect(rows.filter((r) => matchesStatus(r, 'PAUSED')).map((r) => r.id)).toEqual(['b', 'a'])
    expect(rows.filter((r) => matchesStatus(r, 'all'))).toHaveLength(3)
  })
  it('opções do status incluem os novos dos dados', () => {
    const opts = statusOptions([{ status: 'NEW_THING' }, { status: 'ACTIVE' }])
    expect(opts.slice(0, 2)).toEqual(['active', 'all'])
    expect(opts).toContain('NEW_THING')
    expect(opts).not.toContain('ACTIVE')
  })
  it('busca em nome, campanha, conta e id', () => {
    expect(rows.filter((r) => matchesSearch(r, 'black')).map((r) => r.id)).toEqual(['c'])
    expect(rows.filter((r) => matchesSearch(r, 'conta 1'))).toHaveLength(3)
    expect(rows.filter((r) => matchesSearch(r, ''))).toHaveLength(3)
  })
  it('padrão = ativos primeiro e nome; nulos no fim; clique inverte', () => {
    expect(sortRows(rows, { key: 'default', dir: 'asc' }).map((r) => r.id)).toEqual(['c', 'a', 'b'])
    const withSpend = [row({ id: 'x', metrics: { meta_spend: 5 } }), row({ id: 'y', metrics: { meta_spend: 9 } }), row({ id: 'z' })]
    expect(sortRows(withSpend, { key: 'meta_spend', dir: 'desc' }).map((r) => r.id)).toEqual(['y', 'x', 'z'])
    expect(sortRows(withSpend, { key: 'roas_pair', dir: 'asc' }).map((r) => r.id)).toEqual(['x', 'y', 'z'])
    expect(nextSort({ key: 'meta_spend', dir: 'desc' }, 'meta_spend')).toEqual({ key: 'meta_spend', dir: 'asc' })
    expect(nextSort({ key: 'meta_spend', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' })
  })
  it('período: preset ou personalizado válido', () => {
    expect(periodQuery('7d')).toEqual({ date_preset: '7d' })
    expect(periodQuery('custom', '2026-10-01', '2026-10-10')).toEqual({ date_preset: 'custom', since: '2026-10-01', until: '2026-10-10' })
    expect(periodQuery('custom', '2026-10-10', '2026-10-01')).toBeNull()
    expect(periodQuery('custom', '', '2026-10-01')).toBeNull()
  })
  it('status: tom e chave i18n', () => {
    expect(statusTone('ACTIVE')).toBe('success')
    expect(statusTone('ADSET_PAUSED')).toBe('warning')
    expect(statusTone('DELETED')).toBe('neutral')
    expect(statusKey('PAUSED')).toBe('status.PAUSED')
    expect(statusKey('WHATEVER')).toBeNull()
  })
  it('moeda: ISO de 3 letras, senão BRL', () => {
    expect(normalizeCurrency('USD')).toBe('USD')
    expect(normalizeCurrency('usd')).toBe('BRL')
    expect(normalizeCurrency(null)).toBe('BRL')
  })
  it('search params com prefixo fb_ (nunca ?status=)', () => {
    expect(campaignsSearchSchema.parse({ fb_level: 'adset', fb_status: 'PAUSED', fb_period: '7d' })).toEqual({ fb_level: 'adset', fb_status: 'PAUSED', fb_period: '7d' })
    expect(campaignsSearchSchema.parse({ fb_level: 'nope', fb_period: 'x' })).toEqual({ fb_level: undefined, fb_period: undefined })
    expect(Object.keys(campaignsSearchSchema.shape)).not.toContain('status')
    expect(profilesSearchSchema.parse({ meta_oauth: 'success' })).toEqual({ meta_oauth: 'success' })
  })
})

describe('AC-T106-05 perfis e pixel', () => {
  const profiles = [
    {
      id: 'p1',
      ad_accounts_included_count: 1,
      ad_accounts: [
        { id: 'a1', included_in_dashboard: true },
        { id: 'a2', included_in_dashboard: false },
      ],
    },
    { id: 'p2', ad_accounts_included_count: 0, ad_accounts: [{ id: 'a3', included_in_dashboard: false }] },
  ] as unknown as MetaProfile[]
  it('toggle otimista ajusta a conta e o contador do perfil (rollback = estado anterior intacto)', () => {
    const next = applyAccountToggle(profiles, 'a2', true)
    expect(next[0]!.ad_accounts.find((a) => a.id === 'a2')!.included_in_dashboard).toBe(true)
    expect(next[0]!.ad_accounts_included_count).toBe(2)
    expect(next[1]).toBe(profiles[1])
    expect(profiles[0]!.ad_accounts_included_count).toBe(1)
    expect(applyAccountToggle(profiles, 'a1', false)[0]!.ad_accounts_included_count).toBe(0)
  })
  it('retorno do OAuth', () => {
    expect(oauthResult({ meta_oauth: 'success' })).toEqual({ status: 'success', message: null })
    expect(oauthResult({ meta_oauth: 'error', meta_message: ' Negado ' })).toEqual({ status: 'error', message: 'Negado' })
    expect(oauthResult({ meta_oauth: 'other' })).toBeNull()
    expect(oauthResult({})).toBeNull()
  })
  it('iniciais do avatar', () => {
    expect(initials('Maria da Silva', '123')).toBe('MS')
    expect(initials('Ana', '123')).toBe('A')
    expect(initials(null, '987654')).toBe('98')
  })
  it('pixel: nome 2..255, Pixel ID só dígitos, token obrigatório só na criação', () => {
    expect(onlyDigits('12a3-4')).toBe('1234')
    expect(validatePixel({ name: 'Loja', pixel_id: '123', access_token: 'tok' }, false)).toEqual({})
    expect(validatePixel({ name: 'L', pixel_id: '12x', access_token: '' }, false)).toEqual({ name: 'name_length', pixel_id: 'digits', access_token: 'required' })
    expect(validatePixel({ name: 'Loja', pixel_id: '123', access_token: '' }, true)).toEqual({})
    expect(validatePixel({ name: ' ', pixel_id: '', access_token: '' }, true)).toEqual({ name: 'required', pixel_id: 'required' })
  })
})
