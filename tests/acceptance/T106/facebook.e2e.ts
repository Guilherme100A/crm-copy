// AC-T106-01..05 — módulo Facebook (/facebook): redirect para a sub-rota permitida; estados do Gerenciador (sem
// perfil/contas, nenhuma incluída, carregando/parcial/pronto, limite da Meta com e sem cache, erros por conta);
// cooldown do "Atualizar", ordem das colunas por empresa e rótulos pareados; switch de status otimista com rollback e
// modal de nome/orçamento; Perfis (cartões, toggle de conta otimista, toast do OAuth), Pixel (mascarado, confirmação)
// e o painel de filtros no mobile.
// A Meta é o FakeMetaGraph do harness, semeado por /__e2e/meta/* (contrato em spec/reports/T106-entrega.md); nunca a
// Graph real. Estados transitórios do bundle (carregando/parcial) e falhas de rede pontuais usam page.route.
import { expect, test, type Page, type Route } from '@playwright/test'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed, SEED_PASSWORD, SEED_USERS } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const COMPANY = '00000000-0000-4000-8000-00000000c001'
const DEFAULT_ORDER = [
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
]

async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

interface FakeAccount {
  id: string
  name: string
  currency?: string
}

const ACCOUNTS: FakeAccount[] = [
  { id: 'act_111', name: 'Conta Um', currency: 'BRL' },
  { id: 'act_222', name: 'Conta Dois', currency: 'BRL' },
]

/** Usuário Meta fake (vira o usuário do diálogo OAuth). */
async function metaUser(page: Page, id: string, name: string, accounts: FakeAccount[] = ACCOUNTS) {
  await api(page, 'post', '/__e2e/meta/users', { id, name, ad_accounts: accounts.map((a) => ({ ...a, account_status: 1 })) })
}

/** Conecta o perfil pelo OAuth fake (start → diálogo → callback) sem passar pela tela; devolve o perfil criado. */
async function connectProfile(page: Page, id = 'u1', name = 'Ana Meta', accounts: FakeAccount[] = ACCOUNTS) {
  await metaUser(page, id, name, accounts)
  const { oauth_url } = await api(page, 'post', '/api/meta/oauth/start', {})
  const res = await page.request.get(oauth_url)
  expect(new URL(res.url()).searchParams.get('meta_oauth'), res.url()).toBe('success')
  const { items } = await api(page, 'get', '/api/meta/profiles')
  return (items as Any[]).find((p) => p.fb_user_id === id)
}

const localId = (profile: Any, act: string): string => profile.ad_accounts.find((a: Any) => a.fb_account_id === act).id

async function includeAll(page: Page, profile: Any) {
  for (const a of profile.ad_accounts) await api(page, 'put', `/api/meta/ad-accounts/${a.id}`, { included_in_dashboard: true })
}

/** Estrutura e insights: c1 (ACTIVE) e c2 (ACTIVE) em act_111; c3 (ACTIVE) em act_222; conjuntos e anúncios de c1. */
async function seedManager(page: Page) {
  await api(page, 'post', '/__e2e/meta/structure', {
    account: 'act_111',
    campaigns: [
      { id: 'c1', name: 'Campanha Alfa', effective_status: 'ACTIVE', status: 'ACTIVE', daily_budget: '5000', objective: 'OUTCOME_SALES' },
      { id: 'c2', name: 'Campanha Beta', effective_status: 'ACTIVE', status: 'ACTIVE', daily_budget: '2000', objective: 'OUTCOME_SALES' },
    ],
    adsets: [{ id: 's1', name: 'Conjunto A', campaign_id: 'c1', effective_status: 'ACTIVE', status: 'ACTIVE', daily_budget: '3000' }],
    ads: [{ id: 'ad1', name: 'Anúncio 1', campaign_id: 'c1', adset_id: 's1', effective_status: 'ACTIVE', status: 'ACTIVE' }],
  })
  await api(page, 'post', '/__e2e/meta/insights', {
    account: 'act_111',
    level: 'campaign',
    rows: [
      {
        campaign_id: 'c1',
        spend: '100.50',
        impressions: '1000',
        inline_link_clicks: '30',
        actions: [{ action_type: 'purchase', value: '3' }],
        action_values: [{ action_type: 'purchase', value: '450' }],
      },
    ],
  })
  await api(page, 'post', '/__e2e/meta/structure', {
    account: 'act_222',
    campaigns: [{ id: 'c3', name: 'Campanha Gama', effective_status: 'ACTIVE', status: 'ACTIVE', daily_budget: '1000', objective: 'OUTCOME_SALES' }],
  })
}

