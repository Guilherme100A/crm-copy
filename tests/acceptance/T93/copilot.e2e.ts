// AC-T93-01..05 — Assistente (copiloto) de fluxo: sessões por fluxo, SSE `copilot.delta`/`copilot.completed`,
// ferramentas de edição validadas (T10), `flow.graph_updated` com `source: 'ai'` + canvas ao vivo, pausa por cota e
// modo só leitura sem `flows.edit`. Contrato em spec/reports/T93-entrega.md. LLM só pelo FakeLlm do harness
// (`POST /__e2e/llm/script`); nenhum provedor real.
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { loginAs, resetSeed, SEED_PASSWORD, SEED_USERS } from '../helpers/e2e'
import { trackSse, waitSseOpen, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

/** Chamada crua (status + corpo), para os casos de erro. */
async function raw(page: Page, method: 'get' | 'post' | 'patch', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status(), body, text }
}

async function companyId(page: Page): Promise<string> {
  const me = await api(page, 'get', '/api/auth/profile')
  const id = me.companies?.find((c: any) => c.id === me.user?.last_company_id)?.id ?? me.companies?.[0]?.id
  expect(id, JSON.stringify(me).slice(0, 300)).toBeTruthy()
  return id
}

/** Recarga de créditos de IA pelo `platform_admin` (o seed não tem saldo). */
async function topup(request: APIRequestContext, cid: string, credits = 1000) {
  const login = await request.post('/api/auth/login', { data: { email: SEED_USERS.platformAdmin, password: SEED_PASSWORD }, headers: XRW })
  expect(login.status(), await login.text()).toBe(200)
  const r = await request.post(`/api/platform/companies/${cid}/ai/topups`, { data: { credits, note: `e2e T93 ${uniq()}` }, headers: XRW })
  expect(r.status(), await r.text()).toBeLessThan(300)
}

/** Roteiro do FakeLlm (substitui o anterior). */
async function script(page: Page, steps: unknown[]) {
  const r = await page.request.post('/__e2e/llm/script', { data: { steps, replace: true }, headers: XRW })
  expect(r.status(), await r.text()).toBe(200)
}
const llmCalls = async (page: Page): Promise<number> => (await (await page.request.get('/__e2e/llm/script')).json()).calls

const bundle = async (page: Page, flowId: string) => (await api(page, 'get', `/api/flows/${flowId}/editor-bundle`)).definition
const shape = (def: any) => ({
  nodes: [...def.nodes].map((n: any) => ({ id: n.id, type: n.type, actions: n.actions })).sort((a, b) => a.id.localeCompare(b.id)),
  edges: [...def.edges].map((e: any) => [e.from, e.handle, e.to]).sort(),
})

/** Fluxo novo; com `withMsg`, um nó de mensagem m1 (ação m1-a1) ligado ao início. */
async function newFlow(page: Page, withMsg = false) {
  const body = await api(page, 'post', '/api/flows', { name: `Fluxo ${uniq()}` })
  const id = (body.flow ?? body).id as string
  const def = await bundle(page, id)
  const start = def.nodes.find((n: any) => n.type === 'start')
  if (withMsg) {
    await api(page, 'put', `/api/flows/${id}/definition`, {
      schema: 'crm.flow/v1',
      entry: start.id,
      nodes: [
        start,
        { id: 'm1', type: 'message', name: 'Msg m1', position: { x: 300, y: 0 }, actions: [{ id: 'm1-a1', type: 'send_message', order: 0, config: { message_text: 'Olá' } }] },
      ],
      edges: [{ id: 'e1', from: start.id, handle: 'source', to: 'm1' }],
      variables: [],
      refs: {},
    })
  }
  return { id, startId: start.id as string }
}

async function newSession(page: Page, flowId: string) {
  const r = await raw(page, 'post', '/api/flow-copilot/sessions', { flow_id: flowId })
  expect(r.status, r.text).toBe(201)
  return r.body.session as { id: string; flow_id: string; status: string }
}
const sendMsg = (page: Page, sessionId: string, content: string, extra: Record<string, unknown> = {}) =>
  raw(page, 'post', `/api/flow-copilot/sessions/${sessionId}/messages`, { content, ...extra })

