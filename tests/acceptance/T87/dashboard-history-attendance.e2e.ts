// AC-T87-01..04 — /welcome: histórico de vendas (rolagem infinita, "Nova venda" no topo, exportar bloqueado) e aba
// Atendimento (KPIs, mapa de calor com pico, tempos s/min/h, tabela por atendente ordenável, "Outros" nos departamentos,
// aviso de 92 dias sem chamar a API). Contrato de data-testid: spec/reports/T87-entrega.md.
// "Hoje" vem de um relógio fixo (page.clock) no meio da tarde de São Paulo: nada depende da meia-noite real.
// Vendas pela API (o seed não tem vendas); atendimento com dados por page.route (gerar chats reais exige eventos WA).
import { expect, test, type Page, type Request } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const TODAY = '2026-10-14' // quarta-feira
const NOW = new Date(`${TODAY}T15:00:00-03:00`)

async function freeze(page: Page) {
  await page.clock.setFixedTime(NOW)
}

async function api(page: Page, method: 'get' | 'post', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request.post(path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

/** Venda em TODAY às 10:00 (SP) + `minute` minutos. */
async function sale(page: Page, minute: number, name: string) {
  const soldAt = new Date(new Date(`${TODAY}T10:00:00-03:00`).getTime() + minute * 60_000)
  const body = await api(page, 'post', '/api/sales', { amount_cents: 1_000 + minute, currency: 'BRL', sold_at: soldAt.toISOString(), status: 'approved', customer_name: name })
  return body.sale as { id: string; sold_at: string }
}

const isSalesList = (r: Request) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/sales'
const isAttendance = (r: Request) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/dashboard/attendance'
const bodyRows = (page: Page) => page.getByTestId('dashboard-history-table').locator('tbody > tr')

async function openSales(page: Page, qs = '') {
  await page.goto(`/welcome${qs}`)
  await expect(page.getByTestId('page-welcome')).toBeVisible()
  await expect(page.getByTestId('dashboard-history')).toBeVisible()
}

test.describe('T87 — histórico de vendas', () => {
  test('AC-T87-01 rolagem infinita: 20 por página, ao rolar carrega o resto e mostra "Fim do histórico"', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    const ids: string[] = []
    for (let i = 0; i < 25; i++) ids.push((await sale(page, i, `Cliente ${i}`)).id)

    const first = page.waitForRequest((r) => isSalesList(r) && new URL(r.url()).searchParams.get('page') === '1')
    await openSales(page)
    const q1 = new URL((await first).url()).searchParams
    expect(q1.get('start_date')).toBe(TODAY)
    expect(q1.get('end_date')).toBe(TODAY)
    expect(q1.get('skip_total')).toBe('1')

    await expect(bodyRows(page)).toHaveCount(20)
    // ordem do servidor: sold_at desc → a última criada (10:24) no topo
    await expect(bodyRows(page).first()).toHaveAttribute('data-testid', `dashboard-history-item-${ids[24]}`)
    await expect(page.getByTestId(`dashboard-history-item-customer-name-${ids[24]}`)).toHaveText('Cliente 24')
    await expect(page.getByTestId(`dashboard-history-item-amount-${ids[24]}`)).toContainText('10,24')
    await expect(page.getByTestId(`dashboard-history-item-sold-at-${ids[24]}`)).toContainText('10:24')
    await expect(page.getByTestId('dashboard-history-end')).toHaveCount(0)

    const second = page.waitForRequest((r) => isSalesList(r) && new URL(r.url()).searchParams.get('page') === '2')
    await page.getByTestId('dashboard-history-sentinel').scrollIntoViewIfNeeded()
    await second
    await expect(bodyRows(page)).toHaveCount(25)
    await expect(page.getByTestId(`dashboard-history-item-${ids[0]}`)).toBeVisible()
    await expect(page.getByTestId('dashboard-history-end')).toBeVisible()
    await expect(page.getByTestId('dashboard-history-end')).toHaveText(/Fim do histórico/)
  })

  test('AC-T87-01 exportar bloqueado com 0 linhas (com motivo); com linhas segue desabilitado "em breve"', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    await openSales(page)
    await expect(page.getByTestId('dashboard-history-empty')).toBeVisible()
    const exp = page.getByTestId('dashboard-history-export')
    await expect(exp).toBeDisabled()
    await expect(exp).toHaveAttribute('data-reason', 'empty')
    await expect(exp).toHaveAttribute('aria-describedby', 'dashboard-history-export-reason')
    await expect(page.getByTestId('dashboard-history-export-reason')).toBeVisible()
    await expect(page.getByTestId('dashboard-history-export-reason')).toHaveText(/Nenhuma venda para exportar/)

    await sale(page, 0, 'Com linha')
    await page.reload()
    await expect(bodyRows(page)).toHaveCount(1)
    await expect(exp).toBeDisabled()
    await expect(exp).toHaveAttribute('data-reason', 'soon')
    await expect(page.getByTestId('dashboard-history-export-reason')).toHaveText(/em breve/i)
  })

  test('AC-T87-01 "Nova venda" no modal coloca a venda no topo, mesmo com data mais antiga que as outras', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    const older = [await sale(page, 0, 'Antiga A'), await sale(page, 1, 'Antiga B')]
    await openSales(page)
    await expect(bodyRows(page)).toHaveCount(2)
    await expect(bodyRows(page).first()).toHaveAttribute('data-testid', `dashboard-history-item-${older[1]!.id}`)

    await page.getByTestId('dashboard-history-new').click()
    const modal = page.getByTestId('dashboard-history-modal')
    await expect(modal).toBeVisible()
    // padrões: valor 0, moeda BRL, data = agora no fuso da empresa (relógio fixo)
    await expect(page.getByTestId('dashboard-history-form-amount')).toHaveValue('0')
    await expect(page.getByTestId('dashboard-history-form-currency')).toHaveValue('BRL')
    await expect(page.getByTestId('dashboard-history-form-sold-at')).toHaveValue(/^2026-10-14T15:00/)

    await page.getByTestId('dashboard-history-form-instance-name').fill('Loja Centro')
    await page.getByTestId('dashboard-history-form-instance-number').fill('5511900000001')
    await page.getByTestId('dashboard-history-form-lead-number').fill('5511988887777')
    await page.getByTestId('dashboard-history-form-customer-name').fill('Maria Nova')
    await page.getByTestId('dashboard-history-form-amount').fill('123.45')
    await page.getByTestId('dashboard-history-form-source-id').fill('src-87')
    // 08:00 de hoje: antes das duas vendas (10:00 e 10:01) → a ordem do servidor a poria no fim
    await page.getByTestId('dashboard-history-form-sold-at').fill(`${TODAY}T08:00`)

    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sales')
    await page.getByTestId('dashboard-history-form-save').click()
    const res = await post
    expect(res.status()).toBe(201)
    const sent = res.request().postDataJSON()
    const input = sent.sale ?? sent
    expect(input.amount_cents).toBe(12_345)
    expect(input.currency).toBe('BRL')
    expect(new Date(input.sold_at).toISOString()).toBe(new Date(`${TODAY}T08:00:00-03:00`).toISOString())
    const created = (await res.json()).sale as { id: string }

    await expect(modal).toBeHidden()
    await expect(bodyRows(page)).toHaveCount(3)
    await expect(bodyRows(page).first()).toHaveAttribute('data-testid', `dashboard-history-item-${created.id}`)
    await expect(page.getByTestId(`dashboard-history-item-customer-name-${created.id}`)).toHaveText('Maria Nova')
    await expect(page.getByTestId(`dashboard-history-item-instance-name-${created.id}`)).toHaveText('Loja Centro')
    await expect(page.getByTestId(`dashboard-history-item-amount-${created.id}`)).toContainText('123,45')
    await expect(page.getByTestId(`dashboard-history-item-source-id-${created.id}`)).toHaveText('src-87')
    await expect(page.getByTestId(`dashboard-history-item-sold-at-${created.id}`)).toContainText('08:00')
    await expect(page.getByTestId('dashboard-history-export')).toHaveAttribute('data-reason', 'soon')
  })

  test('AC-T87-01 "Nova venda" a partir da lista vazia: a venda aparece e o vazio some', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    await openSales(page)
    await expect(page.getByTestId('dashboard-history-empty')).toBeVisible()
    await page.getByTestId('dashboard-history-empty-new').click()
    await page.getByTestId('dashboard-history-form-customer-name').fill('Primeira')
    await page.getByTestId('dashboard-history-form-amount').fill('50')
    await page.getByTestId('dashboard-history-form-save').click()
    await expect(page.getByTestId('dashboard-history-modal')).toBeHidden()
    await expect(page.getByTestId('dashboard-history-empty')).toHaveCount(0)
    await expect(bodyRows(page)).toHaveCount(1)
    await expect(bodyRows(page).first().locator('[data-testid^="dashboard-history-item-customer-name-"]')).toHaveText('Primeira')
    await expect(page.getByTestId('dashboard-history-export')).toHaveAttribute('data-reason', 'soon')
  })
})

