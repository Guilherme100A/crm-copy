// T83 — UI de disparos em massa (E2E no harness da T17). Contrato em spec/reports/T83-entrega.md: testids
// `mass-dispatch-*`, massa pela API (contatos T26, conexão T40 + `POST /__e2e/wa/sessions/:sid/state {to:'open'}` da
// T71, fluxo ativo e publicado T28), API da T60 (`/api/mass-dispatches`), preparação da T74 rodando no worker do harness
// (fases por SSE `mass_dispatch.updated`) e atalho de Contatos (T77, `history.state.massDispatchDraft`).
// O envio real (ticks/flow-step) não roda no harness: os testes cobrem página, wizard, preparação, detalhe e cancelamento.
// Desktop: nenhum AC da T83 cita mobile.
import { expect, test, type Page } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { createConnection, newPhone, trackSse, waitSseOpen, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const P = 'mass-dispatch'
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const tid = (page: Page, id: string) => page.getByTestId(`${P}-${id}`)

async function api(page: Page, method: 'get' | 'post' | 'put', path: string, data?: unknown) {
  const res = await page.request[method](path, { ...(method === 'get' ? {} : { data: data ?? {} }), headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

/** Leva a sessão do fake a um estado e espera o worker consumir os eventos publicados (como na T71). */
async function drive(page: Page, sessionId: string, to: 'open' | 'close') {
  const res = await page.request.post(`/__e2e/wa/sessions/${sessionId}/state`, { data: { to }, headers: XRW })
  expect(res.status(), await res.text()).toBe(202)
  const { events } = await res.json()
  for (const e of events as Array<{ stream_id: string }>) {
    const d = await page.request.get(`/__e2e/wa/deliveries?stream_id=${encodeURIComponent(e.stream_id)}&wait_ms=10000`)
    expect((await d.json()).acked, 'worker do harness não consumiu o evento').toBe(true)
  }
}

async function connected(page: Page, name = `Loja ${uniq()}`) {
  const conn = await createConnection(page, name)
  await drive(page, conn.session_id, 'open')
  return conn
}

const flowDef = {
  schema: 'crm.flow/v1',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
    { id: 'm1', type: 'message', name: 'Oi', position: { x: 200, y: 0 }, actions: [{ id: 'm1-a1', type: 'send_message', order: 0, config: { message_text: 'Olá {first_name}' } }] },
  ],
  edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'm1' }],
  variables: [],
  refs: {},
}

async function activeFlow(page: Page, name = `Fluxo ${uniq()}`) {
  const { flow } = await api(page, 'post', '/api/flows', { name })
  await api(page, 'put', `/api/flows/${flow.id}/definition`, flowDef)
  await api(page, 'post', `/api/flows/${flow.id}/activate`)
  return { id: flow.id as string, name }
}

async function contacts(page: Page, n: number, prefix = `Cliente ${uniq()}`) {
  const out: Array<{ id: string; name: string }> = []
  for (let i = 0; i < n; i++) out.push((await api(page, 'post', '/api/contacts', { name: `${prefix} ${i + 1}`, phone: `+${newPhone()}` })).contact)
  return out
}

/** Contatos + conexão conectada + fluxo acionável. */
async function seed(page: Page, n = 3) {
  const people = await contacts(page, n)
  const conn = await connected(page)
  const flow = await activeFlow(page)
  return { people, conn, flow }
}

const quotaOf = async (page: Page) => (await api(page, 'get', '/api/mass-dispatches/quota')).quota as Any
const dispatchOf = async (page: Page, id: string) => (await api(page, 'get', `/api/mass-dispatches/${id}`)).mass_dispatch as Any
const listOf = async (page: Page) => (await api(page, 'get', '/api/mass-dispatches?limit=100')).items as Any[]

/** Disparo pela API (JSON, T60) para todos os contatos. */
async function createViaApi(page: Page, body: Record<string, unknown>) {
  const res = await page.request.post('/api/mass-dispatches', {
    data: {
      manifest: { version: 1, mode: 'all_except', except_ids: [] },
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      window_start: '00:00',
      window_end: '23:59',
      interval_min_seconds: 5,
      interval_max_seconds: 30,
      ...body,
    },
    headers: XRW,
  })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()).mass_dispatch as Any
}

