// AC-T91-01..04 — painel lateral do chat: dados e ações, transferência com dois usuários, agendamentos, disparar fluxo,
// confirmações e sheet no mobile. Contrato de data-testid combinado com o Torno.
import { expect, test, type Browser, type Page, type Request } from '@playwright/test'
import { isMobile, loginAs, resetSeed, SEED_USERS } from '../helpers/e2e'
import { createConnection, newChat, trackSse, waitSseOpen, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const panel = (page: Page) => page.getByTestId('chat-panel').filter({ visible: true }).first()

async function api(page: Page, method: 'post' | 'patch' | 'put' | 'delete', path: string, data?: unknown, extra: Record<string, string> = {}) {
  const res = await page.request[method](path, { data: data ?? {}, headers: { ...XRW, ...extra } })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.status() === 204 ? {} : res.json()
}

/** Abre o chat e o painel (desktop: coluna sempre visível; mobile: sheet pelo botão). */
async function openPanel(page: Page, chatId: string) {
  await trackSse(page)
  await page.goto(`/chats/${chatId}`)
  await waitSseOpen(page)
  if (isMobile(page)) {
    await page.getByTestId('chat-panel-open').click()
    await expect(page.getByTestId('chat-panel-sheet')).toBeVisible()
  }
  await expect(panel(page)).toBeVisible()
}

/** Confirma o diálogo único de ações destrutivas. */
async function confirm(page: Page) {
  await expect(page.getByTestId('chat-panel-confirm')).toBeVisible()
  await page.getByTestId('chat-panel-confirm-submit').click()
  await expect(page.getByTestId('chat-panel-confirm')).toBeHidden()
}

const flowDef = (wait: boolean) => ({
  schema: 'crm.flow/v1',
  entry: 'start',
  nodes: wait
    ? [
        { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
        { id: 'W', type: 'wait_response', name: 'Espera', position: { x: 200, y: 0 }, actions: [{ id: 'W-a1', type: 'wait_for_response', order: 0, config: { wait_indefinitely: false, timeout_value: 1, timeout_unit: 'hours' } }] },
        { id: 'R', type: 'message', name: 'Resposta', position: { x: 400, y: 0 }, actions: [{ id: 'R-a1', type: 'send_message', order: 0, config: { message_text: 'obrigado' } }] },
        { id: 'T', type: 'message', name: 'Timeout', position: { x: 400, y: 200 }, actions: [{ id: 'T-a1', type: 'send_message', order: 0, config: { message_text: 'tchau' } }] },
      ]
    : [
        { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
        { id: 'm1', type: 'message', name: 'Oi', position: { x: 200, y: 0 }, actions: [{ id: 'm1-a1', type: 'send_message', order: 0, config: { message_text: 'oi' } }] },
      ],
  edges: wait
    ? [
        { id: 'e1', from: 'start', handle: 'source', to: 'W' },
        { id: 'e2', from: 'W', handle: 'source', to: 'R' },
        { id: 'e3', from: 'W', handle: 'timeout', to: 'T' },
      ]
    : [{ id: 'e1', from: 'start', handle: 'source', to: 'm1' }],
  variables: [],
  refs: {},
})

/** Fluxo pela API (T28): active (publicado e ativo), paused ou draft. */
async function newFlow(page: Page, status: 'active' | 'paused' | 'draft', wait = true, name = `Fluxo ${uniq()}`) {
  const { flow } = await api(page, 'post', '/api/flows', { name })
  await api(page, 'put', `/api/flows/${flow.id}/definition`, flowDef(wait))
  if (status !== 'draft') await api(page, 'post', `/api/flows/${flow.id}/activate`)
  if (status === 'paused') await api(page, 'post', `/api/flows/${flow.id}/pause`)
  return { id: flow.id as string, name }
}

async function activeRuns(page: Page, chatId: string): Promise<any[]> {
  const res = await page.request.get(`/api/chats/${chatId}/flow-runs?active=1`)
  expect(res.status()).toBe(200)
  return (await res.json()).items ?? []
}

async function teamMember(page: Page, email: string) {
  const body = await (await page.request.get('/api/team')).json()
  const list: any[] = body.items ?? body.members ?? body
  const m = list.find((x) => (x.email ?? x.user?.email) === email)
  expect(m, `membro ${email} em /api/team`).toBeTruthy()
  return { memberId: (m.member_id ?? m.id) as string, userId: (m.user_id ?? m.user?.id ?? m.id) as string }
}

/** Valor 'YYYY-MM-DDTHH:mm' na hora local do navegador (America/Sao_Paulo). */
const localInput = (ms: number) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))
  const g = (t: string) => p.find((x) => x.type === t)!.value
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
}

