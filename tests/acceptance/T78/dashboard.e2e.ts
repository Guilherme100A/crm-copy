// AC-T78-01..04 — dashboard de vendas (/welcome): período/filtros na URL e "Atualizar", KPIs com tendência e lucro
// negativo, gráficos vazios, grupos de filtro, saudação no fuso da empresa, marcos e aba sem dashboard.sales.
// Contrato de data-testid combinado com o Torno; massa pela API (T34/T40/T55).
import { expect, test, type Browser, type Page, type Request } from '@playwright/test'
import { isMobile, loginAs, resetSeed, SEED_USERS } from '../helpers/e2e'
import { createConnection, newChat, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const TZ = 'America/Sao_Paulo'
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

/** Data local YYYY-MM-DD no fuso, com deslocamento em dias. */
const day = (offset = 0, base = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(base + offset * 86_400_000))
const firstOfMonth = () => `${day().slice(0, 8)}01`

const params = (page: Page) => new URL(page.url()).searchParams
const isDashReq = (r: Request) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/dashboard'

async function sale(page: Page, amountCents: number, soldAt: Date, extra: Record<string, unknown> = {}) {
  return api(page, 'post', '/api/sales', { amount_cents: amountCents, currency: 'BRL', sold_at: soldAt.toISOString(), status: 'approved', ...extra })
}

async function product(page: Page) {
  const body = await api(page, 'post', '/api/products', { name: `Curso ${uniq()}`, currency: 'BRL', price_min_cents: 1_000, price_max_cents: 100_000, price_fallback_cents: 5_000 })
  return body.product.id as string
}

async function openDashboard(page: Page, qs = '') {
  await page.goto(`/welcome${qs}`)
  await expect(page.getByTestId('page-welcome')).toBeVisible()
  await expect(page.getByTestId('dashboard-sales')).toBeVisible()
}

test.describe('T78 — período, filtros e atualizar', () => {
  test('AC-T78-01 presets (hoje, ontem, 7 dias = hoje−6..hoje, 30 dias, este mês) vão para a URL e para a API', async ({ page }) => {
    await loginAs(page, 'owner')
    await openDashboard(page)
    const cases: Array<[string, string, string]> = [
      ['yesterday', day(-1), day(-1)],
      ['7d', day(-6), day(0)],
      ['30d', day(-29), day(0)],
      ['month', firstOfMonth(), day(0)],
      ['today', day(0), day(0)],
    ]
    for (const [preset, start, end] of cases) {
      const req = page.waitForRequest((r) => isDashReq(r) && new URL(r.url()).searchParams.get('start_date') === start && new URL(r.url()).searchParams.get('end_date') === end)
      await page.getByTestId(`dashboard-preset-${preset}`).click()
      await req
      await expect(page.getByTestId(`dashboard-preset-${preset}`)).toHaveAttribute('aria-pressed', 'true')
      if (preset !== 'today') expect(params(page).get('preset')).toBe(preset)
    }
  })

  test('AC-T78-01 personalizado vai para a URL, sobrevive ao reload e recusa intervalo maior que 366 dias', async ({ page }) => {
    await loginAs(page, 'owner')
    await openDashboard(page)
    await page.getByTestId('dashboard-preset-custom').click()
    await page.getByTestId('dashboard-custom-start').fill(day(-10))
    await page.getByTestId('dashboard-custom-end').fill(day(-3))
    const req = page.waitForRequest((r) => isDashReq(r) && new URL(r.url()).searchParams.get('start_date') === day(-10))
    await page.getByTestId('dashboard-custom-apply').click()
    expect(new URL((await req).url()).searchParams.get('end_date')).toBe(day(-3))
    expect(params(page).get('preset')).toBe('custom')
    expect(params(page).get('start_date')).toBe(day(-10))
    expect(params(page).get('end_date')).toBe(day(-3))

    const again = page.waitForRequest((r) => isDashReq(r) && new URL(r.url()).searchParams.get('start_date') === day(-10))
    await page.reload()
    await again
    await expect(page.getByTestId('dashboard-preset-custom')).toHaveAttribute('aria-pressed', 'true')

    await page.getByTestId('dashboard-preset-custom').click()
    await page.getByTestId('dashboard-custom-start').fill(day(-400))
    await page.getByTestId('dashboard-custom-end').fill(day(0))
    await page.getByTestId('dashboard-custom-apply').click()
    await expect(page.getByTestId('dashboard-custom-error')).toBeVisible()
    expect(params(page).get('start_date')).toBe(day(-10))
  })

  test('AC-T78-01 conexões e produtos vão para a URL e para a API; reload mantém', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const prod = await product(page)
    await openDashboard(page)
    await page.getByTestId('dashboard-connections').click()
    let req = page.waitForRequest((r) => isDashReq(r) && (new URL(r.url()).searchParams.get('connection_ids') ?? '').includes(conn.id))
    await page.getByTestId(`dashboard-connection-option-${conn.id}`).check()
    await req
    await page.keyboard.press('Escape')
    await page.getByTestId('dashboard-products').click()
    req = page.waitForRequest((r) => isDashReq(r) && (new URL(r.url()).searchParams.get('product_ids') ?? '').includes(prod))
    await page.getByTestId(`dashboard-product-option-${prod}`).check()
    await req
    await page.keyboard.press('Escape')
    expect(params(page).get('connection_ids') ?? '').toContain(conn.id)
    expect(params(page).get('product_ids') ?? '').toContain(prod)
    await expect(page.getByTestId('dashboard-connections')).toContainText(/1 selecionad/)

    const both = page.waitForRequest((r) => isDashReq(r) && (new URL(r.url()).searchParams.get('connection_ids') ?? '').includes(conn.id) && (new URL(r.url()).searchParams.get('product_ids') ?? '').includes(prod))
    await page.reload()
    await both
    await page.getByTestId('dashboard-clear').click()
    expect(params(page).get('connection_ids')).toBeNull()
  })

  test('AC-T78-01 "Atualizar" força o recálculo e mostra "Última atualização"', async ({ page }) => {
    await loginAs(page, 'owner')
    await openDashboard(page)
    await expect(page.getByTestId('dashboard-last-updated')).toHaveText(/Última atualização: \d{2}:\d{2}/)
    const req = page.waitForRequest((r) => isDashReq(r) && new URL(r.url()).searchParams.get('force_refresh') === '1')
    const res = page.waitForResponse((r) => isDashReq(r.request()) && new URL(r.url()).searchParams.get('force_refresh') === '1')
    await page.getByTestId('dashboard-refresh').click()
    await req
    const body = await (await res).json()
    const computed = body.sales?.computed_at ?? body.computed_at
    expect(computed, JSON.stringify(body).slice(0, 300)).toBeTruthy()
    await expect(page.getByTestId('dashboard-last-updated')).toHaveAttribute('data-computed-at', computed)
  })
})

