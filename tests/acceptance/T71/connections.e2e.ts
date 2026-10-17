// T71 — UI de conexões (E2E no harness da T17). Contrato em spec/reports/T71-entrega.md: testids `connections-*`,
// search params `?search=&filter=&page=`, rota de harness `POST /__e2e/wa/sessions/:sessionId/state` (muda a sessão no
// FakeWaGateway e publica os eventos no stream → projetor da T47 → SSE), retomar/cancelar pausados e limite via
// `PATCH /api/admin/companies/:id` (platform admin). Desktop; o AC-T71-05 roda também no mobile.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, request as pwRequest, test, type Page } from '@playwright/test'
import { dbUrl, lit, sqlOk } from '../helpers/pg'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed, SEED_PASSWORD, SEED_USERS } from '../helpers/e2e'
import { createConnection, newChat, trackSse, waitSseOpen, XRW } from '../helpers/chats-e2e'

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const FORBIDDEN_TEXT = /API Oficial|Embedded Signup|imune a ban/i

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown) {
  const res = await page.request[method](path, { ...(method === 'get' ? {} : { data: data ?? {} }), headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

/** Leva a sessão do fake a um estado e espera o worker consumir os eventos publicados. */
async function drive(page: Page, sessionId: string, body: Record<string, unknown>) {
  const res = await page.request.post(`/__e2e/wa/sessions/${sessionId}/state`, { data: body, headers: XRW })
  expect(res.status(), await res.text()).toBe(202)
  const { events } = await res.json()
  for (const e of events as Array<{ stream_id: string }>) {
    const d = await page.request.get(`/__e2e/wa/deliveries?stream_id=${encodeURIComponent(e.stream_id)}&wait_ms=10000`)
    expect((await d.json()).acked, 'worker do harness não consumiu o evento').toBe(true)
  }
}

const connectionOf = async (page: Page, id: string) => (await api(page, 'get', `/api/connections/${id}`)).connection

async function openList(page: Page, query = '') {
  await trackSse(page)
  await page.goto(`/connections${query}`)
  await expect(page.getByTestId('page-connections')).toBeVisible()
  await waitSseOpen(page)
}

async function openAction(page: Page, id: string, action: string) {
  await page.getByTestId(`connections-item-actions-${id}`).click()
  await expect(page.getByTestId('connections-actions-menu')).toBeVisible()
  await page.getByTestId(`connections-action-${action}-${id}`).click()
}

/** Marca a janela: se a página recarregar, a marca some. */
const markWindow = (page: Page) => page.evaluate(() => ((window as any).__t71 = 'same-page'))
const sameWindow = (page: Page) => page.evaluate(() => (window as any).__t71 === 'same-page')

// Fluxo com espera de resposta (1 h): o run fica `waiting` no chat (mesmo modelo da T91).
const waitFlowDef = {
  schema: 'crm.flow/v1',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
    { id: 'W', type: 'wait_response', name: 'Espera', position: { x: 200, y: 0 }, actions: [{ id: 'W-a1', type: 'wait_for_response', order: 0, config: { wait_indefinitely: false, timeout_value: 1, timeout_unit: 'hours' } }] },
    { id: 'R', type: 'message', name: 'Resposta', position: { x: 400, y: 0 }, actions: [{ id: 'R-a1', type: 'send_message', order: 0, config: { message_text: 'obrigado' } }] },
    { id: 'T', type: 'message', name: 'Timeout', position: { x: 400, y: 200 }, actions: [{ id: 'T-a1', type: 'send_message', order: 0, config: { message_text: 'tchau' } }] },
  ],
  edges: [
    { id: 'e1', from: 'start', handle: 'source', to: 'W' },
    { id: 'e2', from: 'W', handle: 'source', to: 'R' },
    { id: 'e3', from: 'W', handle: 'timeout', to: 'T' },
  ],
  variables: [],
  refs: {},
}

/** Banco do harness deste worktree (test-results/e2e-server.json). */
function harnessDb(): string {
  const info = JSON.parse(readFileSync(join(process.cwd(), 'test-results', 'e2e-server.json'), 'utf8'))
  return dbUrl(info.database)
}

const runStatus = async (page: Page, runId: string) => (await api(page, 'get', `/api/flow-runs/${runId}`)).run.status as string

/** Run `waiting` num chat novo da conexão (inbound do harness + disparo manual do fluxo, T43). */
async function waitingRun(page: Page, sessionId: string) {
  const chat = await newChat(page, sessionId)
  const { flow } = await api(page, 'post', '/api/flows', { name: `Fluxo ${uniq()}` })
  await api(page, 'put', `/api/flows/${flow.id}/definition`, waitFlowDef)
  await api(page, 'post', `/api/flows/${flow.id}/activate`)
  const { run } = await api(page, 'post', `/api/flows/${flow.id}/trigger`, { chat_id: chat.id })
  // O worker in-process do harness não liga o `flow-step` (scripts/e2e/api.ts sem `configureFlowStep`): o run
  // disparado fica em `running`. Leva o run ao estado que o nó de espera deixaria (waiting com prazo de 1 h) direto
  // no banco do harness (mesmo recurso da T88), para a queda/volta da conexão agirem sobre ele.
  const wait = JSON.stringify({ kind: 'reply', handles: { reply: 'source', timeout: 'timeout' }, deadline_at: new Date(Date.now() + 3_600_000).toISOString(), timer_gen: 0 })
  sqlOk(harnessDb(), `UPDATE crm.flow_runs SET status = 'waiting', wait = ${lit(wait)}::jsonb, updated_at = now() WHERE id = ${lit(run.id)};`)
  await expect.poll(() => runStatus(page, run.id), { timeout: 20_000 }).toBe('waiting')
  return { runId: run.id as string, chatId: chat.id }
}

async function expectNoForbiddenText(page: Page) {
  const text = await page.evaluate(() => document.body.innerText)
  expect(text).not.toMatch(FORBIDDEN_TEXT)
}

/** Login do platform admin num contexto à parte e PATCH do limite de conexões da empresa. */
async function setConnectionsLimit(baseURL: string, companyId: string, limit: number | null) {
  const ctx = await pwRequest.newContext({ baseURL })
  try {
    const login = await ctx.post('/api/auth/login', { data: { email: SEED_USERS.platformAdmin, password: SEED_PASSWORD }, headers: XRW })
    expect(login.status(), await login.text()).toBe(200)
    const res = await ctx.patch(`/api/admin/companies/${companyId}`, { data: { limits: { connections: limit } }, headers: XRW })
    expect(res.status(), await res.text()).toBeLessThan(300)
  } finally {
    await ctx.dispose()
  }
}

test.describe('T71 — UI conexões', () => {
  test('AC-T71-01 lista com cards de contagem, busca, filtro de status e tabela com badges e datas', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const pend = await createConnection(page, `Pendente ${tag}`)
    const warm = await createConnection(page, `Aquecendo ${tag}`)
    const degr = await createConnection(page, `Degradada ${tag}`)
    const down = await createConnection(page, `Caiu ${tag}`)
    await drive(page, warm.session_id, { to: 'open', session_state: 'WARMING' })
    await drive(page, degr.session_id, { to: 'open', session_state: 'DEGRADED' })
    await drive(page, down.session_id, { to: 'open' })
    await drive(page, down.session_id, { to: 'close', reason: 'transient' })

    await openList(page)
    const table = page.getByTestId('connections-table')
    await expect(table).toBeVisible()
    for (const col of ['Conexão', 'Status', 'Criada em', 'Desconectada em', 'Ações']) await expect(table.locator('thead')).toContainText(col)

    // cards de contagem
    const count = (k: string) => page.getByTestId(`connections-count-${k}`)
    await expect(count('total')).toHaveAttribute('data-count', '4')
    await expect(count('pending')).toHaveAttribute('data-count', '1')
    await expect(count('connected')).toHaveAttribute('data-count', '2')
    await expect(count('disconnected')).toHaveAttribute('data-count', '1')
    await expect(count('banned')).toHaveAttribute('data-count', '0')

    // linhas: status, badges de aquecimento/saúde, criada em, desconectada em
    await expect(page.getByTestId(`connections-item-status-${pend.id}`)).toHaveAttribute('data-status', 'pending')
    await expect(page.getByTestId(`connections-item-status-${warm.id}`)).toHaveAttribute('data-status', 'connected')
    await expect(page.getByTestId(`connections-item-badge-warming-${warm.id}`)).toBeVisible()
    await expect(page.getByTestId(`connections-item-badge-degraded-${degr.id}`)).toBeVisible()
    await expect(page.getByTestId(`connections-item-badge-warming-${degr.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`connections-item-status-${down.id}`)).toHaveAttribute('data-status', 'disconnected')
    await expect(page.getByTestId(`connections-item-name-${pend.id}`)).toHaveText(`Pendente ${tag}`)
    await expect(page.getByTestId(`connections-item-created-${pend.id}`)).not.toHaveText('—')
    await expect(page.getByTestId(`connections-item-created-${pend.id}`)).toHaveText(/\d/)
    await expect(page.getByTestId(`connections-item-disconnected-${pend.id}`)).toHaveText('—')
    await expect(page.getByTestId(`connections-item-disconnected-${down.id}`)).toHaveText(/\d/)
    await expect(page.getByTestId(`connections-item-actions-${pend.id}`)).toBeVisible()

    // busca (nome) → URL e linhas
    await page.getByTestId('connections-search').fill(`Aquecendo ${tag}`)
    await expect(page).toHaveURL(/[?&]search=/)
    await expect(page.getByTestId(`connections-item-${warm.id}`)).toBeVisible()
    await expect(page.getByTestId(`connections-item-${pend.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`connections-item-${down.id}`)).toHaveCount(0)
    await page.getByTestId('connections-search').fill('')
    await expect(page).not.toHaveURL(/[?&]search=/)
    await expect(page.getByTestId(`connections-item-${pend.id}`)).toBeVisible()

    // filtro de status (select) → ?filter=
    await page.getByTestId('connections-status-filter').selectOption('connected')
    await expect(page).toHaveURL(/[?&]filter=connected/)
    await expect(page.getByTestId(`connections-item-${warm.id}`)).toBeVisible()
    await expect(page.getByTestId(`connections-item-${degr.id}`)).toBeVisible()
    await expect(page.getByTestId(`connections-item-${pend.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`connections-item-${down.id}`)).toHaveCount(0)
    // os cards continuam contando tudo (antes do filtro)
    await expect(count('total')).toHaveAttribute('data-count', '4')

    // clique no card filtra; o filtro sobrevive ao recarregar (URL é contrato)
    await count('disconnected').click()
    await expect(page).toHaveURL(/[?&]filter=disconnected/)
    await expect(page.getByTestId(`connections-item-${down.id}`)).toBeVisible()
    await expect(page.getByTestId(`connections-item-${warm.id}`)).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('connections-status-filter')).toHaveValue('disconnected')
    await expect(page.getByTestId(`connections-item-${down.id}`)).toBeVisible()
    await expect(page.getByTestId(`connections-item-${pend.id}`)).toHaveCount(0)

    // "todos" volta a mostrar tudo
    await page.getByTestId('connections-status-filter').selectOption('')
    await expect(page).not.toHaveURL(/[?&]filter=/)
    await expect(page.getByTestId(`connections-item-${pend.id}`)).toBeVisible()
    await expectNoForbiddenText(page)
  })

  test('AC-T71-01 busca por telefone e filtro vazio mostram estado sem resultados', async ({ page }) => {
    await loginAs(page, 'owner')
    const c = await createConnection(page, `Loja ${uniq()}`)
    await openList(page, '?filter=banned')
    await expect(page.getByTestId('connections-status-filter')).toHaveValue('banned')
    await expect(page.getByTestId(`connections-item-${c.id}`)).toHaveCount(0)
    await expect(page.getByTestId('connections-empty')).toBeVisible()
    // queda com motivo forbidden → banida (status próprio), aparece no filtro sem recarregar
    await drive(page, c.session_id, { to: 'open' })
    await drive(page, c.session_id, { to: 'close', reason: 'forbidden', status_code: 403 })
    await expect(page.getByTestId(`connections-item-status-${c.id}`)).toHaveAttribute('data-status', 'banned')
    await expect(page.getByTestId('connections-count-banned')).toHaveAttribute('data-count', '1')
  })

  test('AC-T71-02 Conectar: QR atualiza com connection.qr_updated, código no telefone, e connected fecha o modal sem recarregar', async ({ page }) => {
    await loginAs(page, 'owner')
    const c = await createConnection(page, `Conectar ${uniq()}`)
    await openList(page)
    await markWindow(page)
    await expect(page.getByTestId(`connections-item-status-${c.id}`)).toHaveAttribute('data-status', 'pending')

    await openAction(page, c.id, 'connect')
    const modal = page.getByTestId('connections-connect')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('connections-connect-tab-qr')).toHaveAttribute('aria-selected', 'true')
    const img = page.getByTestId('connections-qr-image')
    await expect(img).toHaveAttribute('data-qr', /^data:image\//)
    const first = await img.getAttribute('data-qr')

    // QR novo pelo evento (session.qr → connection.qr_updated)
    const NEW_QR = `data:image/png;base64,${Buffer.from(`qr-${uniq()}`).toString('base64')}`
    expect(NEW_QR).not.toBe(first)
    await drive(page, c.session_id, { to: 'qr', qr: NEW_QR })
    await expect(img).toHaveAttribute('data-qr', NEW_QR)
    await expect(img).toHaveAttribute('src', NEW_QR)

    // aba "Código no telefone": validação do número e código do pareamento
    await page.getByTestId('connections-connect-tab-phone').click()
    await expect(page.getByTestId('connections-connect-tab-phone')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('connections-connect-tab-qr')).toHaveAttribute('aria-selected', 'false')
    await page.getByTestId('connections-pairing-phone').fill('123')
    await page.getByTestId('connections-pairing-submit').click()
    await expect(page.getByTestId('connections-pairing-phone-error')).toBeVisible()
    await expect(page.getByTestId('connections-pairing-code')).toHaveCount(0)
    await page.getByTestId('connections-pairing-phone').fill('5511999999999')
    await page.getByTestId('connections-pairing-submit').click()
    await expect(page.getByTestId('connections-pairing-code')).toHaveAttribute('data-code', 'FAKE1234')
    // código novo chegando pelo evento (connection.pairing_code)
    await drive(page, c.session_id, { to: 'connecting', code: 'ZX12CV34' })
    await expect(page.getByTestId('connections-pairing-code')).toHaveAttribute('data-code', 'ZX12CV34')

    // conectou (connection.connected via harness): modal fecha e status muda sem recarregar
    await drive(page, c.session_id, { to: 'open' })
    await expect(modal).toBeHidden()
    await expect(page.getByTestId(`connections-item-status-${c.id}`)).toHaveAttribute('data-status', 'connected')
    // o refetch da lista confirma (não desfaz) o conectado
    await page.waitForResponse((r) => r.url().includes('/api/connections') && r.request().method() === 'GET' && r.status() === 200, { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(1_000)
    await expect(page.getByTestId(`connections-item-status-${c.id}`)).toHaveAttribute('data-status', 'connected')
    await expect(page.getByTestId('connections-count-connected')).toHaveAttribute('data-count', '1')
    expect(await sameWindow(page), 'a página recarregou').toBe(true)
    expect((await connectionOf(page, c.id)).status).toBe('connected')
    await expectNoForbiddenText(page)
  })

  test('AC-T71-02 queda e retorno pelo harness mudam status e "desconectada em" sem recarregar', async ({ page }) => {
    await loginAs(page, 'owner')
    const c = await createConnection(page, `Queda ${uniq()}`)
    await drive(page, c.session_id, { to: 'open' })
    await openList(page)
    await markWindow(page)
    await expect(page.getByTestId(`connections-item-status-${c.id}`)).toHaveAttribute('data-status', 'connected')
    await expect(page.getByTestId(`connections-item-disconnected-${c.id}`)).toHaveText('—')

    await drive(page, c.session_id, { to: 'close', reason: 'transient' })
    await expect(page.getByTestId(`connections-item-status-${c.id}`)).toHaveAttribute('data-status', 'disconnected')
    await expect(page.getByTestId(`connections-item-disconnected-${c.id}`)).toHaveText(/\d/)
    await page.waitForTimeout(1_000)
    await expect(page.getByTestId(`connections-item-status-${c.id}`)).toHaveAttribute('data-status', 'disconnected')

    await drive(page, c.session_id, { to: 'open' })
    await expect(page.getByTestId(`connections-item-status-${c.id}`)).toHaveAttribute('data-status', 'connected')
    expect(await sameWindow(page), 'a página recarregou').toBe(true)
  })

  test('AC-T71-03 proxy: senha mascarada, aviso de reinício, senha vazia mantém a salva e "apagar senha"', async ({ page }) => {
    await loginAs(page, 'owner')
    const c = await createConnection(page, `Proxy ${uniq()}`)
    const SECRET = `segredo-${uniq()}`
    await openList(page)

    await openAction(page, c.id, 'proxy')
    const editor = page.getByTestId('connections-proxy-editor')
    await expect(editor).toBeVisible()
    await expect(page.getByTestId('connections-proxy-restart-warning')).toBeVisible()
    await expect(page.getByTestId('connections-proxy-restart-warning')).toContainText(/reinici/i)
    await expect(page.getByTestId('connections-proxy-password')).toHaveAttribute('type', 'password')
    await expect(page.getByTestId('connections-proxy-remove-password')).toHaveCount(0)
    await page.getByTestId('connections-proxy-protocol').selectOption('socks5')
    await page.getByTestId('connections-proxy-host').fill('proxy.exemplo.test')
    await page.getByTestId('connections-proxy-port').fill('1080')
    await page.getByTestId('connections-proxy-username').fill('usuario')
    await page.getByTestId('connections-proxy-password').fill(SECRET)
    await page.getByTestId('connections-proxy-save').click()
    await expect(editor).toBeHidden()

    // selos de proxy e de reinício necessário na linha; a senha nunca volta
    await expect(page.getByTestId(`connections-item-badge-proxy-${c.id}`)).toBeVisible()
    await expect(page.getByTestId(`connections-item-badge-requires_restart-${c.id}`)).toBeVisible()
    let conn = await connectionOf(page, c.id)
    expect(conn.proxy).toMatchObject({ protocol: 'socks5', host: 'proxy.exemplo.test', port: 1080, username: 'usuario', has_password: true })
    expect(conn.requires_restart).toBe(true)
    expect(JSON.stringify(conn)).not.toContain(SECRET)

    // reabrir: campos preenchidos, senha vazia e mascarada (placeholder), nunca o valor
    await openAction(page, c.id, 'proxy')
    await expect(editor).toBeVisible()
    await expect(page.getByTestId('connections-proxy-host')).toHaveValue('proxy.exemplo.test')
    await expect(page.getByTestId('connections-proxy-port')).toHaveValue('1080')
    const pwd = page.getByTestId('connections-proxy-password')
    await expect(pwd).toHaveAttribute('type', 'password')
    await expect(pwd).toHaveValue('')
    await expect(pwd).toHaveAttribute('placeholder', /•/)
    expect(await page.content()).not.toContain(SECRET)
    // salvar com senha em branco mantém a salva
    await page.getByTestId('connections-proxy-port').fill('1081')
    await page.getByTestId('connections-proxy-save').click()
    await expect(editor).toBeHidden()
    await expect.poll(async () => (await connectionOf(page, c.id)).proxy?.port).toBe(1081)
    expect((await connectionOf(page, c.id)).proxy.has_password).toBe(true)

    // "Apagar a senha salva": desabilitado com senha digitada; marcado sem senha → apaga só a senha
    await openAction(page, c.id, 'proxy')
    await expect(editor).toBeVisible()
    const remove = page.getByTestId('connections-proxy-remove-password')
    await expect(remove).toBeVisible()
    await pwd.fill('outra')
    await expect(remove).toBeDisabled()
    await pwd.fill('')
    await expect(remove).toBeEnabled()
    await remove.check()
    await page.getByTestId('connections-proxy-save').click()
    await expect(editor).toBeHidden()
    await expect.poll(async () => (await connectionOf(page, c.id)).proxy?.has_password).toBe(false)
    conn = await connectionOf(page, c.id)
    expect(conn.proxy).toMatchObject({ host: 'proxy.exemplo.test', port: 1081 })

    // Remover proxy
    await openAction(page, c.id, 'proxy')
    await expect(editor).toBeVisible()
    await page.getByTestId('connections-proxy-remove').click()
    await expect(editor).toBeHidden()
    await expect.poll(async () => (await connectionOf(page, c.id)).proxy).toBeNull()
    await expect(page.getByTestId(`connections-item-badge-proxy-${c.id}`)).toHaveCount(0)
  })

  test('AC-T71-03 configurações da instância salvam e reabrem com os valores', async ({ page }) => {
    await loginAs(page, 'owner')
    const c = await createConnection(page, `Instancia ${uniq()}`)
    const before = await connectionOf(page, c.id)
    await openList(page)

    await openAction(page, c.id, 'instance')
    const editor = page.getByTestId('connections-instance-editor')
    await expect(editor).toBeVisible()
    await page.getByTestId('connections-instance-ephemeral').selectOption('7d')
    await page.getByTestId('connections-instance-save-contacts').setChecked(!before.save_contacts_enabled)
    await page.getByTestId('connections-instance-notify-mine').setChecked(!before.notify_sent_by_me)
    await page.getByTestId('connections-instance-save').click()
    await expect(editor).toBeHidden()

    await expect.poll(async () => (await connectionOf(page, c.id)).ephemeral_duration).toBe('7d')
    const after = await connectionOf(page, c.id)
    expect(after.save_contacts_enabled).toBe(!before.save_contacts_enabled)
    expect(after.notify_sent_by_me).toBe(!before.notify_sent_by_me)

    await openAction(page, c.id, 'instance')
    await expect(editor).toBeVisible()
    await expect(page.getByTestId('connections-instance-ephemeral')).toHaveValue('7d')
    if (after.save_contacts_enabled) await expect(page.getByTestId('connections-instance-save-contacts')).toBeChecked()
    else await expect(page.getByTestId('connections-instance-save-contacts')).not.toBeChecked()
    if (after.notify_sent_by_me) await expect(page.getByTestId('connections-instance-notify-mine')).toBeChecked()
    else await expect(page.getByTestId('connections-instance-notify-mine')).not.toBeChecked()
  })

  test('AC-T71-03 "Parar todos os fluxos" exige digitar o nome exato e cancela os runs da conexão', async ({ page }) => {
    await loginAs(page, 'owner')
    const name = `Parar ${uniq()}`
    const c = await createConnection(page, name)
    await drive(page, c.session_id, { to: 'open' })
    const { runId } = await waitingRun(page, c.session_id)
    await openList(page)

    await openAction(page, c.id, 'stop-flows')
    await expect(page.getByTestId('connections-stop-flows')).toBeVisible()
    const confirm = page.getByTestId('connections-stop-flows-confirm')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('connections-stop-flows-name').fill(name.toLowerCase())
    await expect(confirm).toBeDisabled()
    await page.getByTestId('connections-stop-flows-name').fill(`${name} `)
    await expect(confirm).toBeDisabled()
    await page.getByTestId('connections-stop-flows-name').fill(name)
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(page.getByTestId('connections-stop-flows')).toBeHidden()
    await expect.poll(() => runStatus(page, runId)).toBe('cancelled')

    // cancelar o modal não faz nada
    const other = await waitingRun(page, c.session_id)
    await openAction(page, c.id, 'stop-flows')
    await page.getByTestId('connections-stop-flows-name').fill(name)
    await page.getByTestId('connections-stop-flows-cancel').click()
    await expect(page.getByTestId('connections-stop-flows')).toBeHidden()
    expect(await runStatus(page, other.runId)).toBe('waiting')
  })

  test('AC-T71-04 reconexão com fluxos pausados abre o modal Retomar/Cancelar; Retomar volta o run a waiting', async ({ page }) => {
    await loginAs(page, 'owner')
    const c = await createConnection(page, `Pausa ${uniq()}`)
    await drive(page, c.session_id, { to: 'open' })
    const { runId } = await waitingRun(page, c.session_id)
    await openList(page)
    await markWindow(page)
    await expectNoForbiddenText(page)

    // queda: o projetor pausa o run waiting do chat da conexão
    await drive(page, c.session_id, { to: 'close', reason: 'transient' })
    await expect(page.getByTestId(`connections-item-status-${c.id}`)).toHaveAttribute('data-status', 'disconnected')
    await expect.poll(() => runStatus(page, runId)).toBe('paused')
    await expect(page.getByTestId('connections-paused-flows')).toHaveCount(0)

    // volta: connection.reconnected_with_paused_flows abre o modal com as contagens
    await drive(page, c.session_id, { to: 'open' })
    const modal = page.getByTestId('connections-paused-flows')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('connections-paused-flows-paused-count')).toHaveAttribute('data-count', '1')
    await expect(page.getByTestId('connections-paused-flows-total-leads')).toHaveAttribute('data-count', '1')
    await expect(page.getByTestId('connections-paused-flows-resume')).toBeVisible()
    await expect(page.getByTestId('connections-paused-flows-cancel')).toBeVisible()
    expect(await sameWindow(page), 'a página recarregou').toBe(true)
    await expectNoForbiddenText(page)

    await page.getByTestId('connections-paused-flows-resume').click()
    await expect(modal).toBeHidden()
    await expect.poll(() => runStatus(page, runId)).toBe('waiting')
    const summary = await api(page, 'get', `/api/connections/${c.id}/paused-flows`)
    expect(summary.paused_count).toBe(0)
    // sem pausados, o menu não oferece "Fluxos pausados na queda"
    await page.getByTestId(`connections-item-actions-${c.id}`).click()
    await expect(page.getByTestId('connections-actions-menu')).toBeVisible()
    await expect(page.getByTestId(`connections-action-stop-flows-${c.id}`)).toBeVisible()
    await expect(page.getByTestId(`connections-action-paused-flows-${c.id}`)).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('AC-T71-04 "Depois" mantém pausados, o menu reabre o modal e Cancelar cancela os runs', async ({ page }) => {
    await loginAs(page, 'owner')
    const c = await createConnection(page, `Cancela ${uniq()}`)
    await drive(page, c.session_id, { to: 'open' })
    const a = await waitingRun(page, c.session_id)
    const b = await waitingRun(page, c.session_id)
    await openList(page)

    await drive(page, c.session_id, { to: 'close', reason: 'transient' })
    await expect.poll(() => runStatus(page, b.runId)).toBe('paused')
    await drive(page, c.session_id, { to: 'open' })
    const modal = page.getByTestId('connections-paused-flows')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('connections-paused-flows-paused-count')).toHaveAttribute('data-count', '2')
    await expect(page.getByTestId('connections-paused-flows-total-leads')).toHaveAttribute('data-count', '2')

    // Depois: fecha sem mexer
    await page.getByTestId('connections-paused-flows-later').click()
    await expect(modal).toBeHidden()
    expect(await runStatus(page, a.runId)).toBe('paused')

    // pelo menu da linha (contagens vêm da API)
    await openAction(page, c.id, 'paused-flows')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('connections-paused-flows-paused-count')).toHaveAttribute('data-count', '2')
    await expectNoForbiddenText(page)
    await page.getByTestId('connections-paused-flows-cancel').click()
    await expect(modal).toBeHidden()
    await expect.poll(() => runStatus(page, a.runId)).toBe('cancelled')
    await expect.poll(() => runStatus(page, b.runId)).toBe('cancelled')
  })

  test('AC-T71-04 nenhum texto da tela ou dos modais menciona API Oficial, Embedded Signup ou "imune a ban"', async ({ page }) => {
    await loginAs(page, 'owner')
    const c = await createConnection(page, `Marca ${uniq()}`)
    await openList(page)
    await expectNoForbiddenText(page)
    await page.getByTestId('connections-new').click()
    await expect(page.getByTestId('connections-name-editor')).toBeVisible()
    await expectNoForbiddenText(page)
    await page.getByTestId('connections-name-cancel').click()
    for (const [action, testid] of [
      ['connect', 'connections-connect'],
      ['proxy', 'connections-proxy-editor'],
      ['instance', 'connections-instance-editor'],
      ['stop-flows', 'connections-stop-flows'],
    ] as const) {
      await openAction(page, c.id, action)
      await expect(page.getByTestId(testid)).toBeVisible()
      if (action === 'connect') await page.getByTestId('connections-connect-tab-phone').click()
      await expectNoForbiddenText(page)
      await page.keyboard.press('Escape')
      await expect(page.getByTestId(testid)).toBeHidden()
    }
  })

  test('AC-T71-05 sem limite "Nova conexão" fica disponível; com limite atingido fica desabilitado com a explicação; mobile em cartões', async ({ page, baseURL }) => {
    const login = await loginAs(page, 'owner')
    const companyId: string = (login.companies.find((x: any) => x.name === 'Empresa Demo') ?? login.companies[0]).id
    const tag = uniq()
    const a = await createConnection(page, `Limite A ${tag}`)
    await createConnection(page, `Limite B ${tag}`)

    // sem limite definido: sempre disponível, e cria pela UI
    await setConnectionsLimit(baseURL!, companyId, null)
    await openList(page)
    const btn = page.getByTestId('connections-new')
    await expect(btn).toBeEnabled()
    await expect(btn).not.toHaveAttribute('data-disabled-reason', /.+/)
    await expect(page.getByTestId('connections-limit-reason')).toHaveCount(0)
    await expect(page.getByTestId('connections-usage')).toContainText('2')
    await btn.click()
    await expect(page.getByTestId('connections-name-editor')).toBeVisible()
    await page.getByTestId('connections-name-input').fill(`Limite C ${tag}`)
    await page.getByTestId('connections-name-save').click()
    await expect(page.getByTestId('connections-name-editor')).toBeHidden()
    await expect(page.getByTestId('connections-count-total')).toHaveAttribute('data-count', '3')
    await expect(btn).toBeEnabled()

    // layout: tabela no desktop, cartões no mobile, sem rolagem horizontal
    if (isMobile(page)) {
      await expect(page.getByTestId('connections-cards')).toBeVisible()
      await expect(page.getByTestId('connections-table')).toHaveCount(0)
      await expect(page.getByTestId('connections-cards').getByTestId(`connections-item-${a.id}`)).toBeVisible()
      await expect(page.getByTestId(`connections-item-status-${a.id}`)).toBeVisible()
      await expect(page.getByTestId(`connections-item-created-${a.id}`)).toBeVisible()
      await expect(page.getByTestId(`connections-item-disconnected-${a.id}`)).toBeVisible()
      await expect(page.getByTestId(`connections-item-actions-${a.id}`)).toBeVisible()
      await expectNoHorizontalScroll(page)
    } else {
      await expect(page.getByTestId('connections-table')).toBeVisible()
      await expect(page.getByTestId('connections-cards')).toHaveCount(0)
    }

    // limite definido e atingido (3 de 3): desabilitado com explicação
    await setConnectionsLimit(baseURL!, companyId, 3)
    await page.reload()
    await expect(page.getByTestId('page-connections')).toBeVisible()
    await expect(btn).toBeDisabled()
    await expect(btn).toHaveAttribute('data-disabled-reason', 'limit_reached')
    const reason = page.getByTestId('connections-limit-reason')
    await expect(reason).toBeVisible()
    await expect(reason).toContainText('3')
    const describedBy = await btn.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(await reason.getAttribute('id')).toBe(describedBy)
    await expect(page.getByTestId('connections-usage')).toContainText(/3\D+3/)
    if (isMobile(page)) await expectNoHorizontalScroll(page)
    // a API confirma o bloqueio
    const res = await page.request.post('/api/connections', { data: { name: `Excedente ${tag}` }, headers: XRW })
    expect(res.status()).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('LIMIT_REACHED')

    // limite definido e não atingido: disponível
    await setConnectionsLimit(baseURL!, companyId, 5)
    await page.reload()
    await expect(btn).toBeEnabled()
    await expect(page.getByTestId('connections-limit-reason')).toHaveCount(0)
    await expect(page.getByTestId('connections-usage')).toContainText(/3\D+5/)

    // de volta a sem limite
    await setConnectionsLimit(baseURL!, companyId, null)
    await page.reload()
    await expect(btn).toBeEnabled()
    await expect(page.getByTestId('connections-limit-reason')).toHaveCount(0)
  })
})