test.describe('T91 — painel', () => {
  test('AC-T91-01 painel mostra contato, kanban, departamento, responsável, etiquetas, notas e fluxos ativos', async ({ page }) => {
    const login = await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id)
    const { crm } = await api(page, 'post', '/api/crms', { name: `Funil ${uniq()}` })
    const colRes = await api(page, 'post', `/api/crms/${crm.id}/columns`, { name: 'Negociação' })
    const column = colRes.column ?? colRes
    await api(page, 'post', `/api/crms/${crm.id}/cards`, { chat_id: chat.id, column_id: column.id })
    const { department } = await api(page, 'post', '/api/departments', { name: `Vendas ${uniq()}` })
    await api(page, 'patch', `/api/chats/${chat.id}`, { department_id: department.id })
    const { label } = await api(page, 'post', '/api/labels', { name: `VIP ${uniq()}`, color: '#22c55e' })
    await api(page, 'post', `/api/chats/${chat.id}/labels`, { label_id: label.id })
    await api(page, 'post', `/api/chats/${chat.id}/notes`, { body: 'cliente prefere ligação à tarde' })
    const flow = await newFlow(page, 'active', true)
    await api(page, 'post', `/api/flows/${flow.id}/trigger`, { chat_id: chat.id })
    await expect.poll(async () => (await activeRuns(page, chat.id)).length).toBe(1)
    const runId = (await activeRuns(page, chat.id))[0].id
    const contact = (await (await page.request.get(`/api/chats/${chat.id}`)).json()).chat.contact

    await openPanel(page, chat.id)
    const p = panel(page)
    await expect(p.getByTestId('chat-panel-contact-name')).toContainText(contact.name)
    await expect(p.getByTestId('chat-panel-contact-phone')).toContainText(chat.phone.slice(-8))
    await expect(p.getByTestId('chat-panel-crm')).toHaveValue(crm.id)
    await expect(p.getByTestId('chat-panel-crm-column')).toHaveValue(column.id)
    await expect(p.getByTestId('chat-panel-department')).toHaveValue(department.id)
    await expect(p.getByTestId(`chat-panel-label-${label.id}`)).toBeVisible()
    await expect(p.getByTestId('chat-panel-notes')).toContainText('cliente prefere ligação à tarde')
    await expect(p.getByTestId(`chat-panel-flow-run-${runId}`)).toBeVisible()

    // "Atribuir a mim"
    const assign = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/api/chats/${chat.id}/assign`))
    await p.getByTestId('chat-panel-assign-me').click()
    await assign
    await expect(p.getByTestId('chat-panel-assignee')).toHaveValue(login.user.id)
    await expect(p.getByTestId('chat-panel-assign-me')).toHaveCount(0)

    // parar o fluxo ativo (com confirmação)
    await p.getByTestId(`chat-panel-flow-run-stop-${runId}`).click()
    await confirm(page)
    await expect(p.getByTestId(`chat-panel-flow-run-${runId}`)).toHaveCount(0)
    await expect.poll(async () => (await activeRuns(page, chat.id)).length).toBe(0)
  })

  test('AC-T91-01 adicionar nota e etiqueta pelo painel; remover etiqueta pede confirmação', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id)
    const { label } = await api(page, 'post', '/api/labels', { name: `Quente ${uniq()}`, color: '#ef4444' })
    await openPanel(page, chat.id)
    const p = panel(page)

    await p.getByTestId('chat-panel-note-input').fill('retornar amanhã')
    await p.getByTestId('chat-panel-note-submit').click()
    await expect(p.getByTestId('chat-panel-notes')).toContainText('retornar amanhã')

    await p.getByTestId('chat-panel-label-add').selectOption(label.id)
    await expect(p.getByTestId(`chat-panel-label-${label.id}`)).toBeVisible()
    await p.getByTestId(`chat-panel-label-remove-${label.id}`).click()
    await expect(page.getByTestId('chat-panel-confirm')).toBeVisible()
    await page.getByTestId('chat-panel-confirm-cancel').click()
    await expect(p.getByTestId(`chat-panel-label-${label.id}`)).toBeVisible()
    await p.getByTestId(`chat-panel-label-remove-${label.id}`).click()
    await confirm(page)
    await expect(p.getByTestId(`chat-panel-label-${label.id}`)).toHaveCount(0)
  })
})

test.describe('T91 — transferência', () => {
  test('AC-T91-02 transferir de departamento tira o chat da lista de quem perde o escopo (dois usuários)', async ({ page, browser, baseURL }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id)
    const x = (await api(page, 'post', '/api/departments', { name: `Comercial ${uniq()}` })).department
    const y = (await api(page, 'post', '/api/departments', { name: `Financeiro ${uniq()}` })).department
    await api(page, 'patch', `/api/chats/${chat.id}`, { department_id: x.id })
    const m = await teamMember(page, SEED_USERS.member)
    await api(page, 'put', `/api/departments/members/${m.memberId}/scope`, { department_ids: [x.id], connection_ids: [] })

    // segundo usuário em outro contexto de navegador
    const member = await memberPage(browser, page, baseURL)
    await trackSse(member)
    await member.goto('/chats')
    await waitSseOpen(member)
    await expect(member.getByTestId(`chat-list-item-${chat.id}`)).toBeVisible()
    await member.evaluate(() => ((window as any).__t91NoReload = true))

    await openPanel(page, chat.id)
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/chats/${chat.id}`))
    await panel(page).getByTestId('chat-panel-department').selectOption(y.id)
    expect(JSON.parse((await patch).postData() ?? '{}').department_id).toBe(y.id)

    await expect(member.getByTestId(`chat-list-item-${chat.id}`)).toHaveCount(0, { timeout: 20_000 })
    expect(await member.evaluate(() => (window as any).__t91NoReload)).toBe(true)
    await member.context().close()
  })
})