/** Owner com perfil, as 2 contas incluídas e a estrutura semeada. */
async function readyManager(page: Page) {
  await loginAs(page, 'owner')
  const profile = await connectProfile(page)
  await includeAll(page, profile)
  await seedManager(page)
  return profile
}

async function openManager(page: Page, query = '') {
  await page.goto(`/facebook/campaigns${query}`)
  await expect(page.getByTestId('page-facebook')).toBeVisible()
}

async function expectTableReady(page: Page) {
  await expect(page.getByTestId('facebook-table')).toBeVisible({ timeout: 45_000 })
  await expect(page.getByTestId('facebook-item-c1')).toBeVisible()
}

const headerOrder = (page: Page) =>
  page.locator('[data-testid="facebook-table"] thead [data-testid^="facebook-col-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('facebook-col-'.length)))

const toast = (page: Page, id: string) => page.getByTestId(id).first()

/** Troca as permissões do membro do seed (owner logado em `page`). */
async function setMemberPerms(page: Page, keys: string[]) {
  const team = await api(page, 'get', '/api/team')
  const m = (team.items ?? team.members ?? team).find((x: Any) => (x.email ?? x.user?.email) === SEED_USERS.member)
  await api(page, 'patch', `/api/team/${m.user_id ?? m.user?.id}`, { permission_keys: keys })
}

/** Envelope do bundle (formato da T101) para os estados transitórios simulados por page.route. */
function envelope(status: string, extra: Record<string, unknown> = {}) {
  return {
    bundle_key: 'bk-e2e',
    status,
    campaign: [],
    adset: [],
    ad: [],
    targets_done: 0,
    targets_total: 2,
    errors: [],
    display_currency: 'BRL',
    since: '2026-10-17',
    until: '2026-10-17',
    status_filter: 'active',
    warnings: [],
    cached: false,
    generated_at: null,
    ...extra,
  }
}

function row(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    status: 'ACTIVE',
    objective: 'OUTCOME_SALES',
    ad_account_id: 'acc-local-1',
    fb_ad_account_id: 'act_111',
    ad_account_label: 'Conta Um',
    currency: 'BRL',
    daily_budget: 50,
    lifetime_budget: null,
    daily_budget_display: 50,
    lifetime_budget_display: null,
    metrics: {
      meta_spend: 10,
      purchase_value_meta: 20,
      purchases_pixel: 1,
      conversations_meta: null,
      meta_link_clicks: 5,
      meta_impressions: 100,
      cost_per_purchase_meta: 10,
      cost_per_lead_meta: null,
      purchase_value_leona: null,
      purchases_leona: null,
    },
    ...extra,
  }
}

// ------------------------------------------------------------------------------------------------ AC-T106-01

test.describe('T106 — sub-rotas', () => {
  test('AC-T106-01 /facebook vai para a primeira sub-rota permitida (owner → campaigns)', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/facebook')
    await expect(page).toHaveURL(/\/facebook\/campaigns(\?|$)/)
    await expect(page.getByTestId('page-facebook')).toBeVisible()
    for (const tab of ['campaigns', 'pixel', 'profiles']) await expect(page.getByTestId(`facebook-tab-${tab}`).filter({ visible: true }).first()).toBeVisible()
  })

  test('AC-T106-01 com só facebook.pixel: /facebook e as sub-rotas proibidas vão para /facebook/pixel', async ({ page }) => {
    await loginAs(page, 'owner')
    await setMemberPerms(page, ['facebook.pixel'])
    await page.context().clearCookies()
    const res = await page.request.post('/api/auth/login', { data: { email: SEED_USERS.member, password: SEED_PASSWORD }, headers: XRW })
    expect(res.status(), await res.text()).toBe(200)

    await page.goto('/facebook')
    await expect(page).toHaveURL(/\/facebook\/pixel(\?|$)/)
    await expect(page.getByTestId('page-facebook')).toBeVisible()
    await expect(page.getByTestId('facebook-pixel-new')).toBeVisible()

    for (const forbidden of ['/facebook/campaigns', '/facebook/profiles']) {
      await page.goto(forbidden)
      await expect(page).toHaveURL(/\/facebook\/pixel(\?|$)/)
    }
    // Abas só das permitidas.
    await expect(page.getByTestId('facebook-tab-pixel').filter({ visible: true }).first()).toBeVisible()
    await expect(page.getByTestId('facebook-tab-campaigns')).toHaveCount(0)
    await expect(page.getByTestId('facebook-tab-profiles')).toHaveCount(0)
  })

  test('AC-T106-01 com só facebook.profiles: /facebook vai para /facebook/profiles', async ({ page }) => {
    await loginAs(page, 'owner')
    await setMemberPerms(page, ['facebook.profiles'])
    await page.context().clearCookies()
    const res = await page.request.post('/api/auth/login', { data: { email: SEED_USERS.member, password: SEED_PASSWORD }, headers: XRW })
    expect(res.status(), await res.text()).toBe(200)
    await page.goto('/facebook')
    await expect(page).toHaveURL(/\/facebook\/profiles(\?|$)/)
    await page.goto('/facebook/pixel')
    await expect(page).toHaveURL(/\/facebook\/profiles(\?|$)/)
  })
})