test.describe('T78 — KPIs e gráficos', () => {
  test('AC-T78-02 KPIs com tendência (verde/vermelho, invertida em despesas) e lucro negativo destacado', async ({ page }) => {
    await loginAs(page, 'owner')
    const now = Date.now()
    // ontem: 1 venda de R$ 100,00; hoje: 2 vendas de R$ 100,00
    await sale(page, 10_000, new Date(now - 86_400_000))
    await sale(page, 10_000, new Date(now - 60_000))
    await sale(page, 10_000, new Date(now - 120_000))
    // despesas: diária fixa sempre ativa (R$ 1.000,00) + outra só a partir de hoje (R$ 500,00) → despesas sobem
    await api(page, 'post', '/api/sales/expense-rules', { name: 'Equipe', kind: 'fixed', amount_cents: 100_000, period: 'day' })
    await api(page, 'post', '/api/sales/expense-rules', { name: 'Ferramenta', kind: 'fixed', amount_cents: 50_000, period: 'day', active_from: day(0) })
    await openDashboard(page)

    await expect(page.getByTestId('dashboard-kpi-revenue-value')).toHaveText('R$ 200,00')
    await expect(page.getByTestId('dashboard-kpi-sales_count-value')).toHaveText('2')
    await expect(page.getByTestId('dashboard-kpi-avg_ticket-value')).toHaveText('R$ 100,00')
    await expect(page.getByTestId('dashboard-kpi-roas-value')).toHaveText('—')

    const revTrend = page.getByTestId('dashboard-kpi-revenue-trend')
    await expect(revTrend).toHaveAttribute('data-trend', 'up')
    await expect(revTrend).toHaveAttribute('data-good', 'true')
    await expect(revTrend).toHaveText('+100,0%')
    // despesas subiram: em "menor é melhor", subir é ruim (vermelho)
    const expTrend = page.getByTestId('dashboard-kpi-expenses-trend')
    await expect(expTrend).toHaveAttribute('data-trend', 'up')
    await expect(expTrend).toHaveAttribute('data-good', 'false')
    expect(await expTrend.evaluate((el) => getComputedStyle(el).color)).not.toBe(await revTrend.evaluate((el) => getComputedStyle(el).color))

    // lucro = 200,00 − 1.500,00 → negativo destacado
    await expect(page.getByTestId('dashboard-kpi-profit')).toHaveAttribute('data-negative', 'true')
    // dinheiro negativo com hífen ASCII (o U+2212 só aparece no texto da tendência)
    await expect(page.getByTestId('dashboard-kpi-profit-value')).toHaveText('-R$ 1.300,00')
    await expect(page.getByTestId('dashboard-kpi-revenue')).not.toHaveAttribute('data-negative', 'true')
  })

  test('AC-T78-02 tendência neutra quando o período anterior é zero', async ({ page }) => {
    await loginAs(page, 'owner')
    await sale(page, 5_000, new Date(Date.now() - 60_000))
    await openDashboard(page)
    const trend = page.getByTestId('dashboard-kpi-revenue-trend')
    await expect(trend).toHaveAttribute('data-trend', 'neutral')
    await expect(trend).toHaveText('—')
    expect(await trend.getAttribute('data-good')).toBeNull()
  })

  test('AC-T78-02 gráficos mostram estado vazio sem vendas no período', async ({ page }) => {
    await loginAs(page, 'owner')
    await sale(page, 10_000, new Date(Date.now() - 60_000))
    await openDashboard(page, `?preset=custom&start_date=${day(-40)}&end_date=${day(-35)}`)
    for (const id of ['over-time', 'by-hour', 'by-connection', 'by-state', 'by-product'])
      await expect(page.getByTestId(`dashboard-chart-${id}-empty`), id).toBeVisible()
    // hoje (com venda) os gráficos têm dados
    await page.getByTestId('dashboard-preset-today').click()
    await expect(page.getByTestId('dashboard-chart-over-time')).toBeVisible()
    await expect(page.getByTestId('dashboard-chart-over-time-empty')).toHaveCount(0)
  })
})