/** Segundo usuário (member do seed) num contexto de navegador próprio, mesmo viewport do projeto. */
async function memberPage(browser: Browser, owner: Page, baseURL: string | undefined) {
  const ctx = await browser.newContext({ baseURL, viewport: owner.viewportSize() ?? undefined, isMobile: isMobile(owner), hasTouch: isMobile(owner) })
  const p = await ctx.newPage()
  await loginAs(p, 'member')
  return p
}

test.describe('T91 — agendamentos', () => {
  async function fillSchedule(page: Page, opts: { kind: 'message' | 'flow'; text?: string; flowId?: string; at: number; recurrence?: string }) {
    await panel(page).getByTestId('chat-panel-schedule-new').click()
    const modal = page.getByTestId('chat-schedule-modal')
    await expect(modal).toBeVisible()
    await modal.getByTestId(`chat-schedule-kind-${opts.kind}`).click()
    if (opts.text !== undefined) await modal.getByTestId('chat-schedule-text').fill(opts.text)
    if (opts.flowId) await modal.getByTestId('chat-schedule-flow').selectOption(opts.flowId)
    await modal.getByTestId('chat-schedule-run-at').fill(localInput(opts.at))
    await modal.getByTestId('chat-schedule-recurrence').selectOption(opts.recurrence ?? 'one_off')
    return modal
  }

  const schedulesOf = async (page: Page, chatId: string) => ((await (await page.request.get(`/api/chats/${chatId}/schedules`)).json()).items ?? []) as any[]

  test('AC-T91-03 agendar mensagem recorrente e fluxo; a lista do chat mostra os pendentes', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id)
    const flow = await newFlow(page, 'active', false)
    await openPanel(page, chat.id)

    let modal = await fillSchedule(page, { kind: 'message', text: 'lembrete semanal', at: Date.now() + 2 * 3600_000, recurrence: 'weekly' })
    await modal.getByTestId('chat-schedule-submit').click()
    await expect(modal).toBeHidden()
    await expect.poll(async () => (await schedulesOf(page, chat.id)).length).toBe(1)
    const s1 = (await schedulesOf(page, chat.id))[0]
    expect(s1).toMatchObject({ kind: 'message', text: 'lembrete semanal', recurrence: 'weekly', status: 'pending' })
    const item1 = panel(page).getByTestId(`chat-schedule-${s1.id}`)
    await expect(item1).toBeVisible()
    await expect(item1).toHaveAttribute('data-recurrence', 'weekly')
    await expect(item1).toHaveAttribute('data-status', 'pending')

    modal = await fillSchedule(page, { kind: 'flow', flowId: flow.id, at: Date.now() + 30 * 24 * 3600_000 })
    await modal.getByTestId('chat-schedule-submit').click()
    await expect(modal).toBeHidden()
    await expect.poll(async () => (await schedulesOf(page, chat.id)).length).toBe(2)
    const s2 = (await schedulesOf(page, chat.id)).find((s) => s.kind === 'flow')
    expect(s2.flow_id).toBe(flow.id)
    await expect(panel(page).getByTestId(`chat-schedule-${s2.id}`)).toBeVisible()
  })

  for (const [label, offset] of [
    ['acima de 31 dias', 32 * 24 * 3600_000],
    ['no passado', -3600_000],
  ] as const) {
    test(`AC-T91-03 agendamento ${label} mostra erro e não cria`, async ({ page }) => {
      await loginAs(page, 'owner')
      const conn = await createConnection(page)
      const chat = await newChat(page, conn.session_id)
      await openPanel(page, chat.id)
      const modal = await fillSchedule(page, { kind: 'message', text: 'fora do prazo', at: Date.now() + offset })
      await modal.getByTestId('chat-schedule-submit').click()
      await expect(modal.getByTestId('chat-schedule-error')).toBeVisible()
      await page.waitForTimeout(500)
      expect(await schedulesOf(page, chat.id)).toHaveLength(0)
    })
  }

  test('AC-T91-03 cancelar agendamento pede confirmação e o remove da lista de pendentes', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id)
    const run_at = new Date(Date.now() + 5 * 3600_000).toISOString()
    const { schedule } = await api(page, 'post', `/api/chats/${chat.id}/schedules`, { kind: 'message', text: 'cancelar este', run_at })
    await openPanel(page, chat.id)
    const item = panel(page).getByTestId(`chat-schedule-${schedule.id}`)
    await expect(item).toBeVisible()
    const del = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().endsWith(`/api/schedules/${schedule.id}`))
    await panel(page).getByTestId(`chat-schedule-cancel-${schedule.id}`).click()
    await confirm(page)
    await del
    await expect.poll(async () => (await (await page.request.get(`/api/schedules/${schedule.id}`)).json()).schedule.status).toBe('cancelled')
    // sai da lista de pendentes: o item some ou passa a mostrar status cancelled
    await expect.poll(async () => ((await item.count()) === 0 ? 'removido' : await item.getAttribute('data-status'))).toMatch(/removido|cancelled/)
  })
})