/** Abre o editor e passa a capturar `copilot.*` e `flow.graph_updated` do SSE da página. */
async function openEditor(page: Page, flowId: string) {
  await trackSse(page)
  await page.goto(`/flows/${flowId}/edit`)
  await expect(page.getByTestId('flow-editor')).toBeVisible()
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
  await waitSseOpen(page)
  await page.evaluate(() => {
    const w = window as any
    w.__ev = [] as Array<{ type: string; data: any }>
    const es: EventSource = w.__sse.find((s: EventSource) => s.url.includes('/api/events') && s.readyState === 1)
    for (const type of ['copilot.delta', 'copilot.completed', 'flow.graph_updated']) {
      es.addEventListener(type, (e) => {
        const d = JSON.parse((e as MessageEvent).data)
        w.__ev.push({ type, data: d && typeof d === 'object' && 'type' in d && 'data' in d ? d.data : d })
      })
    }
  })
}
const events = (page: Page, type: string): Promise<any[]> =>
  page.evaluate((t) => ((window as any).__ev as Array<{ type: string; data: any }>).filter((e) => e.type === t).map((e) => e.data), type)

async function completedFor(page: Page, messageId: string) {
  await expect.poll(async () => (await events(page, 'copilot.completed')).some((d) => d.message_id === messageId)).toBe(true)
  return (await events(page, 'copilot.completed')).find((d) => d.message_id === messageId)
}

async function memberId(page: Page) {
  const team = await api(page, 'get', '/api/team')
  const m = (team.items ?? team.members ?? team).find((x: any) => (x.email ?? x.user?.email) === SEED_USERS.member)
  return (m.user_id ?? m.user?.id) as string
}
async function memberPage(browser: Browser, baseURL: string | undefined, owner: Page) {
  const ctx = await browser.newContext({ baseURL, viewport: owner.viewportSize() ?? undefined })
  const p = await ctx.newPage()
  await loginAs(p, 'member')
  return p
}

const panel = (page: Page) => page.getByTestId('flow-copilot')
async function openPanel(page: Page) {
  await page.getByTestId('flow-copilot-toggle').click()
  await expect(panel(page)).toBeVisible()
  await expect(page.getByTestId('flow-copilot-toggle')).toHaveAttribute('aria-expanded', 'true')
}
async function sendInPanel(page: Page, text: string) {
  await page.getByTestId('flow-copilot-input').fill(text)
  await page.getByTestId('flow-copilot-input').press('Enter')
}

// ------------------------------------------------------------------------------------------------ AC-01