// ---------- Atendimento (GET /api/dashboard/attendance interceptado) ----------

const U = { ana: 'u-ana', bruno: 'u-bruno', carla: 'u-carla', davi: 'u-davi' }

function attendanceFixture(over: Record<string, unknown> = {}) {
  const heat = [
    { weekday: 2, hour: 14, count: 30 }, // pico: terça 14h
    { weekday: 2, hour: 15, count: 12 },
    { weekday: 1, hour: 9, count: 5 },
    { weekday: 5, hour: 20, count: 1 },
  ]
  return {
    range: { start_date: TODAY, end_date: TODAY, time_zone: 'America/Sao_Paulo', granularity: 'hour' },
    previous_range: { start_date: '2026-10-13', end_date: '2026-10-13' },
    cached: false,
    computed_at: '2026-10-14T17:59:00.000Z',
    attendance: {
      new_leads: 48,
      attended_leads: 40,
      resolved_leads: 31,
      unanswered_chats: 8,
      response_time_seconds: 330, // 5 min 30 s
      first_reply_since: null,
      previous: { new_leads: 40, attended_leads: 40, resolved_leads: 20, unanswered_chats: 4, response_time_seconds: 300 },
      trends: {
        new_leads: { direction: 'up', delta_pct: 20 },
        attended_leads: { direction: 'neutral', delta_pct: 0 },
        resolved_leads: { direction: 'up', delta_pct: 55 },
        unanswered_chats: { direction: 'up', delta_pct: 100 },
        response_time_seconds: { direction: 'up', delta_pct: 10 },
      },
      inverted_kpis: ['unanswered_chats', 'response_time_seconds'],
      attendance_over_time: [
        { bucket_start: `${TODAY}T13:00:00-03:00`, count: 20 },
        { bucket_start: `${TODAY}T14:00:00-03:00`, count: 28 },
      ],
      response_time_over_time: [
        { bucket_start: `${TODAY}T13:00:00-03:00`, average_seconds: 300, count: 10 },
        { bucket_start: `${TODAY}T14:00:00-03:00`, average_seconds: 360, count: 12 },
      ],
      attendance_by_weekday_hour: heat,
      peak: heat[0],
      peaks: [heat[0]],
      leads_by_status_chart: [{ connection_id: 'c1', connection_name: 'Vendas', new_leads: 48, attended_leads: 40, resolved_leads: 31 }],
      leads_by_user: [
        { user_id: U.ana, user_name: 'Ana', answered_chats: 10, attending_chats: 2, resolved_chats: 8, average_response_seconds: 45 },
        { user_id: U.bruno, user_name: 'Bruno', answered_chats: 20, attending_chats: 1, resolved_chats: 15, average_response_seconds: 8_100 }, // 2 h 15 min
        { user_id: U.carla, user_name: 'Carla', answered_chats: 5, attending_chats: 4, resolved_chats: 3, average_response_seconds: 7_200 }, // 2 h
        { user_id: U.davi, user_name: 'Davi', answered_chats: 3, attending_chats: 0, resolved_chats: 1, average_response_seconds: null },
        { user_id: null, user_name: 'Usuário removido', answered_chats: 2, attending_chats: 0, resolved_chats: 2, average_response_seconds: 300 }, // 5 min
      ],
      attendance_by_department: [{ department_id: 'd1', department_name: 'Suporte', color: '#16a34a', chat_count: 48 }],
      ...over,
    },
  }
}

