// AC-T102-02 (Playwright desktop, harness da T17): jornada de atendimento pela web.
// Chat novo na fila → atendente "Atribuir a mim" → responde texto e áudio PTT pelo compositor → move o card no kanban
// (arrasto) → resolve → métricas de atendimento (API e aba Atendimento do dashboard) refletem o chat.
// A web não tem botão de resolver (T69/T91): o resolve é pela API, como a tela de chats faz pelo menu do contrato.
import { expect, test, type Page, type Request } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { createConnection, messagesOf, newChat, trackSse, waitSseOpen, XRW } from '../helpers/chats-e2e'

// microfone falso do Chromium para o PTT (padrão T85)
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }, permissions: ['microphone'] })

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const isMessagePost = (chatId: string) => (r: Request) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/chats/${chatId}/messages`

async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown) {
  const res = await page.request[method](path, { ...(method === 'get' ? {} : { data: data ?? {} }), headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

async function drive(page: Page, sessionId: string, body: Record<string, unknown>) {
  const res = await page.request.post(`/__e2e/wa/sessions/${sessionId}/state`, { data: body, headers: XRW })
  expect(res.status(), await res.text()).toBe(202)
  for (const e of (await res.json()).events as Array<{ stream_id: string }>) {
    const d = await page.request.get(`/__e2e/wa/deliveries?stream_id=${encodeURIComponent(e.stream_id)}&wait_ms=10000`)
    expect((await d.json()).acked).toBe(true)
  }
}

/** Arrasto com o ponteiro (dnd-kit, padrão T70). */
async function drag(page: Page, from: ReturnType<Page['getByTestId']>, to: ReturnType<Page['getByTestId']>) {
  await from.scrollIntoViewIfNeeded()
  const a = (await from.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 5 })
  await to.scrollIntoViewIfNeeded().catch(() => {})
  const b = (await to.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 40), { steps: 20 })
  await page.mouse.move(b.x + b.width / 2 + 2, b.y + Math.min(b.height / 2, 40) + 2, { steps: 3 })
  await page.mouse.up()
}

/** Data de hoje no fuso da empresa (seed: America/Sao_Paulo). */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

test.describe('T102 — jornada de atendimento (AC-T102-02)', () => {
  test('AC-T102-02 atendente assume, responde texto e áudio PTT, move o card no kanban, resolve; métricas de atendimento refletem o chat', async ({ page }) => {
    const login = await loginAs(page, 'owner')
    const me = login.user.id as string
    const conn = await createConnection(page, `Atendimento ${uniq()}`)
    await drive(page, conn.session_id, { to: 'open', session_state: 'STABLE' })
    const before = (await api(page, 'get', `/api/dashboard/attendance?start_date=${today()}&end_date=${today()}&force_refresh=1`)).attendance
    const chat = await newChat(page, conn.session_id, `Preciso de ajuda com meu pedido ${uniq()}`)

    // 1) assume pela tela
    await trackSse(page)
    await page.goto(`/chats/${chat.id}`)
    await expect(page.getByTestId('chat-conversation')).toHaveAttribute('data-chat-id', chat.id)
    await waitSseOpen(page)
    await page.getByTestId('chat-panel-assign-me').click()
    await expect.poll(async () => (await api(page, 'get', `/api/chats/${chat.id}`)).chat.status, { timeout: 15_000 }).toBe('attending')
    expect((await api(page, 'get', `/api/chats/${chat.id}`)).chat.assigned_user_id).toBe(me)
    await expect(page.getByTestId('chat-panel-assign-me')).toHaveCount(0)

    // 2) responde texto
    const reply = `Olá! Vou verificar seu pedido ${uniq()}`
    await page.getByTestId('chat-composer-input').fill(reply)
    await page.getByTestId('chat-composer-send').click()
    await expect(page.locator('[data-testid^="chat-message-"][data-direction="outbound"]').filter({ hasText: reply })).toBeVisible()
    await expect.poll(async () => (await messagesOf(page, chat.id)).filter((m) => m.direction === 'outbound' && m.body === reply).length).toBe(1)

    // 3) responde áudio PTT (gravação no compositor)
    await page.getByTestId('chat-composer-record').click()
    await expect(page.getByTestId('chat-composer-recording')).toBeVisible()
    await page.waitForTimeout(1500)
    const post = page.waitForRequest(isMessagePost(chat.id))
    const posted = page.waitForResponse((r) => isMessagePost(chat.id)(r.request()))
    await page.getByTestId('chat-composer-record-stop').click()
    const body = JSON.parse((await post).postData() ?? '{}')
    expect(body).toMatchObject({ type: 'audio', ptt: true })
    const res = await posted
    expect(res.status(), await res.text()).toBeLessThan(300)
    await expect
      .poll(async () => (await messagesOf(page, chat.id)).filter((m) => m.direction === 'outbound' && m.type === 'audio').length, { timeout: 15_000 })
      .toBe(1)
    const audio = (await messagesOf(page, chat.id)).find((m) => m.direction === 'outbound' && m.type === 'audio')
    expect(audio.ptt ?? audio.media?.ptt ?? true).toBe(true)

    // 4) card no kanban: entra na 1ª coluna e é arrastado para a 2ª
    const crm = (await api(page, 'post', '/api/crms', { name: `Funil ${uniq()}` })).crm
    const cols = ((await api(page, 'get', `/api/crms/${crm.id}/columns`)).items as any[]).sort((a, b) => a.position - b.position)
    expect(cols.length).toBeGreaterThanOrEqual(2)
    const card = (await api(page, 'post', `/api/crms/${crm.id}/cards`, { chat_id: chat.id, column_id: cols[0].id })).card
    await page.goto(`/crms/${crm.id}`)
    const cardEl = page.getByTestId(`crms-card-${card.id}`)
    await expect(page.getByTestId(`crms-column-cards-${cols[0].id}`).getByTestId(`crms-card-${card.id}`)).toBeVisible()
    await drag(page, cardEl, page.getByTestId(`crms-column-cards-${cols[1].id}`))
    await expect(page.getByTestId(`crms-column-cards-${cols[1].id}`).getByTestId(`crms-card-${card.id}`)).toBeVisible()
    await page.reload()
    await expect(page.getByTestId(`crms-column-cards-${cols[1].id}`).getByTestId(`crms-card-${card.id}`), 'mover o card não persistiu').toBeVisible()

    // 5) resolve
    await api(page, 'post', `/api/chats/${chat.id}/resolve`, {})
    await expect.poll(async () => (await api(page, 'get', `/api/chats/${chat.id}`)).chat.status).toBe('resolved')

    // 6) métricas de atendimento refletem o chat (API sem cache e aba Atendimento)
    const m = (await api(page, 'get', `/api/dashboard/attendance?start_date=${today()}&end_date=${today()}&force_refresh=1`)).attendance
    expect(m.new_leads, 'novo lead').toBe((before.new_leads ?? 0) + 1)
    expect(m.attended_leads, 'lead atendido').toBe((before.attended_leads ?? 0) + 1)
    expect(m.resolved_leads, 'lead resolvido').toBe((before.resolved_leads ?? 0) + 1)
    const mine = (m.leads_by_user ?? []).find((u: any) => u.user_id === me)
    expect(mine, 'atendente sem linha nas métricas').toBeTruthy()
    expect(mine.resolved_chats).toBeGreaterThanOrEqual(1)
    expect(mine.answered_chats).toBeGreaterThanOrEqual(1)

    await page.goto(`/welcome?tab=attendance&start_date=${today()}&end_date=${today()}`)
    await expect(page.getByTestId('dashboard-attendance')).toBeVisible()
    await expect(page.getByTestId('attendance-kpi-resolved_leads-value')).toContainText(String(m.resolved_leads))
    await expect(page.getByTestId('attendance-kpi-attended_leads-value')).toContainText(String(m.attended_leads))
    await expect(page.getByTestId(`attendance-user-item-${me}`)).toBeVisible()
  })
})