test.describe('T93 — sessões e streaming', () => {
  test('AC-T93-01 sessões por fluxo: criar, listar, mensagens, arquivar/reabrir; resposta chega por copilot.delta + copilot.completed', async ({ page, request }) => {
    await loginAs(page, 'owner')
    await topup(request, await companyId(page))
    const f = await newFlow(page)
    const other = await newFlow(page)
    await openEditor(page, f.id)

    const s = await newSession(page, f.id)
    expect(s).toMatchObject({ flow_id: f.id, status: 'active' })
    await newSession(page, other.id)
    const list = await api(page, 'get', `/api/flow-copilot/sessions?flow_id=${f.id}`)
    expect(list.items.map((x: any) => x.id)).toEqual([s.id])

    await script(page, [{ kind: 'text', text: 'Olá! Posso ajudar a montar o seu fluxo de boas-vindas passo a passo.' }])
    const r = await sendMsg(page, s.id, 'Oi, o que você faz?', { client_message_id: `c-${uniq()}` })
    expect(r.status, r.text).toBe(201)
    expect(r.body.reply).toMatchObject({ role: 'assistant', status: 'completed', content: 'Olá! Posso ajudar a montar o seu fluxo de boas-vindas passo a passo.' })
    expect(r.body.graph_changed).toBe(false)
    expect(r.body.session.title).toBe('Oi, o que você faz?')

    const done = await completedFor(page, r.body.reply.id)
    expect(done).toMatchObject({ session_id: s.id, flow_id: f.id, status: 'completed', graph_changed: false })
    const deltas = (await events(page, 'copilot.delta')).filter((d) => d.message_id === r.body.reply.id && d.kind === 'text')
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.map((d) => d.delta).join('')).toBe(r.body.reply.content)

    const msgs = await api(page, 'get', `/api/flow-copilot/sessions/${s.id}/messages`)
    expect(msgs.items.map((m: any) => [m.role, m.content])).toEqual([
      ['user', 'Oi, o que você faz?'],
      ['assistant', r.body.reply.content],
    ])

    // arquivar: some da lista padrão, aparece com include_archived e não aceita mensagem
    expect((await api(page, 'post', `/api/flow-copilot/sessions/${s.id}/archive`)).session.status).toBe('archived')
    expect((await api(page, 'get', `/api/flow-copilot/sessions?flow_id=${f.id}`)).items).toHaveLength(0)
    const withArchived = await api(page, 'get', `/api/flow-copilot/sessions?flow_id=${f.id}&include_archived=1`)
    expect(withArchived.items.map((x: any) => [x.id, x.status])).toEqual([[s.id, 'archived']])
    const calls = await llmCalls(page)
    const blocked = await sendMsg(page, s.id, 'ainda está aí?')
    expect(blocked.status, blocked.text).toBe(409)
    expect(await llmCalls(page)).toBe(calls)

    // reabrir: volta a active e conversa de novo
    expect((await api(page, 'post', `/api/flow-copilot/sessions/${s.id}/reopen`)).session.status).toBe('active')
    await script(page, [{ kind: 'text', text: 'De volta!' }])
    const again = await sendMsg(page, s.id, 'voltei')
    expect(again.status, again.text).toBe(201)
    expect(again.body.reply.content).toBe('De volta!')
    expect((await api(page, 'get', `/api/flow-copilot/sessions/${s.id}/messages`)).items).toHaveLength(4)

    // sessão é do usuário: outro usuário da empresa não a enxerga
    const ctx = await page.context().browser()!.newContext({ baseURL: new URL(page.url()).origin })
    const admin = await ctx.newPage()
    await loginAs(admin, 'admin')
    expect((await raw(admin, 'get', `/api/flow-copilot/sessions/${s.id}/messages`)).status).toBe(404)
    await ctx.close()
  })

  test('AC-T93-01 painel no editor: conversa nova, resposta do assistente, arquivar e reabrir pela UI', async ({ page, request }) => {
    await loginAs(page, 'owner')
    await topup(request, await companyId(page))
    const f = await newFlow(page)
    await openEditor(page, f.id)
    await openPanel(page)
    await expect(page.getByTestId('flow-copilot-empty')).toBeVisible()
    await expect(panel(page)).toHaveAttribute('data-state', 'idle')

    await script(page, [{ kind: 'text', text: 'Claro! Diga qual mensagem de boas-vindas você quer.' }])
    await sendInPanel(page, 'Quero um fluxo de boas-vindas')
    const msgs = page.getByTestId('flow-copilot-message')
    await expect(msgs).toHaveCount(2)
    await expect(msgs.nth(0)).toHaveAttribute('data-role', 'user')
    await expect(msgs.nth(0)).toContainText('Quero um fluxo de boas-vindas')
    await expect(msgs.nth(1)).toHaveAttribute('data-role', 'assistant')
    await expect(msgs.nth(1)).toHaveAttribute('data-status', 'completed')
    await expect(msgs.nth(1)).toContainText('Claro! Diga qual mensagem de boas-vindas você quer.')
    await expect(panel(page)).toHaveAttribute('data-state', 'idle')
    const sid = await panel(page).getAttribute('data-session-id')
    expect(sid).toBeTruthy()
    const done = (await events(page, 'copilot.completed')).filter((d) => d.session_id === sid)
    expect(done.map((d) => d.status)).toEqual(['completed'])

    await page.getByTestId('flow-copilot-archive').click()
    await expect.poll(async () => (await api(page, 'get', `/api/flow-copilot/sessions/${sid}`)).session?.status).toBe('archived')
    await page.getByTestId('flow-copilot-show-archived').check()
    await page.getByTestId('flow-copilot-sessions').selectOption(sid!)
    await expect(panel(page)).toHaveAttribute('data-state', 'archived')
    await expect(page.getByTestId('flow-copilot-input')).toBeDisabled()
    await page.getByTestId('flow-copilot-reopen').click()
    await expect(panel(page)).toHaveAttribute('data-state', 'idle')
    await expect(page.getByTestId('flow-copilot-input')).toBeEnabled()
    expect((await api(page, 'get', `/api/flow-copilot/sessions/${sid}`)).session.status).toBe('active')
  })
})