// ------------------------------------------------------------------------------------------------ AC-T106-02

test.describe('T106 — estados do Gerenciador', () => {
  test('AC-T106-02 sem perfil/contas: estado vazio com CTA para Perfis', async ({ page }) => {
    await loginAs(page, 'owner')
    await openManager(page)
    await expect(page.getByTestId('facebook-empty-profiles')).toBeVisible()
    await expect(page.getByTestId('facebook-table')).toHaveCount(0)
    await page.getByTestId('facebook-cta-profiles').click()
    await expect(page).toHaveURL(/\/facebook\/profiles(\?|$)/)
    await expect(page.getByTestId('facebook-profiles-empty')).toBeVisible()
  })

  test('AC-T106-02 perfil com contas mas nenhuma incluída: estado próprio com CTA', async ({ page }) => {
    await loginAs(page, 'owner')
    await connectProfile(page)
    await openManager(page)
    await expect(page.getByTestId('facebook-empty-included')).toBeVisible()
    await expect(page.getByTestId('facebook-empty-profiles')).toHaveCount(0)
    await expect(page.getByTestId('facebook-cta-profiles')).toBeVisible()
  })

  test('AC-T106-02 pronto: tabela com as linhas, valores formatados e totais', async ({ page }) => {
    await readyManager(page)
    await openManager(page)
    await expectTableReady(page)
    await expect(page.getByTestId('facebook-item-c2')).toBeVisible()
    await expect(page.getByTestId('facebook-item-c3')).toBeVisible()
    await expect(page.getByTestId('facebook-item-name-c1')).toHaveText('Campanha Alfa')
    await expect(page.getByTestId('facebook-item-meta_spend-c1')).toContainText('100,50')
    await expect(page.getByTestId('facebook-item-revenue_pair-c1')).toContainText('450,00')
    await expect(page.getByTestId('facebook-item-budget-c1')).toContainText('50,00')
    await expect(page.getByTestId('facebook-totals')).toBeVisible()
    await expect(page.getByTestId('facebook-total-meta_spend')).toContainText('100,50')
    await expect(page.getByTestId('facebook-loading')).toHaveCount(0)
    await expect(page.getByTestId('facebook-partial')).toHaveCount(0)
    await expect(page.getByTestId('facebook-level-count-campaign')).toHaveText('3')
  })

  test('AC-T106-02 carregando (progresso) → parcial (com dados) → pronto', async ({ page }) => {
    await readyManager(page)
    let phase: 'loading' | 'partial' | 'real' = 'loading'
    await page.route('**/api/meta/structure-bundle**', async (route: Route) => {
      if (phase === 'real') return route.continue()
      const body =
        phase === 'loading'
          ? envelope('loading', { targets_done: 0, targets_total: 2 })
          : envelope('partial', { targets_done: 1, targets_total: 2, campaign: [row('p1', 'Parcial Um')] })
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await openManager(page)
    await expect(page.getByTestId('facebook-loading')).toBeVisible()
    await expect(page.getByTestId('facebook-progress')).toContainText('0 de 2')
    await expect(page.getByTestId('facebook-table')).toHaveCount(0)

    phase = 'partial'
    await expect(page.getByTestId('facebook-partial')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('facebook-partial')).toContainText('1 de 2')
    await expect(page.getByTestId('facebook-item-p1')).toBeVisible()
    await expect(page.getByTestId('facebook-loading')).toHaveCount(0)

    phase = 'real'
    await expectTableReady(page)
    await expect(page.getByTestId('facebook-partial')).toHaveCount(0)
    await expect(page.getByTestId('facebook-item-p1')).toHaveCount(0)
  })

  test('AC-T106-02 limite da Meta com dados em cache: aviso e dados atuais visíveis', async ({ page }) => {
    await readyManager(page)
    await openManager(page)
    await expectTableReady(page)
    await api(page, 'post', '/__e2e/meta/usage', { account: '*', usage: 95, regain_minutes: 5 })
    await page.getByTestId('facebook-refresh').click()
    await expect(page.getByTestId('facebook-rate-limited')).toBeVisible({ timeout: 45_000 })
    await expect(page.getByTestId('facebook-item-c1')).toBeVisible()
    await expect(page.getByTestId('facebook-item-meta_spend-c1')).toContainText('100,50')
    await expect(page.getByTestId('facebook-rate-limited-error')).toHaveCount(0)
  })

  test('AC-T106-02 limite da Meta sem cache: erro próprio, sem tabela', async ({ page }) => {
    await readyManager(page)
    await api(page, 'post', '/__e2e/meta/usage', { account: '*', usage: 95, regain_minutes: 5 })
    await openManager(page)
    await expect(page.getByTestId('facebook-rate-limited-error')).toBeVisible({ timeout: 45_000 })
    await expect(page.getByTestId('facebook-table')).toHaveCount(0)
  })

  test('AC-T106-02 erro de uma conta: banner com a conta, toast "<conta>: <erro>" e as outras contas na tabela', async ({ page }) => {
    const profile = await readyManager(page)
    await api(page, 'post', '/__e2e/meta/fail-account', { account: 'act_222', status: 400, error: { message: 'Conta bloqueada no fake', type: 'OAuthException', code: 100 } })
    await openManager(page)
    await expectTableReady(page)
    const banner = page.getByTestId('facebook-account-errors')
    await expect(banner).toBeVisible()
    const item = page.getByTestId(`facebook-account-error-${localId(profile, 'act_222')}`)
    await expect(item).toContainText('Conta Dois')
    await expect(page.getByTestId(`facebook-account-error-${localId(profile, 'act_111')}`)).toHaveCount(0)
    await expect(toast(page, 'facebook-account-errors-toast')).toContainText('Conta Dois:')
    await expect(page.getByTestId('facebook-item-c3')).toHaveCount(0)
  })

  test('AC-T106-02 erro em várias contas: toast com a contagem', async ({ page }) => {
    const profile = await readyManager(page)
    for (const account of ['act_111', 'act_222']) await api(page, 'post', '/__e2e/meta/fail-account', { account, status: 400 })
    await openManager(page)
    await expect(page.getByTestId('facebook-account-errors')).toBeVisible({ timeout: 45_000 })
    for (const act of ['act_111', 'act_222']) await expect(page.getByTestId(`facebook-account-error-${localId(profile, act)}`)).toBeVisible()
    await expect(toast(page, 'facebook-account-errors-toast')).toContainText('2 conta(s)')
  })
})

// ------------------------------------------------------------------------------------------------ AC-T106-03

test.describe('T106 — atualizar e colunas', () => {
  test('AC-T106-03 "Atualizar" manda force_refresh=1 e fica desabilitado por 30 s', async ({ page }) => {
    await page.clock.install()
    await readyManager(page)
    await openManager(page)
    await expectTableReady(page)
    const refresh = page.getByTestId('facebook-refresh')
    await expect(refresh).toBeEnabled()
    await expect(page.getByTestId('facebook-updated-ago')).toBeVisible()

    const forced = page.waitForRequest((r) => r.url().includes('/api/meta/structure-bundle') && new URL(r.url()).searchParams.get('force_refresh') === '1')
    await refresh.click()
    await forced
    await expect(refresh).toBeDisabled()
    await expect(refresh).toContainText(/\(\d+s\)/)

    await page.clock.runFor(20_000)
    await expect(refresh).toBeDisabled()
    await page.clock.runFor(8_000)
    await expect(refresh).toBeDisabled()
    await page.clock.runFor(3_000)
    await expect(refresh).toBeEnabled()
    await expect(refresh).not.toContainText(/\(\d+s\)/)
  })

  test('AC-T106-03 ordem das colunas persiste por empresa e "Restaurar" volta ao padrão', async ({ page }) => {
    await readyManager(page)
    // Uma ordem salva para OUTRA empresa não vale para esta.
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem('t106-seeded')) {
          localStorage.setItem('facebook.columns.v1:outra-empresa', JSON.stringify(['meta_impressions', 'meta_link_clicks']))
          sessionStorage.setItem('t106-seeded', '1')
        }
      } catch {
        /* sem storage */
      }
    })
    await openManager(page)
    await expectTableReady(page)
    expect(await headerOrder(page)).toEqual(DEFAULT_ORDER)

    await page.getByTestId('facebook-columns').click()
    await expect(page.getByTestId('facebook-columns-popup')).toBeVisible()
    await expect(page.getByTestId('facebook-columns-reset')).toBeDisabled()
    await page.getByTestId('facebook-column-down-meta_spend').click()
    await page.getByTestId('facebook-column-up-meta_impressions').click()
    const moved = ['revenue_pair', 'meta_spend', ...DEFAULT_ORDER.slice(2, 8), 'meta_impressions', 'meta_link_clicks']
    await expect.poll(() => headerOrder(page)).toEqual(moved)
    await page.keyboard.press('Escape')

    const stored = await page.evaluate((k) => localStorage.getItem(k), `facebook.columns.v1:${COMPANY}`)
    expect(JSON.parse(stored ?? '[]')).toEqual(moved)

    await page.reload()
    await expectTableReady(page)
    expect(await headerOrder(page)).toEqual(moved)

    await page.getByTestId('facebook-columns').click()
    await page.getByTestId('facebook-columns-reset').click()
    await expect.poll(() => headerOrder(page)).toEqual(DEFAULT_ORDER)
    await expect(page.getByTestId('facebook-columns-reset')).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.reload()
    await expectTableReady(page)
    expect(await headerOrder(page)).toEqual(DEFAULT_ORDER)
  })

  test('AC-T106-03 arrastar o cabeçalho reordena as colunas no desktop', async ({ page }) => {
    await readyManager(page)
    await openManager(page)
    await expectTableReady(page)
    // Colunas à esquerda (as últimas ficam fora da viewport, dentro da rolagem da tabela).
    await page.getByTestId('facebook-col-profit_pair').dragTo(page.getByTestId('facebook-col-meta_spend'))
    await expect.poll(async () => (await headerOrder(page)).indexOf('profit_pair')).toBeLessThan(2)
    const after = await headerOrder(page)
    await page.reload()
    await expectTableReady(page)
    expect(await headerOrder(page)).toEqual(after)
  })

  test('AC-T106-03 métricas pareadas rotuladas "<APP_NAME> / Meta" (e "/ Pixel" nas compras), sem a marca de referência', async ({ page }) => {
    await readyManager(page)
    await openManager(page)
    await expectTableReady(page)
    await expect(page.getByTestId('facebook-col-revenue_pair')).toContainText('(CRM / Meta)')
    await expect(page.getByTestId('facebook-col-profit_pair')).toContainText('(CRM / Meta)')
    await expect(page.getByTestId('facebook-col-roas_pair')).toContainText('(CRM / Meta)')
    await expect(page.getByTestId('facebook-col-purchases')).toContainText('(CRM / Pixel)')
    await expect(page.getByTestId('facebook-col-meta_spend')).not.toContainText('/')
    // Par "interno / Meta". Sem venda interna: "—" (sem a T105) ou "R$ 0,00" (com a T105, que preenche 0).
    await expect(page.getByTestId('facebook-item-revenue_pair-c1')).toContainText(/(—|R\$\s*0,00)\s*\/\s*R\$\s*450,00/)
    await expect(page.getByTestId('facebook-metrics-hint')).toContainText('CRM / Meta')
    expect(await page.locator('body').innerText()).not.toMatch(/leona/i)
  })
})