async function mockAttendance(page: Page, body: unknown, status = 200) {
  const seen: URL[] = []
  await page.route('**/api/dashboard/attendance*', async (route) => {
    seen.push(new URL(route.request().url()))
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return seen
}

async function openAttendance(page: Page, qs = '') {
  await page.goto(`/welcome?tab=attendance${qs}`)
  await expect(page.getByTestId('page-welcome')).toBeVisible()
  await expect(page.getByTestId('dashboard-tab-attendance')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('attendance')).toBeVisible()
}

const userOrder = (page: Page) =>
  page
    .getByTestId('attendance-users-table')
    .locator('tbody > tr')
    .evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-testid')!.replace('attendance-user-item-', '')))

test.describe('T87 — aba Atendimento', () => {
  test('AC-T87-02 KPIs com valores, tempo formatado e tendência (invertida em sem resposta e tempo)', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    const seen = await mockAttendance(page, attendanceFixture())
    await openAttendance(page)
    await expect(page.getByTestId('attendance-kpi-new_leads-value')).toHaveText('48')
    await expect(page.getByTestId('attendance-kpi-attended_leads-value')).toHaveText('40')
    await expect(page.getByTestId('attendance-kpi-resolved_leads-value')).toHaveText('31')
    await expect(page.getByTestId('attendance-kpi-unanswered_chats-value')).toHaveText('8')
    await expect(page.getByTestId('attendance-kpi-response_time_seconds-value')).toHaveText('5 min 30 s')
    // a API recebeu o período "Hoje" do relógio fixo
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)!.searchParams.get('start_date')).toBe(TODAY)
    expect(seen.at(-1)!.searchParams.get('end_date')).toBe(TODAY)

    const trend = (k: string) => page.getByTestId(`attendance-kpi-${k}-trend`)
    await expect(trend('new_leads')).toHaveAttribute('data-trend', 'up')
    await expect(trend('new_leads')).toHaveAttribute('data-good', 'true')
    await expect(trend('new_leads')).toContainText('20,0%')
    await expect(trend('attended_leads')).toHaveAttribute('data-trend', 'neutral')
    await expect(trend('unanswered_chats')).toHaveAttribute('data-trend', 'up')
    await expect(trend('unanswered_chats')).toHaveAttribute('data-good', 'false')
    await expect(trend('response_time_seconds')).toHaveAttribute('data-good', 'false')

    await expect(page.getByTestId('attendance-chart-over-time')).toBeVisible()
    await expect(page.getByTestId('attendance-chart-response-time')).toBeVisible()
    await expect(page.getByTestId('attendance-chart-by-status')).toBeVisible()
    await expect(page.getByTestId('attendance-chart-over-time-empty')).toHaveCount(0)
  })

  test('AC-T87-02 mapa de calor destaca o pico (terça 14h · 30 chats)', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    await mockAttendance(page, attendanceFixture())
    await openAttendance(page)
    const heat = page.getByTestId('attendance-heatmap')
    await expect(heat).toBeVisible()
    await expect(heat.locator('[data-testid^="attendance-heat-cell-"]')).toHaveCount(7 * 24)
    const peakCell = page.getByTestId('attendance-heat-cell-2-14')
    await expect(peakCell).toHaveAttribute('data-count', '30')
    await expect(peakCell).toHaveAttribute('data-peak', 'true')
    await expect(heat.locator('[data-peak="true"]')).toHaveCount(1)
    await expect(page.getByTestId('attendance-heat-cell-2-15')).toHaveAttribute('data-count', '12')
    await expect(page.getByTestId('attendance-heat-cell-0-0')).toHaveAttribute('data-count', '0')
    const peak = page.getByTestId('attendance-peak')
    await expect(peak).toHaveText(/Pico: terça 14h · 30 chats/)
    await expect(peak).toHaveAttribute('data-weekday', '2')
    await expect(peak).toHaveAttribute('data-hour', '14')
    await expect(peak).toHaveAttribute('data-count', '30')
  })

  test('AC-T87-02 tempos por atendente formatados em s/min/h (nulo vira —)', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    await mockAttendance(page, attendanceFixture())
    await openAttendance(page)
    await expect(page.getByTestId('attendance-users-table')).toBeVisible()
    await expect(page.getByTestId(`attendance-user-item-time-${U.ana}`)).toHaveText('45 s')
    await expect(page.getByTestId(`attendance-user-item-time-${U.bruno}`)).toHaveText('2 h 15 min')
    await expect(page.getByTestId(`attendance-user-item-time-${U.carla}`)).toHaveText('2 h')
    await expect(page.getByTestId('attendance-user-item-time-removed')).toHaveText('5 min')
    await expect(page.getByTestId(`attendance-user-item-time-${U.davi}`)).toHaveText('—')
    await expect(page.getByTestId('attendance-user-item-name-removed')).toHaveText('Usuário removido')
    await expect(page.getByTestId(`attendance-user-item-answered-${U.bruno}`)).toHaveText('20')
    await expect(page.getByTestId(`attendance-user-item-attending-${U.carla}`)).toHaveText('4')
    await expect(page.getByTestId(`attendance-user-item-resolved-${U.ana}`)).toHaveText('8')
  })

  test('AC-T87-02 tabela por atendente ordenável por cada coluna (aria-sort; tempo nulo sempre no fim)', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    await mockAttendance(page, attendanceFixture())
    await openAttendance(page)
    const th = (k: string) => page.getByTestId(`attendance-users-sort-${k}`).locator('xpath=ancestor::th[1]')
    // padrão: atendidos decrescente
    await expect(th('answered')).toHaveAttribute('aria-sort', 'descending')
    expect(await userOrder(page)).toEqual([U.bruno, U.ana, U.carla, U.davi, 'removed'])

    await page.getByTestId('attendance-users-sort-name').click()
    await expect(th('name')).toHaveAttribute('aria-sort', 'ascending')
    await expect(th('answered')).toHaveAttribute('aria-sort', 'none')
    expect(await userOrder(page)).toEqual([U.ana, U.bruno, U.carla, U.davi, 'removed'])
    await page.getByTestId('attendance-users-sort-name').click()
    await expect(th('name')).toHaveAttribute('aria-sort', 'descending')
    expect(await userOrder(page)).toEqual(['removed', U.davi, U.carla, U.bruno, U.ana])

    await page.getByTestId('attendance-users-sort-attending').click()
    await expect(th('attending')).toHaveAttribute('aria-sort', 'descending')
    expect((await userOrder(page)).slice(0, 3)).toEqual([U.carla, U.ana, U.bruno])

    await page.getByTestId('attendance-users-sort-resolved').click()
    await expect(th('resolved')).toHaveAttribute('aria-sort', 'descending')
    expect((await userOrder(page)).slice(0, 3)).toEqual([U.bruno, U.ana, U.carla])

    await page.getByTestId('attendance-users-sort-time').click()
    await expect(th('time')).toHaveAttribute('aria-sort', 'ascending')
    expect(await userOrder(page)).toEqual([U.ana, 'removed', U.carla, U.bruno, U.davi])
    await page.getByTestId('attendance-users-sort-time').click()
    await expect(th('time')).toHaveAttribute('aria-sort', 'descending')
    expect(await userOrder(page)).toEqual([U.bruno, U.carla, 'removed', U.ana, U.davi])
  })

  test('AC-T87-03 departamentos acima do limite de fatias: 5 maiores + "Outros" com a soma do resto', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    const deps = [80, 70, 60, 50, 40, 30, 20, 10].map((n, i) => ({ department_id: `d${i + 1}`, department_name: `Depto ${i + 1}`, color: null, chat_count: n }))
    deps[7] = { department_id: null as unknown as string, department_name: 'Sem departamento', color: null, chat_count: 10 }
    await mockAttendance(page, attendanceFixture({ attendance_by_department: deps }))
    await openAttendance(page)
    const card = page.getByTestId('attendance-departments')
    await expect(card).toBeVisible()
    await expect(page.getByTestId('attendance-departments-view')).toHaveAttribute('data-value', 'chart')
    const slices = card.locator('[data-testid^="attendance-department-slice-"]')
    await expect(slices).toHaveCount(6)
    for (const [i, n] of [80, 70, 60, 50, 40].entries()) await expect(page.getByTestId(`attendance-department-slice-d${i + 1}`)).toHaveAttribute('data-value', String(n))
    const others = page.getByTestId('attendance-department-slice-others')
    await expect(others).toHaveAttribute('data-value', String(30 + 20 + 10))
    await expect(others).toContainText('Outros')
    await expect(page.getByTestId('attendance-department-slice-d6')).toHaveCount(0)
    await expect(page.getByTestId('attendance-department-slice-none')).toHaveCount(0)

    // a lista mostra todos, sem agrupar
    await page.getByTestId('attendance-departments-view-list').click()
    await expect(card.locator('[data-testid^="attendance-department-item-"]')).toHaveCount(8)
    await expect(page.getByTestId('attendance-department-item-none')).toContainText('Sem departamento')
  })

  test('AC-T87-03 no limite (6 departamentos) não há "Outros"', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    const deps = [60, 50, 40, 30, 20, 10].map((n, i) => ({ department_id: `d${i + 1}`, department_name: `Depto ${i + 1}`, color: null, chat_count: n }))
    await mockAttendance(page, attendanceFixture({ attendance_by_department: deps }))
    await openAttendance(page)
    const slices = page.getByTestId('attendance-departments').locator('[data-testid^="attendance-department-slice-"]')
    await expect(slices).toHaveCount(6)
    await expect(page.getByTestId('attendance-department-slice-others')).toHaveCount(0)
  })

  test('AC-T87-04 período acima de 92 dias mostra o aviso e não chama a API; voltar a um período válido carrega', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const seen = await mockAttendance(page, attendanceFixture())
    await openAttendance(page, '&preset=custom&start_date=2026-01-01&end_date=2026-06-30')
    const warn = page.getByTestId('attendance-range-warning')
    await expect(warn).toBeVisible()
    await expect(warn).toHaveAttribute('role', 'alert')
    await expect(warn).toContainText('92 dias')
    await expect(page.getByTestId('attendance-error')).toHaveCount(0)
    await expect(page.getByTestId('attendance-kpi-new_leads')).toHaveCount(0)
    // filtros continuam na tela para corrigir o período
    await expect(page.getByTestId('dashboard-preset-7d')).toBeVisible()
    await page.waitForTimeout(500)
    expect(seen, 'nenhuma requisição ao atendimento com > 92 dias').toHaveLength(0)

    // "Atualizar" com período bloqueado também não chama a API
    await page.getByTestId('dashboard-refresh').click()
    await page.waitForTimeout(300)
    expect(seen).toHaveLength(0)

    const req = page.waitForRequest((r) => isAttendance(r) && new URL(r.url()).searchParams.get('start_date') === '2026-10-08')
    await page.getByTestId('dashboard-preset-7d').click()
    await req
    await expect(warn).toHaveCount(0)
    await expect(page.getByTestId('attendance-kpi-new_leads-value')).toHaveText('48')
    expect(errors).toEqual([])
  })

  test('AC-T87-04 exatamente 92 dias é aceito (chama a API, sem aviso)', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    const seen = await mockAttendance(page, attendanceFixture())
    // 2026-07-15..2026-10-14 = 92 dias contando os dois extremos
    await openAttendance(page, '&preset=custom&start_date=2026-07-15&end_date=2026-10-14')
    await expect(page.getByTestId('attendance-kpi-new_leads-value')).toHaveText('48')
    await expect(page.getByTestId('attendance-range-warning')).toHaveCount(0)
    expect(seen.at(-1)!.searchParams.get('start_date')).toBe('2026-07-15')
  })

  test('AC-T87-04 o 422 do limite vindo da API vira o mesmo aviso (sem tela de erro)', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    await mockAttendance(page, { error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos', details: { fields: [{ path: 'end_date', message: 'Atendimento limitado a 92 dias' }] } } }, 422)
    await openAttendance(page)
    await expect(page.getByTestId('attendance-range-warning')).toBeVisible()
    await expect(page.getByTestId('attendance-error')).toHaveCount(0)
  })

  test('AC-T87-04 sem mock: período > 92 dias no servidor real também não quebra (aviso, 0 chamadas)', async ({ page }) => {
    await freeze(page)
    await loginAs(page, 'owner')
    const calls: string[] = []
    page.on('request', (r) => isAttendance(r) && calls.push(r.url()))
    await openAttendance(page, '&preset=custom&start_date=2026-03-01&end_date=2026-10-14')
    await expect(page.getByTestId('attendance-range-warning')).toBeVisible()
    await page.waitForTimeout(500)
    expect(calls).toEqual([])
  })
})