// ------------------------------------------------------------------------------------------------ AC-02

test.describe('T93 — ferramentas validadas', () => {
  test('AC-T93-02 edição inválida (criar nó, editar ação, ligar handle, remover Início) volta como erro ao modelo e não grava; o turno continua', async ({ page, request }) => {
    await loginAs(page, 'owner')
    await topup(request, await companyId(page))
    const f = await newFlow(page, true)
    await openEditor(page, f.id)
    const before = shape(await bundle(page, f.id))
    const s = await newSession(page, f.id)

    await script(page, [
      { kind: 'tool-calls', calls: [{ name: 'create_node', input: { type: 'message', actions: [{ type: 'send_message', config: {} }], connect_from: { node_id: 'm1', handle: 'source' } } }] },
      { kind: 'tool-calls', calls: [{ name: 'update_action', input: { node_id: 'm1', action_id: 'm1-a1', config: {}, replace: true } }] },
      { kind: 'tool-calls', calls: [{ name: 'connect', input: { from: f.startId, handle: 'failure', to: 'm1' } }] },
      { kind: 'tool-calls', calls: [{ name: 'delete_node', input: { node_id: f.startId } }] },
      { kind: 'text', text: 'Não consegui aplicar as alterações.' },
    ])
    const r = await sendMsg(page, s.id, 'Crie e ligue blocos inválidos')
    expect(r.status, r.text).toBe(201)
    expect(r.body.graph_changed).toBe(false)
    expect(r.body.reply.status).toBe('completed')
    expect(r.body.reply.content).toBe('Não consegui aplicar as alterações.')
    const calls = r.body.reply.tool_calls as Array<{ name: string; ok: boolean; output: unknown }>
    expect(calls.map((c) => [c.name, c.ok])).toEqual([
      ['create_node', false],
      ['update_action', false],
      ['connect', false],
      ['delete_node', false],
    ])
    expect(String(calls[0]!.output)).toContain('invalid_action_config')
    expect(String(calls[1]!.output)).toContain('invalid_action_config')
    expect(String(calls[2]!.output)).toContain('invalid_handle')
    for (const c of calls.slice(0, 3)) expect(String(c.output)).toMatch(/nada foi gravado/i)
    expect(String(calls[3]!.output)).toMatch(/Início/)

    expect(shape(await bundle(page, f.id))).toEqual(before)
    const done = await completedFor(page, r.body.reply.id)
    expect(done.graph_changed).toBe(false)
    expect((await events(page, 'flow.graph_updated')).filter((d) => d.flow_id === f.id)).toHaveLength(0)
    const toolDeltas = (await events(page, 'copilot.delta')).filter((d) => d.message_id === r.body.reply.id && d.kind === 'tool')
    expect(toolDeltas.map((d) => [d.tool, d.ok])).toEqual(calls.map((c) => [c.name, false]))
  })

  test('AC-T93-02 depois de uma recusa o modelo corrige e as edições válidas (criar, editar ação, ligar, remover) gravam', async ({ page, request }) => {
    await loginAs(page, 'owner')
    await topup(request, await companyId(page))
    const f = await newFlow(page, true)
    await openEditor(page, f.id)
    const s = await newSession(page, f.id)

    await script(page, [
      { kind: 'tool-calls', calls: [{ name: 'create_node', input: { type: 'message', name: 'Ruim', actions: [{ type: 'send_message', config: {} }] } }] },
      { kind: 'tool-calls', calls: [{ name: 'create_node', input: { type: 'message', name: 'Novo', actions: [{ type: 'send_message', config: { message_text: 'Oi!' } }], connect_from: { node_id: 'm1', handle: 'source' } } }] },
      { kind: 'tool-calls', calls: [{ name: 'update_action', input: { node_id: 'm1', action_id: 'm1-a1', config: { message_text: 'Bem-vindo!' } } }] },
      { kind: 'text', text: 'Pronto.' },
    ])
    const r = await sendMsg(page, s.id, 'Crie um bloco depois de m1')
    expect(r.status, r.text).toBe(201)
    const calls = r.body.reply.tool_calls as Array<{ name: string; ok: boolean; output: any }>
    expect(calls.map((c) => [c.name, c.ok])).toEqual([
      ['create_node', false],
      ['create_node', true],
      ['update_action', true],
    ])
    expect(r.body.graph_changed).toBe(true)
    const newId = calls[1]!.output.node_id as string
    let def = await bundle(page, f.id)
    expect(def.nodes.map((n: any) => n.name)).not.toContain('Ruim')
    expect(def.nodes.find((n: any) => n.id === newId)).toMatchObject({ type: 'message', name: 'Novo' })
    expect(def.edges.map((e: any) => [e.from, e.handle, e.to])).toContainEqual(['m1', 'source', newId])
    expect(def.nodes.find((n: any) => n.id === 'm1').actions[0].config.message_text).toBe('Bem-vindo!')

    // ligar e remover nó
    await script(page, [
      { kind: 'tool-calls', calls: [{ name: 'connect', input: { from: f.startId, handle: 'source', to: newId } }] },
      { kind: 'tool-calls', calls: [{ name: 'delete_node', input: { node_id: 'm1' } }] },
      { kind: 'text', text: 'Feito.' },
    ])
    const r2 = await sendMsg(page, s.id, 'Ligue o início ao novo e apague m1')
    expect(r2.status, r2.text).toBe(201)
    expect(r2.body.reply.tool_calls.map((c: any) => [c.name, c.ok])).toEqual([
      ['connect', true],
      ['delete_node', true],
    ])
    def = await bundle(page, f.id)
    expect(def.nodes.map((n: any) => n.id)).not.toContain('m1')
    expect(def.edges.map((e: any) => [e.from, e.handle, e.to])).toEqual([[f.startId, 'source', newId]])
  })

  test('AC-T93-02 painel mostra a ferramenta recusada (data-ok=false) e o canvas não muda', async ({ page, request }) => {
    await loginAs(page, 'owner')
    await topup(request, await companyId(page))
    const f = await newFlow(page, true)
    await openEditor(page, f.id)
    const nodesBefore = await page.locator('.react-flow__node').count()
    await openPanel(page)
    await script(page, [
      { kind: 'tool-calls', calls: [{ name: 'create_node', input: { type: 'message', actions: [{ type: 'send_message', config: {} }], connect_from: { node_id: 'm1', handle: 'source' } } }] },
      { kind: 'text', text: 'A validação recusou o bloco.' },
    ])
    await sendInPanel(page, 'Crie um bloco sem texto')
    const reply = page.locator('[data-testid="flow-copilot-message"][data-role="assistant"]')
    await expect(reply).toHaveCount(1)
    await expect(reply.getByTestId('flow-copilot-tool')).toHaveAttribute('data-tool', 'create_node')
    await expect(reply.getByTestId('flow-copilot-tool')).toHaveAttribute('data-ok', 'false')
    await expect(reply).toContainText('A validação recusou o bloco.')
    await expect(page.getByTestId('flow-copilot-canvas-updated')).toHaveCount(0)
    expect(await page.locator('.react-flow__node').count()).toBe(nodesBefore)
  })
})