/** O status sai de `scheduled` para `running` sozinho (agendador da T74): compara a UI com a API do momento. */
async function sameStatus(page: Page, testId: string, id: string) {
  await expect
    .poll(async () => (await tid(page, testId).getAttribute('data-status')) === (await dispatchOf(page, id)).status, { timeout: 15_000 })
    .toBe(true)
}

/** O harness dispara os envios (o progresso anda sozinho): o texto `enviados / total` da UI bate com a API do momento. */
async function sameProgress(page: Page, testId: string, id: string) {
  await expect
    .poll(
      async () => {
        const d = await dispatchOf(page, id)
        const text = (await tid(page, testId).textContent()) ?? ''
        const pct = await tid(page, testId).getAttribute('data-percent')
        return text.includes(`${d.sent_count} / ${d.total_count}`) && (pct === null || pct === String(d.progress_percent))
      },
      { timeout: 15_000 },
    )
    .toBe(true)
}

async function prepared(page: Page, id: string) {
  await expect.poll(async () => (await dispatchOf(page, id)).preparation_progress?.phase, { timeout: 20_000 }).toBe('completed')
}

async function openPage(page: Page) {
  await trackSse(page)
  await page.goto('/mass-dispatches')
  await expect(page.getByTestId('page-mass-dispatch')).toBeVisible()
  await expect(tid(page, 'loading')).toHaveCount(0)
  await waitSseOpen(page)
}

/** Abre o wizard e espera o 1º alvo vir pré-preenchido. */
async function openWizard(page: Page) {
  await tid(page, 'new').click()
  await expect(tid(page, 'wizard')).toBeVisible()
  await expect(tid(page, 'target-connection-0')).not.toHaveValue('')
  await expect(tid(page, 'target-flow-0')).not.toHaveValue('')
}

const stepIs = (page: Page, step: 'data' | 'settings' | 'audience') =>
  expect(tid(page, `step-indicator-${step}`)).toHaveAttribute('aria-current', 'step')

const PHASES = ['queued', 'resolving_recipients', 'counting', 'scheduling', 'completed']

async function expectPrepared(page: Page, total: number) {
  await expect(tid(page, 'preparing')).toBeVisible()
  await expect(tid(page, 'phases')).toHaveAttribute('data-phase', 'completed', { timeout: 20_000 })
  for (const ph of PHASES) await expect(tid(page, `phase-${ph}`)).toHaveAttribute('data-state', 'done')
  await expect(tid(page, 'preparing-count')).toContainText(`${total} / ${total}`)
  await expect(tid(page, 'preparing-done')).toBeVisible()
}