test.describe('T78 — grupos de filtro', () => {
  test('AC-T78-03 criar, aplicar e excluir grupo de filtro', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const prod = await product(page)
    await openDashboard(page)
    await page.getByTestId('dashboard-connections').click()
    await page.getByTestId(`dashboard-connection-option-${conn.id}`).check()
    await page.keyboard.press('Escape')
    await page.getByTestId('dashboard-products').click()
    await page.getByTestId(`dashboard-product-option-${prod}`).check()
    await page.keyboard.press('Escape')

    await page.getByTestId('dashboard-group-save').click()
    const modal = page.getByTestId('dashboard-group-modal')
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('1 conex')
    const name = `Lançamento ${uniq()}`
    await page.getByTestId('dashboard-group-name').fill(name)
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sales/filter-groups')
    await page.getByTestId('dashboard-group-modal-save').click()
    const res = await post
    expect(JSON.parse(res.request().postData() ?? '{}')).toMatchObject({ name, connection_ids: [conn.id], product_ids: [prod] })
    const groupId = (await res.json()).filter_group.id as string

    // limpa e aplica o grupo
    await page.getByTestId('dashboard-clear').click()
    expect(params(page).get('connection_ids')).toBeNull()
    await page.getByTestId('dashboard-groups').click()
    const req = page.waitForRequest((r) => isDashReq(r) && (new URL(r.url()).searchParams.get('connection_ids') ?? '').includes(conn.id))
    await page.getByTestId(`dashboard-group-${groupId}`).click()
    await req
    expect(params(page).get('group')).toBe(groupId)
    expect(params(page).get('product_ids') ?? '').toContain(prod)
    await expect(page.getByTestId('dashboard-groups')).toContainText(name)

    // excluir com confirmação
    await page.getByTestId('dashboard-groups').click()
    await page.getByTestId(`dashboard-group-delete-${groupId}`).click()
    await expect(page.getByTestId('dashboard-confirm')).toBeVisible()
    const del = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().endsWith(`/api/sales/filter-groups/${groupId}`))
    await page.getByTestId('dashboard-confirm-ok').click()
    await del
    const list = await api(page, 'get', '/api/sales/filter-groups')
    expect((list.items as any[]).map((g) => g.id)).not.toContain(groupId)
  })
})

async function memberSupportOnly(page: Page, browser: Browser, baseURL: string | undefined) {
  const team = await api(page, 'get', '/api/team')
  const m = (team.items ?? team.members ?? team).find((x: any) => (x.email ?? x.user?.email) === SEED_USERS.member)
  await api(page, 'patch', `/api/team/${m.user_id ?? m.user?.id}`, { permission_keys: ['dashboard.support', 'chat.view'] })
  const ctx = await browser.newContext({ baseURL, viewport: page.viewportSize() ?? undefined, isMobile: isMobile(page), hasTouch: isMobile(page) })
  const p = await ctx.newPage()
  await loginAs(p, 'member')
  return p
}