// ------------------------------------------------------------------------------------------------ AC-T106-04

test.describe('T106 — status e edição', () => {
  test('AC-T106-04 switch de status é otimista, bloqueia outra edição e confirma na Meta', async ({ page }) => {
    await readyManager(page)
    await openManager(page)
    await expectTableReady(page)
    // Segura o PATCH para observar o estado otimista antes da resposta.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await page.route('**/api/meta/structure-entities/**', async (route) => {
      await held
      await route.continue()
    })
    const sw = page.getByTestId('facebook-item-status-c1')
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('facebook-item-status-label-c1')).toHaveAttribute('data-status', 'PAUSED')
    await expect(page.getByTestId('facebook-item-status-c2')).toBeDisabled()
    await expect(page.getByTestId('facebook-item-edit-c2')).toBeDisabled()
    release()
    await expect(toast(page, 'facebook-status-updated')).toBeVisible()
    await expect(page.getByTestId('facebook-item-status-c2')).toBeEnabled()
    const { items } = await api(page, 'get', '/__e2e/meta/mutations')
    expect((items as Any[]).find((m) => m.entityId === 'c1')?.fields?.status).toBe('PAUSED')
    // Não volta para ativo. Com o filtro padrão "Ativo", a releitura pode tirar a c1 (pausada) da lista.
    await expect
      .poll(async () => ((await sw.count()) === 0 ? 'fora' : await sw.getAttribute('aria-checked')))
      .toMatch(/^(false|fora)$/)
  })

  test('AC-T106-04 switch de status desfaz em erro da Meta, com toast', async ({ page }) => {
    await readyManager(page)
    await openManager(page)
    await expectTableReady(page)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await page.route('**/api/meta/structure-entities/**', async (route) => {
      await held
      await route.continue()
    })
    await api(page, 'post', '/__e2e/meta/fail-next', { status: 500, error: { message: 'Falha simulada', type: 'OAuthException', code: 2 } })
    const sw = page.getByTestId('facebook-item-status-c1')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    release()
    await expect(toast(page, 'facebook-status-error')).toBeVisible()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('facebook-item-status-label-c1')).toHaveAttribute('data-status', 'ACTIVE')
    await expect(page.getByTestId('facebook-item-status-c2')).toBeEnabled()
    const { items } = await api(page, 'get', '/__e2e/meta/mutations')
    expect((items as Any[]).filter((m) => m.entityId === 'c1')).toHaveLength(0)
  })

  test('AC-T106-04 modal de campanha: nome e orçamento (vírgula decimal) chegam à Meta', async ({ page }) => {
    await readyManager(page)
    await openManager(page)
    await expectTableReady(page)
    await page.getByTestId('facebook-item-edit-c1').click()
    const dialog = page.getByTestId('facebook-edit-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('facebook-edit-mode-name')).toBeVisible()
    await expect(page.getByTestId('facebook-edit-name')).toHaveValue('Campanha Alfa')
    await page.getByTestId('facebook-edit-mode-budget').click()
    await expect(page.getByTestId('facebook-edit-name')).toHaveCount(0)
    await page.getByTestId('facebook-edit-daily').fill('75,5')
    await page.getByTestId('facebook-edit-save').click()
    await expect(toast(page, 'facebook-edit-saved')).toBeVisible()
    await expect(dialog).toHaveCount(0)
    const { items } = await api(page, 'get', '/__e2e/meta/mutations')
    const m = (items as Any[]).find((x) => x.entityId === 'c1')
    expect(m?.fields?.daily_budget).toBe('7550')
    expect(m?.fields?.name).toBeUndefined()
  })

  test('AC-T106-04 modal de anúncio não tem campo nome (nem salvar)', async ({ page }) => {
    await readyManager(page)
    await openManager(page, '?fb_level=ad')
    await expect(page.getByTestId('facebook-item-ad1')).toBeVisible({ timeout: 45_000 })
    await page.getByTestId('facebook-item-edit-ad1').click()
    await expect(page.getByTestId('facebook-edit-dialog')).toBeVisible()
    await expect(page.getByTestId('facebook-edit-name')).toHaveCount(0)
    await expect(page.getByTestId('facebook-edit-mode-name')).toHaveCount(0)
    await expect(page.getByTestId('facebook-edit-ad-hint')).toBeVisible()
    await expect(page.getByTestId('facebook-edit-save')).toBeDisabled()
    await page.getByTestId('facebook-edit-cancel').click()
    await expect(page.getByTestId('facebook-edit-dialog')).toHaveCount(0)

    // Conjunto, ao contrário, edita o nome.
    await page.getByTestId('facebook-level-adset').click()
    await expect(page.getByTestId('facebook-item-s1')).toBeVisible({ timeout: 45_000 })
    await page.getByTestId('facebook-item-edit-s1').click()
    await expect(page.getByTestId('facebook-edit-name')).toHaveValue('Conjunto A')
  })
})