test.describe('T83 — página de disparos em massa', () => {
  test('AC-T83-01 cards de cota, barra da cota e estado vazio refletem GET /quota', async ({ page }) => {
    await loginAs(page, 'owner')
    await seed(page, 1)
    const q = await quotaOf(page)
    await openPage(page)

    await expect(tid(page, 'empty')).toBeVisible()
    await expect(tid(page, 'card-remaining')).toHaveAttribute('data-count', String(q.remaining))
    await expect(tid(page, 'card-used')).toHaveAttribute('data-count', String(q.used))
    await expect(tid(page, 'card-used')).toContainText(`${q.used} / ${q.limit}`)
    await expect(tid(page, 'card-running')).toHaveAttribute('data-count', '0')
    await expect(tid(page, 'card-completed')).toHaveAttribute('data-count', '0')
    await expect(tid(page, 'card-remaining')).toContainText('Restantes')
    await expect(tid(page, 'card-used')).toContainText('Usados')
    await expect(tid(page, 'card-running')).toContainText('Em andamento')
    await expect(tid(page, 'card-completed')).toContainText('Concluídos')
    await expect(tid(page, 'quota')).toContainText('Cota do ciclo')
    await expect(tid(page, 'quota-text')).toContainText(`${q.used} de ${q.limit} usados (${q.remaining} restantes)`)
    const pct = q.limit > 0 ? Math.round((q.used / q.limit) * 100) : 0
    await expect(tid(page, 'quota-bar')).toHaveAttribute('data-percent', String(pct))
  })

  test('AC-T83-01 tabela mostra nome, conexão, fluxo, status e progresso; cards e cota acompanham o disparo', async ({ page }) => {
    await loginAs(page, 'owner')
    const { conn, flow } = await seed(page, 3)
    const name = `Campanha ${uniq()}`
    const md = await createViaApi(page, { name, targets: [{ connection_id: conn.id, flow_id: flow.id }] })
    await prepared(page, md.id)
    const d = await dispatchOf(page, md.id)
    const q = await quotaOf(page)
    expect(q.used, 'cota usada pelo disparo').toBeGreaterThanOrEqual(3)

    await openPage(page)
    await expect(tid(page, 'table')).toBeVisible()
    await sameStatus(page, `item-${md.id}`, md.id)
    await expect(tid(page, `item-name-${md.id}`)).toHaveText(name)
    await expect(tid(page, `item-connection-${md.id}`)).toContainText(conn.name)
    await expect(tid(page, `item-flow-${md.id}`)).toContainText(flow.name)
    await sameStatus(page, `item-status-${md.id}`, md.id)
    expect(d.total_count).toBe(3)
    await sameProgress(page, `item-progress-${md.id}`, md.id)
    await expect(tid(page, `item-schedule-${md.id}`)).not.toBeEmpty()
    for (const col of ['Nome', 'Fluxo', 'Status', 'Progresso', 'Agenda', 'Ações']) await expect(tid(page, 'table')).toContainText(col)

    await expect(tid(page, 'card-running')).toHaveAttribute('data-count', '1')
    await expect(tid(page, 'card-used')).toHaveAttribute('data-count', String(q.used))
    await expect(tid(page, 'card-remaining')).toHaveAttribute('data-count', String(q.remaining))
    await expect(tid(page, 'quota-text')).toContainText(`${q.used} de ${q.limit} usados (${q.remaining} restantes)`)
  })

  test('AC-T83-01 busca no cliente filtra a tabela por nome e fluxo', async ({ page }) => {
    await loginAs(page, 'owner')
    const { conn, flow } = await seed(page, 1)
    const flowB = await activeFlow(page, `Outro ${uniq()}`)
    const a = await createViaApi(page, { name: `Alfa ${uniq()}`, targets: [{ connection_id: conn.id, flow_id: flow.id }] })
    const b = await createViaApi(page, { name: `Beta ${uniq()}`, targets: [{ connection_id: conn.id, flow_id: flowB.id }] })
    await openPage(page)
    await expect(tid(page, `item-${a.id}`)).toBeVisible()
    await expect(tid(page, `item-${b.id}`)).toBeVisible()
    await tid(page, 'search').fill('Alfa')
    await expect(tid(page, `item-${b.id}`)).toHaveCount(0)
    await expect(tid(page, `item-${a.id}`)).toBeVisible()
    await tid(page, 'search').fill(flowB.name)
    await expect(tid(page, `item-${a.id}`)).toHaveCount(0)
    await expect(tid(page, `item-${b.id}`)).toBeVisible()
  })
})