// ------------------------------------------------------------------------------------------------ AC-03

test.describe('T93 — flow.graph_updated e canvas', () => {
  test("AC-T93-03 cada edição do assistente publica flow.graph_updated com source 'ai' (depois de gravar)", async ({ page, request }) => {
    await loginAs(page, 'owner')
    await topup(request, await companyId(page))
    const f = await newFlow(page, true)
    await openEditor(page, f.id)
    const s = await newSession(page, f.id)
    await script(page, [
      { kind: 'tool-calls', calls: [{ name: 'create_node', input: { type: 'message', name: 'Boas-vindas IA', actions: [{ type: 'send_message', config: { message_text: 'Olá!' } }] } }] },
      { kind: 'tool-calls', calls: [{ name: 'update_action', input: { node_id: 'm1', action_id: 'm1-a1', config: { message_text: 'Oi de novo' } } }] },
      { kind: 'tool-calls', calls: [{ name: 'disconnect', input: { from: f.startId, handle: 'source' } }] },
      { kind: 'tool-calls', calls: [{ name: 'delete_node', input: { node_id: 'm1' } }] },
      { kind: 'text', text: 'Alterado.' },
    ])
    const r = await sendMsg(page, s.id, 'Faça várias edições')
    expect(r.status, r.text).toBe(201)
    expect(r.body.reply.tool_calls.every((c: any) => c.ok)).toBe(true)
    const newId = r.body.reply.tool_calls[0].output.node_id as string
    await completedFor(page, r.body.reply.id)
    await expect.poll(async () => (await events(page, 'flow.graph_updated')).filter((d) => d.flow_id === f.id).length).toBe(4)
    const ev = (await events(page, 'flow.graph_updated')).filter((d) => d.flow_id === f.id)
    for (const d of ev) expect(d).toMatchObject({ flow_id: f.id, actor_id: null, source: 'ai', session_id: s.id })
    expect(ev.map((d) => d.mutation)).toEqual(['add_node', 'update_action', 'delete_connection', 'delete_node'])
    // gravado de fato quando o evento saiu
    const def = await bundle(page, f.id)
    expect(def.nodes.map((n: any) => n.id).sort()).toEqual([f.startId, newId].sort())
  })

  test("AC-T93-03 o canvas mostra o bloco criado pelo assistente sem recarregar e avisa 'Canvas atualizado'", async ({ page, request }) => {
    await loginAs(page, 'owner')
    await topup(request, await companyId(page))
    const f = await newFlow(page)
    await openEditor(page, f.id)
    const before = await page.locator('.react-flow__node').count()
    await openPanel(page)
    await script(page, [
      { kind: 'tool-calls', calls: [{ name: 'create_node', input: { type: 'message', name: 'Boas-vindas IA', actions: [{ type: 'send_message', config: { message_text: 'Olá!' } }], connect_from: { node_id: f.startId, handle: 'source' } } }] },
      { kind: 'text', text: 'Criei o bloco Boas-vindas IA.' },
    ])
    let navigations = 0
    page.on('framenavigated', (fr) => {
      if (fr === page.mainFrame()) navigations++
    })
    await sendInPanel(page, 'Crie um bloco de boas-vindas')
    await expect(page.getByTestId('flow-copilot-canvas-updated').first()).toBeVisible()
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1)
    const def = await bundle(page, f.id)
    const created = def.nodes.find((n: any) => n.name === 'Boas-vindas IA')
    expect(created).toBeTruthy()
    await expect(page.locator(`.react-flow__node[data-id="${created.id}"]`)).toBeVisible()
    await expect(page.locator(`.react-flow__node[data-id="${created.id}"]`)).toContainText('Boas-vindas IA')
    const reply = page.locator('[data-testid="flow-copilot-message"][data-role="assistant"]')
    await expect(reply.getByTestId('flow-copilot-tool')).toHaveAttribute('data-ok', 'true')
    expect(navigations).toBe(0)
  })
})