test.describe('T91 — disparar fluxo, permissões e mobile', () => {
  test('AC-T91-04 "Disparar fluxo" lista só fluxos acionáveis e dispara', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id)
    const active = await newFlow(page, 'active', true, `Ativo ${uniq()}`)
    const paused = await newFlow(page, 'paused', true, `Pausado ${uniq()}`)
    const draft = await newFlow(page, 'draft', true, `Rascunho ${uniq()}`)
    await openPanel(page, chat.id)
    await panel(page).getByTestId('chat-panel-trigger-flow').click()
    const modal = page.getByTestId('chat-panel-trigger-modal')
    await expect(modal).toBeVisible()
    const values = await modal.getByTestId('chat-panel-trigger-select').locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))
    expect(values).toContain(active.id)
    expect(values).not.toContain(paused.id)
    expect(values).not.toContain(draft.id)

    await modal.getByTestId('chat-panel-trigger-select').selectOption(active.id)
    const trig = page.waitForRequest((r: Request) => r.method() === 'POST' && r.url().includes(`/api/flows/${active.id}/trigger`))
    await modal.getByTestId('chat-panel-trigger-submit').click()
    expect(JSON.parse((await trig).postData() ?? '{}').chat_id).toBe(chat.id)
    await expect.poll(async () => (await activeRuns(page, chat.id)).some((r) => r.flow_id === active.id)).toBe(true)
  })

  test('AC-T91-04 sem flows.run o botão de disparar (e o de parar) não aparece', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id)
    const flow = await newFlow(page, 'active', true)
    await api(page, 'post', `/api/flows/${flow.id}/trigger`, { chat_id: chat.id })
    await expect.poll(async () => (await activeRuns(page, chat.id)).length).toBe(1)
    const runId = (await activeRuns(page, chat.id))[0].id
    const m = await teamMember(page, SEED_USERS.member)
    await api(page, 'patch', `/api/team/${m.userId}`, { permission_keys: ['chat.view', 'flows.view'] })

    await page.context().clearCookies()
    await loginAs(page, 'member')
    await openPanel(page, chat.id)
    await expect(panel(page).getByTestId(`chat-panel-flow-run-${runId}`)).toBeVisible()
    await expect(panel(page).getByTestId('chat-panel-trigger-flow')).toHaveCount(0)
    await expect(panel(page).getByTestId(`chat-panel-flow-run-stop-${runId}`)).toHaveCount(0)
  })

  test('AC-T91-04 desligar o agente de IA pede confirmação', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id)
    // agente sem modelo (não exige chave de provedor no harness)
    const { agent } = await api(page, 'post', '/api/ai-agents', { name: `Agente ${uniq()}`, model: null })
    await api(page, 'patch', `/api/chats/${chat.id}`, { ai_agent_id: agent.id })
    await openPanel(page, chat.id)
    const sel = panel(page).getByTestId('chat-panel-ai-agent')
    await expect(sel).toHaveValue(agent.id)
    // cancelar a confirmação mantém o agente
    await sel.selectOption('')
    await expect(page.getByTestId('chat-panel-confirm')).toBeVisible()
    await page.getByTestId('chat-panel-confirm-cancel').click()
    await expect(sel).toHaveValue(agent.id)
    // confirmar desliga
    await sel.selectOption('')
    await confirm(page)
    await expect(sel).toHaveValue('')
    await expect.poll(async () => (await (await page.request.get(`/api/chats/${chat.id}`)).json()).chat.ai_agent_id).toBeNull()
  })

  test('AC-T91-04 no mobile o painel abre como sheet e fecha; no desktop é coluna lateral', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id)
    await page.goto(`/chats/${chat.id}`)
    if (isMobile(page)) {
      await expect(page.getByTestId('chat-panel-sheet')).toHaveCount(0)
      await page.getByTestId('chat-panel-open').click()
      const sheet = page.getByTestId('chat-panel-sheet')
      await expect(sheet).toBeVisible()
      await expect(sheet).toHaveAttribute('role', 'dialog')
      await expect(sheet.getByTestId('chat-panel')).toBeVisible()
      const doc = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }))
      expect(doc.s).toBeLessThanOrEqual(doc.c)
      await page.getByTestId('chat-panel-close').click()
      await expect(sheet).toBeHidden()
    } else {
      await expect(page.getByTestId('chat-panel-slot').getByTestId('chat-panel')).toBeVisible()
      await expect(page.getByTestId('chat-panel-sheet')).toHaveCount(0)
      await expect(page.getByTestId('chat-thread')).toBeVisible()
    }
  })
})