test.describe('T83 — wizard', () => {
  test('AC-T83-02 três passos com alvos, presets lento/normal/rápido/personalizado e público; cria o disparo com a configuração', async ({ page }) => {
    await loginAs(page, 'owner')
    const { people, conn, flow } = await seed(page, 3)
    const conn2 = await connected(page, `Filial ${uniq()}`)
    await openPage(page)
    await openWizard(page)

    // Passo 1 — Dados
    await stepIs(page, 'data')
    await expect(tid(page, 'step-data')).toBeVisible()
    const name = `Wizard ${uniq()}`
    await tid(page, 'name').fill(name)
    await expect(tid(page, 'target-flow-0')).toHaveValue(flow.id)
    await expect(tid(page, 'target-remove-0')).toBeDisabled()
    await tid(page, 'target-add').click()
    await expect(tid(page, 'target-1')).toBeVisible()
    await tid(page, 'target-connection-1').selectOption(conn2.id)
    await tid(page, 'target-flow-1').selectOption(flow.id)
    const firstConn = await tid(page, 'target-connection-0').inputValue()
    expect([conn.id, conn2.id]).toContain(firstConn)
    if (firstConn === conn2.id) await tid(page, 'target-connection-0').selectOption(conn.id)
    // remover e voltar a adicionar
    await tid(page, 'target-remove-1').click()
    await expect(tid(page, 'target-1')).toHaveCount(0)
    await tid(page, 'target-add').click()
    await tid(page, 'target-connection-1').selectOption(conn2.id)
    await tid(page, 'target-flow-1').selectOption(flow.id)
    await tid(page, 'wizard-next').click()

    // Passo 2 — Configurações
    await stepIs(page, 'settings')
    await expect(tid(page, 'preset-normal')).toHaveAttribute('aria-checked', 'true')
    await expect(tid(page, 'interval-summary')).toHaveAttribute('data-min', '5')
    await expect(tid(page, 'interval-summary')).toHaveAttribute('data-max', '30')
    await tid(page, 'preset-fast').click()
    await expect(tid(page, 'preset-fast')).toHaveAttribute('aria-checked', 'true')
    await expect(tid(page, 'preset-normal')).toHaveAttribute('aria-checked', 'false')
    await expect(tid(page, 'interval-summary')).toHaveAttribute('data-min', '0')
    await expect(tid(page, 'interval-summary')).toHaveAttribute('data-max', '5')
    await tid(page, 'preset-custom').click()
    await expect(tid(page, 'interval-min')).toBeVisible()
    await tid(page, 'preset-slow').click()
    await expect(tid(page, 'preset-slow')).toHaveAttribute('aria-checked', 'true')
    await expect(tid(page, 'interval-min')).toHaveCount(0)
    await expect(tid(page, 'interval-summary')).toHaveAttribute('data-min', '30')
    await expect(tid(page, 'interval-summary')).toHaveAttribute('data-max', '120')
    // horário comercial: seg–sex 09:00–17:00
    if (!(await tid(page, 'business-hours').isChecked())) await tid(page, 'business-hours').check()
    for (const d of [0, 1, 2, 3, 4, 5, 6]) {
      const want = d >= 1 && d <= 5
      if ((await tid(page, `weekday-${d}`).getAttribute('aria-pressed')) !== String(want)) await tid(page, `weekday-${d}`).click()
      await expect(tid(page, `weekday-${d}`)).toHaveAttribute('aria-pressed', String(want))
    }
    await tid(page, 'window-start').fill('09:00')
    await tid(page, 'window-end').fill('17:00')
    await tid(page, 'wizard-next').click()

    // Passo 3 — Público (sem rascunho: todos os contatos)
    await stepIs(page, 'audience')
    await expect(tid(page, 'audience-draft')).toHaveCount(0)
    await expect(tid(page, 'audience-all')).toHaveAttribute('aria-checked', 'true')
    await expect(tid(page, 'audience-count')).toHaveAttribute('data-count', String(people.length))
    // voltar preserva o que foi escolhido
    await tid(page, 'wizard-back').click()
    await stepIs(page, 'settings')
    await expect(tid(page, 'preset-slow')).toHaveAttribute('aria-checked', 'true')
    await tid(page, 'wizard-next').click()
    await stepIs(page, 'audience')

    // Confirmação: o fluxo em andamento do contato será cancelado
    await tid(page, 'wizard-submit').click()
    await expect(tid(page, 'confirm')).toBeVisible()
    await expect(tid(page, 'confirm-flow-notice')).toContainText(/cancela qualquer fluxo em andamento do mesmo contato/i)
    await expect(tid(page, 'confirm-summary')).toContainText(String(people.length))
    // voltar da confirmação não cria nada
    await tid(page, 'confirm-back').click()
    await expect(tid(page, 'confirm')).toHaveCount(0)
    expect(await listOf(page)).toHaveLength(0)
    await tid(page, 'wizard-submit').click()
    await tid(page, 'confirm-ok').click()
    await expectPrepared(page, people.length)

    const items = await listOf(page)
    expect(items).toHaveLength(1)
    const md = await dispatchOf(page, items[0].id)
    expect(md.name).toBe(name)
    expect(md.targets.map((t: Any) => t.connection_id).sort()).toEqual([conn.id, conn2.id].sort())
    expect(md.targets.every((t: Any) => t.flow_id === flow.id)).toBe(true)
    expect(md.interval_min_seconds).toBe(30)
    expect(md.interval_max_seconds).toBe(120)
    expect([...md.weekdays].sort()).toEqual([1, 2, 3, 4, 5])
    expect(String(md.window_start).slice(0, 5)).toBe('09:00')
    expect(String(md.window_end).slice(0, 5)).toBe('17:00')
    expect(md.total_count).toBe(people.length)
  })

  test('AC-T83-02 personalizado sem randomizar envia intervalo fixo; horário comercial desligado vale todos os dias 00:00–23:59', async ({ page }) => {
    await loginAs(page, 'owner')
    await seed(page, 2)
    await openPage(page)
    await openWizard(page)
    await tid(page, 'wizard-next').click()
    await stepIs(page, 'settings')
    if (await tid(page, 'business-hours').isChecked()) await tid(page, 'business-hours').uncheck()
    await expect(tid(page, 'full-day')).toBeVisible()
    await tid(page, 'preset-custom').click()
    await expect(tid(page, 'preset-custom')).toHaveAttribute('aria-checked', 'true')
    if (await tid(page, 'randomize').isChecked()) await tid(page, 'randomize').uncheck()
    await expect(tid(page, 'interval-max')).toHaveCount(0)
    await tid(page, 'interval-min').fill('42')
    await expect(tid(page, 'interval-summary')).toHaveAttribute('data-min', '42')
    await expect(tid(page, 'interval-summary')).toHaveAttribute('data-max', '42')
    await tid(page, 'wizard-next').click()
    await tid(page, 'wizard-submit').click()
    await tid(page, 'confirm-ok').click()
    await expectPrepared(page, 2)
    const md = await dispatchOf(page, (await listOf(page))[0].id)
    expect(md.interval_min_seconds).toBe(42)
    expect(md.interval_max_seconds).toBe(42)
    expect([...md.weekdays].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(String(md.window_start).slice(0, 5)).toBe('00:00')
    expect(String(md.window_end).slice(0, 5)).toBe('23:59')
  })

  test('AC-T83-02 validações no cliente bloqueiam o avanço (fluxo, dias, janela, limite diário acima da cota)', async ({ page }) => {
    await loginAs(page, 'owner')
    await seed(page, 1)
    const q = await quotaOf(page)
    await openPage(page)
    await openWizard(page)

    await tid(page, 'target-flow-0').selectOption('')
    await tid(page, 'wizard-next').click()
    await expect(tid(page, 'error-targets-0-flow_id')).toBeVisible()
    await stepIs(page, 'data')
    await tid(page, 'target-flow-0').selectOption({ index: 1 })
    await expect(tid(page, 'error-targets-0-flow_id')).toHaveCount(0)
    await tid(page, 'wizard-next').click()
    await stepIs(page, 'settings')

    if (!(await tid(page, 'business-hours').isChecked())) await tid(page, 'business-hours').check()
    for (const d of [0, 1, 2, 3, 4, 5, 6]) if ((await tid(page, `weekday-${d}`).getAttribute('aria-pressed')) === 'true') await tid(page, `weekday-${d}`).click()
    await tid(page, 'window-start').fill('18:00')
    await tid(page, 'window-end').fill('08:00')
    await tid(page, 'daily-limit').fill(String(q.remaining + 1))
    await tid(page, 'wizard-next').click()
    await stepIs(page, 'settings')
    await expect(tid(page, 'error-weekdays')).toBeVisible()
    await expect(tid(page, 'error-window_end')).toBeVisible()
    await expect(tid(page, 'error-daily_limit')).toBeVisible()

    await tid(page, 'weekday-1').click()
    await tid(page, 'window-start').fill('08:00')
    await tid(page, 'window-end').fill('18:00')
    await tid(page, 'daily-limit').fill('0')
    await tid(page, 'wizard-next').click()
    await stepIs(page, 'settings')
    await expect(tid(page, 'error-weekdays')).toHaveCount(0)
    await expect(tid(page, 'error-window_end')).toHaveCount(0)
    await expect(tid(page, 'error-daily_limit')).toBeVisible()
    await tid(page, 'daily-limit').fill('')
    await tid(page, 'wizard-next').click()
    await stepIs(page, 'audience')
    expect(await listOf(page)).toHaveLength(0)
  })

  test('AC-T83-02 erro de validação do servidor (fluxo pausado depois de abrir o wizard) aparece no campo do passo Dados', async ({ page }) => {
    await loginAs(page, 'owner')
    const { flow } = await seed(page, 2)
    await openPage(page)
    await openWizard(page)
    await tid(page, 'wizard-next').click()
    await tid(page, 'wizard-next').click()
    await stepIs(page, 'audience')
    await api(page, 'post', `/api/flows/${flow.id}/pause`)

    const resp = page.waitForResponse((r) => r.url().endsWith('/api/mass-dispatches') && r.request().method() === 'POST')
    await tid(page, 'wizard-submit').click()
    await tid(page, 'confirm-ok').click()
    expect((await resp).status()).toBe(422)
    await stepIs(page, 'data')
    await expect(tid(page, 'error-targets-0-flow_id')).toContainText(/ativo e publicado/i)
    await expect(tid(page, 'preparing')).toHaveCount(0)
    expect(await listOf(page)).toHaveLength(0)
  })

  test('AC-T83-02 conexão desconectada no servidor (409) volta ao passo Dados com o erro nos alvos', async ({ page }) => {
    await loginAs(page, 'owner')
    const { conn } = await seed(page, 2)
    await openPage(page)
    await openWizard(page)
    await tid(page, 'wizard-next').click()
    await tid(page, 'wizard-next').click()
    await stepIs(page, 'audience')
    await drive(page, conn.session_id, 'close')

    const resp = page.waitForResponse((r) => r.url().endsWith('/api/mass-dispatches') && r.request().method() === 'POST')
    await tid(page, 'wizard-submit').click()
    await tid(page, 'confirm-ok').click()
    expect((await resp).status()).toBe(409)
    await stepIs(page, 'data')
    await expect(tid(page, 'error-targets')).toBeVisible()
    expect(await listOf(page)).toHaveLength(0)
  })

  test('AC-T83-02 atalho de Contatos abre o wizard com a seleção como público e cria o disparo só para ela', async ({ page }) => {
    await loginAs(page, 'owner')
    const { people } = await seed(page, 4)
    const chosen = people.slice(0, 2)
    await page.goto('/customers')
    for (const c of chosen) await page.getByTestId(`contacts-select-${c.id}`).filter({ visible: true }).click()
    await page.getByTestId('contacts-bulk-dispatch').click()
    await expect(page).toHaveURL(/\/mass-dispatches(\/|\?|$)/)
    await expect(tid(page, 'wizard')).toBeVisible()
    await expect(tid(page, 'target-flow-0')).not.toHaveValue('')
    await tid(page, 'wizard-next').click()
    await tid(page, 'wizard-next').click()
    await stepIs(page, 'audience')
    await expect(tid(page, 'audience-draft')).toHaveAttribute('aria-checked', 'true')
    await expect(tid(page, 'audience-all')).toHaveAttribute('aria-checked', 'false')
    await expect(tid(page, 'audience-count')).toHaveAttribute('data-count', '2')
    await tid(page, 'wizard-submit').click()
    await tid(page, 'confirm-ok').click()
    await expectPrepared(page, 2)

    const md = await dispatchOf(page, (await listOf(page))[0].id)
    expect(md.total_count).toBe(2)
    const rec = await api(page, 'get', `/api/mass-dispatches/${md.id}/recipients?limit=100`)
    expect(rec.items.map((r: Any) => r.contact_id).sort()).toEqual(chosen.map((c) => c.id).sort())

    // recarregar não reabre o wizard
    await tid(page, 'preparing-close').click()
    await page.reload()
    await expect(page.getByTestId('page-mass-dispatch')).toBeVisible()
    await expect(tid(page, `item-${md.id}`)).toBeVisible()
    await expect(tid(page, 'wizard')).toHaveCount(0)
  })
})

test.describe('T83 — ritmo', () => {
  test('AC-T83-03 aviso de ritmo mais lento por limites de segurança no passo Configurações e na confirmação', async ({ page }) => {
    await loginAs(page, 'owner')
    await seed(page, 1)
    await openPage(page)
    await openWizard(page)
    await tid(page, 'wizard-next').click()
    await stepIs(page, 'settings')
    const notice = tid(page, 'pace-notice')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText(/ritmo real pode ser mais lento que o configurado/i)
    await expect(notice).toContainText(/limites de segurança/i)
    // vale para qualquer preset
    for (const p of ['slow', 'fast', 'custom', 'normal']) {
      await tid(page, `preset-${p}`).click()
      await expect(notice).toBeVisible()
    }
    await tid(page, 'wizard-next').click()
    await tid(page, 'wizard-submit').click()
    await expect(tid(page, 'confirm')).toContainText(/ritmo real pode ser mais lento que o configurado/i)
  })

  test('AC-T83-03 limite diário acima da capacidade de aquecimento da conexão nova gera o aviso no modal de preparação', async ({ page }) => {
    await loginAs(page, 'owner')
    await seed(page, 2)
    const q = await quotaOf(page)
    expect(q.remaining, 'cota do harness precisa comportar o limite diário do teste').toBeGreaterThanOrEqual(50)
    await openPage(page)
    await openWizard(page)
    await tid(page, 'wizard-next').click()
    await tid(page, 'daily-limit').fill('50')
    await tid(page, 'wizard-next').click()
    await tid(page, 'wizard-submit').click()
    await tid(page, 'confirm-ok').click()
    await expect(tid(page, 'preparing')).toBeVisible()
    const w = tid(page, 'warning-daily_limit_exceeds_warmup')
    await expect(w).toBeVisible()
    await expect(w).toContainText('20')
  })
})

test.describe('T83 — preparação e detalhes', () => {
  test('AC-T83-04 modal de preparação chega a "completed" só pelo SSE (GET do detalhe bloqueado)', async ({ page }) => {
    await loginAs(page, 'owner')
    await seed(page, 3)
    await openPage(page)
    // Sem o GET do detalhe, só o evento mass_dispatch.updated pode levar o modal às fases seguintes.
    await page.route(/\/api\/mass-dispatches\/[0-9a-f-]{36}(\?.*)?$/, (route) =>
      route.request().method() === 'GET' ? route.abort() : route.fallback(),
    )
    await openWizard(page)
    await tid(page, 'wizard-next').click()
    await tid(page, 'wizard-next').click()
    await tid(page, 'wizard-submit').click()
    await tid(page, 'confirm-ok').click()
    await expect(tid(page, 'preparing')).toBeVisible()
    for (const ph of PHASES) await expect(tid(page, `phase-${ph}`)).toBeVisible()
    await expectPrepared(page, 3)
  })

  test('AC-T83-04 "Ver detalhes" mostra status, A/B, alvos e configuração; Cancelar devolve a cota', async ({ page }) => {
    await loginAs(page, 'owner')
    const { conn, flow } = await seed(page, 3)
    const conn2 = await connected(page, `Filial ${uniq()}`)
    const flowB = await activeFlow(page, `Variante ${uniq()}`)
    const ab = await createViaApi(page, {
      name: `AB ${uniq()}`,
      targets: [{ connection_id: conn.id, flow_id: flow.id }, { connection_id: conn2.id, flow_id: flow.id }],
      flow_b_id: flowB.id,
      daily_limit: 15,
    })
    await prepared(page, ab.id)
    const d = await dispatchOf(page, ab.id)
    const usedBefore = (await quotaOf(page)).used

    await openPage(page)
    await tid(page, `item-details-${ab.id}`).click()
    const det = tid(page, 'details')
    await expect(det).toBeVisible()
    await sameStatus(page, 'details-status', ab.id)
    await sameProgress(page, 'details-counts', ab.id)
    await expect(tid(page, 'details-ab')).toHaveAttribute('data-ab', 'on')
    await expect(tid(page, 'details-ab-a')).toContainText(flow.name)
    await expect(tid(page, 'details-ab-b')).toContainText(flowB.name)
    await expect(tid(page, 'details-targets')).toBeVisible()
    for (const t of d.targets) {
      const row = tid(page, `details-target-${t.id}`)
      await expect(row).toContainText(t.connection_name)
      await expect(row).toContainText(`${t.assigned_count} agendados`)
    }
    expect(d.targets.reduce((s: number, t: Any) => s + t.assigned_count, 0)).toBe(3)
    await expect(tid(page, 'details-daily-limit')).toContainText('15')
    await expect(tid(page, 'details-interval')).toContainText(/5.*30/)

    // Cancelar pede confirmação; "voltar" não cancela
    await tid(page, 'details-cancel').click()
    await expect(tid(page, 'cancel-confirm')).toBeVisible()
    await tid(page, 'cancel-confirm-back').click()
    await expect(tid(page, 'cancel-confirm')).toHaveCount(0)
    expect((await dispatchOf(page, ab.id)).status).not.toBe('cancelled')
    await tid(page, 'details-cancel').click()
    // O harness já pode ter disparado parte dos envios: o devolvido é o que estava pendente no cancelamento.
    const cancelResp = page.waitForResponse((r) => r.url().endsWith(`/api/mass-dispatches/${ab.id}/cancel`) && r.request().method() === 'POST')
    await tid(page, 'cancel-confirm-ok').click()
    const cancelled = await (await cancelResp).json()
    const released = cancelled.released_count as number
    await expect(page.getByText(`${released} envio(s) devolvido(s) à cota`)).toBeVisible()
    await expect.poll(async () => (await dispatchOf(page, ab.id)).status).toBe('cancelled')
    await expect(tid(page, `item-status-${ab.id}`)).toHaveAttribute('data-status', 'cancelled')
    const after = await quotaOf(page)
    expect(after.used).toBe(usedBefore - released)
    await expect(tid(page, 'card-used')).toHaveAttribute('data-count', String(after.used))
    // cancelado não pode ser cancelado de novo
    await expect(tid(page, `item-cancel-${ab.id}`)).toHaveCount(0)
  })

  test('AC-T83-04 disparo sem fluxo B mostra "Sem teste A/B"; cancelar pela linha da tabela', async ({ page }) => {
    await loginAs(page, 'owner')
    const { conn, flow } = await seed(page, 2)
    const md = await createViaApi(page, { targets: [{ connection_id: conn.id, flow_id: flow.id }] })
    await prepared(page, md.id)
    await openPage(page)
    await tid(page, `item-details-${md.id}`).click()
    await expect(tid(page, 'details-ab')).toHaveAttribute('data-ab', 'off')
    await expect(tid(page, 'details-ab-a')).toContainText(flow.name)
    await expect(tid(page, 'details-ab-b')).toContainText('Sem teste A/B')
    await tid(page, 'details-close').click()
    await expect(tid(page, 'details')).toHaveCount(0)

    await tid(page, `item-cancel-${md.id}`).click()
    await tid(page, 'cancel-confirm-ok').click()
    await expect(tid(page, `item-status-${md.id}`)).toHaveAttribute('data-status', 'cancelled')
    expect((await dispatchOf(page, md.id)).status).toBe('cancelled')
  })

  test('AC-T83-04 member vê a página e os detalhes, sem "Novo disparo" nem Cancelar', async ({ page, browser }) => {
    await loginAs(page, 'owner')
    const { conn, flow } = await seed(page, 1)
    const md = await createViaApi(page, { targets: [{ connection_id: conn.id, flow_id: flow.id }] })
    await prepared(page, md.id)

    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'pt-BR' })
    const member = await ctx.newPage()
    try {
      await loginAs(member, 'member')
      await member.goto('/mass-dispatches')
      await expect(member.getByTestId('page-mass-dispatch')).toBeVisible()
      await expect(tid(member, `item-${md.id}`)).toBeVisible()
      await expect(tid(member, 'new')).toHaveCount(0)
      await expect(tid(member, `item-cancel-${md.id}`)).toHaveCount(0)
      await tid(member, `item-details-${md.id}`).click()
      await expect(tid(member, 'details')).toBeVisible()
      await expect(tid(member, 'details-ab')).toBeVisible()
      await expect(tid(member, 'details-cancel')).toHaveCount(0)
    } finally {
      await ctx.close()
    }
  })
})