// ------------------------------------------------------------------------------------------------ AC-04

test.describe('T93 — cota', () => {
  test('AC-T93-04 sem saldo o turno pausa a sessão (paused_quota) sem chamar o LLM; resume só com saldo', async ({ page, request }) => {
    await loginAs(page, 'owner')
    const cid = await companyId(page)
    const f = await newFlow(page)
    await openEditor(page, f.id)
    const s = await newSession(page, f.id)
    await script(page, [{ kind: 'text', text: 'não deveria sair' }])
    const calls0 = await llmCalls(page)

    const r = await sendMsg(page, s.id, 'Oi')
    expect(r.status, r.text).toBe(429)
    expect(r.body.error).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { reason: 'paused_quota' } })
    expect((await api(page, 'get', `/api/flow-copilot/sessions/${s.id}`)).session.status).toBe('paused_quota')
    expect(await llmCalls(page)).toBe(calls0)
    await expect.poll(async () => (await events(page, 'copilot.completed')).filter((d) => d.session_id === s.id).map((d) => d.status)).toEqual(['paused_quota'])

    // pausada: nova mensagem continua 429 sem LLM; resume sem saldo → 429 e segue pausada
    const again = await sendMsg(page, s.id, 'Oi de novo')
    expect(again.status, again.text).toBe(429)
    const res1 = await raw(page, 'post', `/api/flow-copilot/sessions/${s.id}/resume`)
    expect(res1.status, res1.text).toBe(429)
    expect(res1.body.error?.code).toBe('QUOTA_EXCEEDED')
    expect((await api(page, 'get', `/api/flow-copilot/sessions/${s.id}`)).session.status).toBe('paused_quota')
    expect(await llmCalls(page)).toBe(calls0)

    // com saldo: resume → active e a conversa volta
    await topup(request, cid)
    const res2 = await raw(page, 'post', `/api/flow-copilot/sessions/${s.id}/resume`)
    expect(res2.status, res2.text).toBe(200)
    expect(res2.body.session.status).toBe('active')
    const ok = await sendMsg(page, s.id, 'Agora vai?')
    expect(ok.status, ok.text).toBe(201)
    expect(ok.body.reply).toMatchObject({ status: 'completed', content: 'não deveria sair' })
  })

  test('AC-T93-04 painel: aviso de pausa, retomar sem saldo mostra erro, com saldo volta a conversar', async ({ page, request }) => {
    await loginAs(page, 'owner')
    const cid = await companyId(page)
    const f = await newFlow(page)
    await openEditor(page, f.id)
    await openPanel(page)
    await script(page, [{ kind: 'text', text: 'Voltei a responder.' }])
    await sendInPanel(page, 'Oi, sem saldo')
    await expect(page.getByTestId('flow-copilot-paused')).toBeVisible()
    await expect(panel(page)).toHaveAttribute('data-state', 'paused')
    await expect(page.getByTestId('flow-copilot-input')).toBeDisabled()

    await page.getByTestId('flow-copilot-resume').click()
    await expect(page.getByTestId('flow-copilot-resume-error')).toBeVisible()
    await expect(page.getByTestId('flow-copilot-paused')).toBeVisible()

    await topup(request, cid)
    await page.getByTestId('flow-copilot-resume').click()
    await expect(page.getByTestId('flow-copilot-paused')).toHaveCount(0)
    await expect(panel(page)).toHaveAttribute('data-state', 'idle')
    await sendInPanel(page, 'E agora?')
    await expect(page.locator('[data-testid="flow-copilot-message"][data-role="assistant"][data-status="completed"]')).toContainText('Voltei a responder.')
  })
})