test.describe('T78 — saudação, marcos e permissão', () => {
  // fusos da lista fixa da empresa (01 §3.2); os horários dão saudações diferentes da de São Paulo,
  // então o teste prova que vale o fuso da empresa
  for (const [tz, utc, text] of [
    ['America/Sao_Paulo', '2026-10-16T12:00:00Z', 'Bom dia'], // 09:00 em SP
    ['America/Mexico_City', '2026-10-16T17:30:00Z', 'Bom dia'], // 11:30 no México (14:30 em SP seria Boa tarde)
    ['America/Sao_Paulo', '2026-10-16T17:30:00Z', 'Boa tarde'], // 14:30 em SP
    ['UTC', '2026-10-16T20:00:00Z', 'Boa noite'], // 20:00 UTC (17:00 em SP seria Boa tarde)
  ] as const) {
    test(`AC-T78-04 saudação pelo horário no fuso da empresa: ${utc} em ${tz} → "${text}"`, async ({ page }) => {
      const login = await loginAs(page, 'owner')
      const companyId = login.companies[0].id
      await api(page, 'put', `/api/companies/${companyId}`, { time_zone: tz })
      // garante que o fuso foi mesmo gravado (fuso fora da lista cairia no padrão)
      expect((await api(page, 'get', `/api/companies/${companyId}`)).company.time_zone).toBe(tz)
      await page.clock.setFixedTime(new Date(utc))
      await openDashboard(page)
      const first = String(login.user.name).split(' ')[0]
      await expect(page.getByTestId('dashboard-greeting')).toHaveText(`${text}, ${first}!`)
    })
  }

  test('AC-T78-04 pílula de marcos com modal de progresso (R$ 75 mil → "Primeira Marca", 50% até "Tração")', async ({ page }) => {
    await loginAs(page, 'owner')
    await sale(page, 7_500_000, new Date(Date.now() - 3_600_000))
    await openDashboard(page)
    const pill = page.getByTestId('dashboard-milestone')
    await expect(pill).toHaveAttribute('data-level', '1')
    await expect(pill).toContainText('Primeira Marca')
    await pill.click()
    const modal = page.getByTestId('dashboard-milestone-modal')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('dashboard-milestone-current')).toContainText('Primeira Marca')
    await expect(page.getByTestId('dashboard-milestone-next')).toContainText('Tração')
    await expect(page.getByTestId('dashboard-milestone-progress')).toHaveAttribute('data-progress', '50')
    await expect(page.getByTestId('dashboard-milestone-remaining')).toContainText('R$ 25.000,00')
    await expect(page.getByTestId('dashboard-milestone-level-1')).toHaveAttribute('data-reached', 'true')
    await expect(page.getByTestId('dashboard-milestone-level-2')).toHaveAttribute('data-reached', 'false')
    await expect(page.getByTestId('dashboard-milestone-level-6')).toHaveAttribute('data-reached', 'false')
  })

  test('AC-T78-04 sem faturamento a pílula mostra "Sem selo"', async ({ page }) => {
    await loginAs(page, 'owner')
    await openDashboard(page)
    await expect(page.getByTestId('dashboard-milestone')).toHaveAttribute('data-level', '0')
    await expect(page.getByTestId('dashboard-milestone')).toContainText('Sem selo')
  })

  test('AC-T78-04 sem dashboard.sales a aba Vendas some e abre Atendimento (mesmo com ?tab=sales)', async ({ page, browser, baseURL }) => {
    await loginAs(page, 'owner')
    const member = await memberSupportOnly(page, browser, baseURL)
    await member.goto('/welcome?tab=sales')
    await expect(member.getByTestId('page-welcome')).toBeVisible()
    await expect(member.getByTestId('dashboard-tab-sales')).toHaveCount(0)
    await expect(member.getByTestId('dashboard-tab-attendance')).toHaveAttribute('aria-selected', 'true')
    await expect(member.getByTestId('dashboard-attendance')).toBeVisible()
    await expect(member.getByTestId('dashboard-milestone')).toHaveCount(0)
    await expect(member.getByTestId('dashboard-sales')).toHaveCount(0)
    await member.context().close()

    // owner tem as duas abas
    await openDashboard(page)
    await expect(page.getByTestId('dashboard-tab-sales')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('dashboard-tab-attendance')).toBeVisible()
  })
})