// ------------------------------------------------------------------------------------------------ AC-T106-05

test.describe('T106 — perfis, pixel e mobile', () => {
  test('AC-T106-05 perfis: cartões expansíveis (1 perfil abre expandido; vários fecham)', async ({ page }) => {
    await loginAs(page, 'owner')
    const p1 = await connectProfile(page, 'u1', 'Ana Meta')
    await page.goto('/facebook/profiles')
    const card1 = page.getByTestId(`facebook-profile-${p1.id}`)
    await expect(card1).toHaveAttribute('data-expanded', 'true')
    await expect(page.getByTestId(`facebook-profile-accounts-${p1.id}`)).toBeVisible()
    await expect(page.getByTestId(`facebook-account-${localId(p1, 'act_111')}`)).toBeVisible()
    await expect(page.getByTestId(`facebook-profile-count-${p1.id}`)).toContainText('0 de 2')

    await page.getByTestId(`facebook-profile-toggle-${p1.id}`).click()
    await expect(card1).toHaveAttribute('data-expanded', 'false')
    await expect(page.getByTestId(`facebook-profile-toggle-${p1.id}`)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId(`facebook-profile-accounts-${p1.id}`)).toHaveCount(0)

    const p2 = await connectProfile(page, 'u2', 'Bruno Meta', [{ id: 'act_333', name: 'Conta Três', currency: 'USD' }])
    await page.reload()
    await expect(page.getByTestId(`facebook-profile-${p1.id}`)).toHaveAttribute('data-expanded', 'false')
    await expect(page.getByTestId(`facebook-profile-${p2.id}`)).toHaveAttribute('data-expanded', 'false')
    await page.getByTestId(`facebook-profile-toggle-${p2.id}`).click()
    await expect(page.getByTestId(`facebook-profile-${p2.id}`)).toHaveAttribute('data-expanded', 'true')
    await expect(page.getByTestId(`facebook-account-${localId(p2, 'act_333')}`)).toBeVisible()
    await expect(page.getByTestId(`facebook-profile-${p1.id}`)).toHaveAttribute('data-expanded', 'false')
  })

  test('AC-T106-05 toggle de conta: otimista ao incluir e rollback com toast em erro', async ({ page }) => {
    await loginAs(page, 'owner')
    const p = await connectProfile(page)
    const a1 = localId(p, 'act_111')
    const a2 = localId(p, 'act_222')
    await page.goto('/facebook/profiles')
    await expect(page.getByTestId(`facebook-account-toggle-${a1}`)).not.toBeChecked()

    let mode: 'hold-ok' | 'hold-fail' = 'hold-ok'
    let release!: () => void
    let held = new Promise<void>((r) => (release = r))
    await page.route('**/api/meta/ad-accounts/**', async (route) => {
      await held
      if (mode === 'hold-fail') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Falha simulada' } }) })
      return route.continue()
    })

    // Sucesso: marca na hora, antes da resposta; confirma no servidor.
    await page.getByTestId(`facebook-account-toggle-${a1}`).click()
    await expect(page.getByTestId(`facebook-account-toggle-${a1}`)).toBeChecked()
    await expect(page.getByTestId(`facebook-account-included-${a1}`)).toBeVisible()
    release()
    await expect(page.getByTestId(`facebook-profile-count-${p.id}`)).toContainText('1 de 2')
    await expect.poll(async () => (await api(page, 'get', '/api/meta/profiles')).items[0].ad_accounts.find((a: Any) => a.id === a1).included_in_dashboard).toBe(true)

    // Erro: marca na hora e volta ao estado anterior com toast.
    mode = 'hold-fail'
    held = new Promise<void>((r) => (release = r))
    await page.getByTestId(`facebook-account-toggle-${a2}`).click()
    await expect(page.getByTestId(`facebook-account-toggle-${a2}`)).toBeChecked()
    release()
    await expect(toast(page, 'facebook-account-toggle-error')).toBeVisible()
    await expect(page.getByTestId(`facebook-account-toggle-${a2}`)).not.toBeChecked()
    await expect(page.getByTestId(`facebook-account-included-${a2}`)).toHaveCount(0)
    await expect(page.getByTestId(`facebook-profile-count-${p.id}`)).toContainText('1 de 2')
    await expect(page.getByTestId(`facebook-account-toggle-${a1}`)).toBeChecked()
  })

  test('AC-T106-05 toast do retorno do OAuth (sucesso pelo botão Conectar) e a URL fica limpa', async ({ page }) => {
    await loginAs(page, 'owner')
    await metaUser(page, 'u1', 'Ana Meta')
    await page.goto('/facebook/profiles')
    await expect(page.getByTestId('facebook-profiles-empty')).toBeVisible()
    await page.getByTestId('facebook-profiles-connect').click()
    await expect(toast(page, 'facebook-oauth-success')).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/facebook\/profiles$/)
    await expect(page.locator('[data-testid^="facebook-profile-name-"]')).toHaveText(['Ana Meta'])
  })

  test('AC-T106-05 toast do retorno do OAuth com erro mostra a mensagem e limpa a URL', async ({ page }) => {
    await loginAs(page, 'owner')
    await metaUser(page, 'u1', 'Ana Meta')
    await api(page, 'post', '/__e2e/meta/oauth', { error: 'Permissão negada no fake' })
    await page.goto('/facebook/profiles')
    await page.getByTestId('facebook-profiles-connect').click()
    const t = toast(page, 'facebook-oauth-error')
    await expect(t).toBeVisible({ timeout: 30_000 })
    await expect(t).toContainText('Permissão negada no fake')
    await expect(page).toHaveURL(/\/facebook\/profiles$/)
    await expect(page.getByTestId('facebook-profiles-empty')).toBeVisible()

    // Retorno direto pela URL (o callback sempre volta assim).
    await page.goto('/facebook/profiles?meta_oauth=error&meta_message=Token%20expirado')
    await expect(toast(page, 'facebook-oauth-error')).toContainText('Token expirado')
    await expect(page).toHaveURL(/\/facebook\/profiles$/)
  })

  test('AC-T106-05 pixel: Pixel ID e token mascarados; excluir pede confirmação', async ({ page }) => {
    await loginAs(page, 'owner')
    const PIXEL = '123456789012345'
    const TOKEN = 'EAABsecretoTokenDoPixel987654321'
    const { pixel } = await api(page, 'post', '/api/meta/pixels', { name: 'Pixel Loja', pixel_id: PIXEL, access_token: TOKEN, platform: 'facebook', auto_send_sales: false })
    await page.goto('/facebook/pixel')
    await expect(page.getByTestId(isMobile(page) ? 'facebook-pixel-cards' : 'facebook-pixel-table')).toBeVisible()
    const item = page.getByTestId(`facebook-pixel-item-${pixel.id}`)
    await expect(item).toContainText('Pixel Loja')
    const pid = page.getByTestId(`facebook-pixel-item-pixel-id-${pixel.id}`)
    const tok = page.getByTestId(`facebook-pixel-item-token-${pixel.id}`)
    await expect(pid).toBeVisible()
    await expect(tok).toBeVisible()
    expect(await pid.innerText()).not.toContain(PIXEL)
    expect(await tok.innerText()).not.toContain(TOKEN)
    expect(await tok.innerText()).not.toContain('secreto')
    expect(await page.locator('body').innerText()).not.toContain(TOKEN)

    // Cancelar mantém; confirmar exclui.
    await page.getByTestId(`facebook-pixel-item-delete-${pixel.id}`).click()
    await expect(page.getByTestId('facebook-pixel-confirm')).toBeVisible()
    await page.getByTestId('facebook-pixel-confirm-cancel').click()
    await expect(page.getByTestId('facebook-pixel-confirm')).toHaveCount(0)
    await expect(item).toBeVisible()
    expect((await api(page, 'get', '/api/meta/pixels')).items).toHaveLength(1)

    await page.getByTestId(`facebook-pixel-item-delete-${pixel.id}`).click()
    await page.getByTestId('facebook-pixel-confirm-ok').click()
    await expect(toast(page, 'facebook-pixel-deleted')).toBeVisible()
    await expect(item).toHaveCount(0)
    await expect(page.getByTestId('facebook-pixel-empty')).toBeVisible()
    expect((await api(page, 'get', '/api/meta/pixels')).items).toHaveLength(0)
    if (isMobile(page)) await expectNoHorizontalScroll(page)
  })

  test('AC-T106-05 filtros de status e nome: painel no mobile, inline no desktop', async ({ page }) => {
    await readyManager(page)
    await openManager(page)
    await expect(page.getByTestId('facebook-item-c1')).toBeVisible({ timeout: 45_000 })
    if (isMobile(page)) {
      await expect(page.getByTestId('facebook-cards')).toBeVisible()
      await expect(page.getByTestId('facebook-table')).toHaveCount(0)
      await expect(page.getByTestId('facebook-filter-status')).toHaveCount(0)
      await expect(page.getByTestId('facebook-filter-name')).toHaveCount(0)
      await page.getByTestId('facebook-filters-open').click()
      const panel = page.getByTestId('facebook-filters-panel')
      await expect(panel).toBeVisible()
      await expect(panel.getByTestId('facebook-filter-status')).toBeVisible()
      await panel.getByTestId('facebook-filter-name').fill('Beta')
      await expect(page).toHaveURL(/[?&]fb_q=Beta/)
      await panel.getByTestId('facebook-filter-status').selectOption('all')
      await expect(page).toHaveURL(/[?&]fb_status=all/)
      await page.getByTestId('facebook-filters-close').click()
      await expect(panel).toHaveCount(0)
      await expect(page.getByTestId('facebook-item-c2')).toBeVisible()
      await expect(page.getByTestId('facebook-item-c1')).toHaveCount(0)
      await expectNoHorizontalScroll(page)
    } else {
      await expect(page.getByTestId('facebook-table')).toBeVisible()
      await expect(page.getByTestId('facebook-filters-open')).toHaveCount(0)
      await expect(page.getByTestId('facebook-filter-status')).toBeVisible()
      await page.getByTestId('facebook-filter-name').fill('Beta')
      await expect(page).toHaveURL(/[?&]fb_q=Beta/)
      await expect(page.getByTestId('facebook-item-c2')).toBeVisible()
      await expect(page.getByTestId('facebook-item-c1')).toHaveCount(0)
      await page.getByTestId('facebook-filter-status').selectOption('all')
      await expect(page).toHaveURL(/[?&]fb_status=all/)
      expect(new URL(page.url()).searchParams.has('status')).toBe(false)
    }
  })

  test('AC-T106-05 perfis e pixel sem rolagem horizontal (layout responsivo)', async ({ page }) => {
    await loginAs(page, 'owner')
    await connectProfile(page)
    await page.goto('/facebook/profiles')
    await expect(page.locator('[data-testid^="facebook-profile-accounts-"]')).toBeVisible()
    await expectNoHorizontalScroll(page)
    await page.goto('/facebook/pixel')
    await expect(page.getByTestId('facebook-pixel-empty')).toBeVisible()
    await expectNoHorizontalScroll(page)
  })
})