// ------------------------------------------------------------------------------------------------ AC-05

test.describe('T93 — sem flows.edit', () => {
  test('AC-T93-05 só flows.view: ferramentas de escrita não existem para o modelo, ele responde e nada é gravado', async ({ page, request, browser, baseURL }) => {
    await loginAs(page, 'owner')
    await topup(request, await companyId(page))
    const f = await newFlow(page, true)
    const ownerList = await api(page, 'get', `/api/flow-copilot/sessions?flow_id=${f.id}`)
    expect(ownerList.can_edit).toBe(true)
    expect(ownerList.tools).toEqual(expect.arrayContaining(['create_node', 'update_action', 'connect', 'disconnect', 'delete_node']))
    await api(page, 'patch', `/api/team/${await memberId(page)}`, { permission_keys: ['flows.view'] })
    const before = shape(await bundle(page, f.id))

    const member = await memberPage(browser, baseURL, page)
    await openEditor(member, f.id)
    const list = await api(member, 'get', `/api/flow-copilot/sessions?flow_id=${f.id}`)
    expect(list.can_edit).toBe(false)
    expect([...list.tools].sort()).toEqual(['get_flow', 'list_block_types'])
    const s = await newSession(member, f.id)

    await script(member, [
      { kind: 'tool-calls', calls: [{ name: 'get_flow', input: {} }] },
      { kind: 'tool-calls', calls: [{ name: 'create_node', input: { type: 'message', name: 'Intruso', actions: [{ type: 'send_message', config: { message_text: 'x' } }] } }] },
      { kind: 'tool-calls', calls: [{ name: 'delete_node', input: { node_id: 'm1' } }] },
      { kind: 'text', text: 'O fluxo tem um bloco de mensagem; não posso editá-lo.' },
    ])
    const r = await sendMsg(member, s.id, 'O que tem no fluxo? Apague m1.')
    expect(r.status, r.text).toBe(201)
    expect(r.body.reply).toMatchObject({ status: 'completed', content: 'O fluxo tem um bloco de mensagem; não posso editá-lo.' })
    expect(r.body.graph_changed).toBe(false)
    const calls = r.body.reply.tool_calls as Array<{ name: string; ok: boolean }>
    expect(calls.filter((c) => c.ok).map((c) => c.name)).toEqual(['get_flow'])
    expect(shape(await bundle(page, f.id))).toEqual(before)
    await completedFor(member, r.body.reply.id)
    expect((await events(member, 'flow.graph_updated')).filter((d) => d.flow_id === f.id)).toHaveLength(0)
    await member.context().close()
  })

  test('AC-T93-05 a permissão é lida no momento do turno: perder flows.edit tira as ferramentas de escrita da sessão já aberta', async ({ page, request, browser, baseURL }) => {
    await loginAs(page, 'owner')
    await topup(request, await companyId(page))
    const f = await newFlow(page, true)
    const mid = await memberId(page)
    await api(page, 'patch', `/api/team/${mid}`, { permission_keys: ['flows.view', 'flows.edit'] })
    const member = await memberPage(browser, baseURL, page)
    const s = await newSession(member, f.id)
    expect((await api(member, 'get', `/api/flow-copilot/sessions?flow_id=${f.id}`)).can_edit).toBe(true)

    await api(page, 'patch', `/api/team/${mid}`, { permission_keys: ['flows.view'] })
    const before = shape(await bundle(page, f.id))
    await script(member, [
      { kind: 'tool-calls', calls: [{ name: 'create_node', input: { type: 'message', name: 'Tardio', actions: [{ type: 'send_message', config: { message_text: 'x' } }] } }] },
      { kind: 'text', text: 'Só leitura.' },
    ])
    const r = await sendMsg(member, s.id, 'Crie um bloco')
    expect(r.status, r.text).toBe(201)
    expect(r.body.graph_changed).toBe(false)
    expect(r.body.reply.tool_calls.filter((c: any) => c.ok)).toHaveLength(0)
    expect(shape(await bundle(page, f.id))).toEqual(before)
    await member.context().close()
  })

  test('AC-T93-05 painel em modo leitura: aviso flow-copilot-readonly e o assistente responde perguntas', async ({ page, request, browser, baseURL }) => {
    await loginAs(page, 'owner')
    await topup(request, await companyId(page))
    const f = await newFlow(page, true)
    await api(page, 'patch', `/api/team/${await memberId(page)}`, { permission_keys: ['flows.view'] })
    const member = await memberPage(browser, baseURL, page)
    await openEditor(member, f.id)
    await openPanel(member)
    await expect(member.getByTestId('flow-copilot-readonly')).toBeVisible()
    await script(member, [
      { kind: 'tool-calls', calls: [{ name: 'get_flow', input: {} }] },
      { kind: 'text', text: 'Este fluxo envia "Olá" logo após o início.' },
    ])
    await sendInPanel(member, 'O que esse fluxo faz?')
    const reply = member.locator('[data-testid="flow-copilot-message"][data-role="assistant"]')
    await expect(reply).toContainText('Este fluxo envia "Olá" logo após o início.')
    await expect(reply.getByTestId('flow-copilot-tool')).toHaveAttribute('data-tool', 'get_flow')
    await expect(reply.getByTestId('flow-copilot-tool')).toHaveAttribute('data-ok', 'true')
    await member.context().close()
  })
})
