// AC-T45-01..05 — editor de fluxos (@xyflow/react): paleta e autosave, substituição de aresta, copiar/colar/excluir,
// ativação com validação, modo leitura e atualização por SSE. Contrato de data-testid combinado com o Torno.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { isMobile, loginAs, resetSeed, SEED_USERS } from '../helpers/e2e'
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

const bundle = async (page: Page, flowId: string) => (await api(page, 'get', `/api/flows/${flowId}/editor-bundle`)).definition

/** Fluxo novo; devolve id e o id do nó de início. */
async function newFlow(page: Page) {
  const body = await api(page, 'post', '/api/flows', { name: `Fluxo ${uniq()}` })
  const id = (body.flow ?? body).id as string
  const def = await bundle(page, id)
  const start = def.nodes.find((n: any) => n.type === 'start')
  return { id, startId: start.id as string, start }
}

const msg = (id: string, x: number, y: number, withAction = true) => ({
  id,
  type: 'message',
  name: `Msg ${id}`,
  position: { x, y },
  actions: withAction ? [{ id: `${id}-a1`, type: 'send_message', order: 0, config: { message_text: 'Olá' } }] : [],
})

async function putDef(page: Page, flowId: string, start: any, nodes: any[], edges: Array<[string, string, string]>) {
  await api(page, 'put', `/api/flows/${flowId}/definition`, {
    schema: 'crm.flow/v1',
    entry: start.id,
    nodes: [start, ...nodes],
    edges: edges.map(([from, handle, to], i) => ({ id: `e${i + 1}`, from, handle, to })),
    variables: [],
    refs: {},
  })
}

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`)
const nodeIds = (page: Page) => page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!))
const translateOf = (page: Page, id: string) =>
  node(page, id).evaluate((el) => {
    const m = /translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/.exec((el as HTMLElement).style.transform)
    return m ? { x: Math.round(Number(m[1])), y: Math.round(Number(m[2])) } : null
  })

async function openEditor(page: Page, flowId: string, path = `/flows/${flowId}/edit`) {
  await page.goto(path)
  await expect(page.getByTestId('flow-editor')).toBeVisible()
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
}

async function waitSaved(page: Page) {
  const s = page.getByTestId('flow-save-status')
  await expect(s).toHaveAttribute('data-state', 'saved', { timeout: 15_000 })
  await expect(s).toHaveText(/Salvo às \d{2}:\d{2}/)
}

/** Liga a saída `handle` de `from` à entrada de `to` arrastando com o ponteiro. */
async function connect(page: Page, from: string, handle: string, to: string) {
  const src = page.locator(`.react-flow__handle.source[data-nodeid="${from}"][data-handleid="${handle}"]`)
  const dst = page.locator(`.react-flow__handle.target[data-nodeid="${to}"]`)
  const a = (await src.boundingBox())!
  const b = (await dst.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 10 })
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 })
  await page.mouse.up()
}

test.describe('T45 — paleta e autosave', () => {
  test('AC-T45-01 adicionar nó pela paleta cria o nó (id do cliente), autosave mostra "Salvo às" e recarregar mantém a posição', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page)
    await openEditor(page, f.id)
    const before = await nodeIds(page)
    await page.getByTestId('flow-palette-toggle').click()
    await expect(page.getByTestId('flow-palette')).toBeVisible()
    await page.getByTestId('flow-palette-search').fill('mensagem')
    const item = page.getByTestId('flow-palette-item-message')
    await expect(item).toBeVisible()
    if (isMobile(page)) await item.tap()
    else await item.dragTo(page.getByTestId('flow-canvas'), { targetPosition: { x: 420, y: 260 } })

    await expect.poll(async () => (await nodeIds(page)).length).toBe(before.length + 1)
    const created = (await nodeIds(page)).find((id) => !before.includes(id))!
    expect(created).toMatch(/^n_[a-z0-9]{10}$/)
    await expect(page.getByTestId(`flow-node-${created}`)).toHaveAttribute('data-type', 'message')
    await waitSaved(page)
    const pos = await translateOf(page, created)
    const saved = (await bundle(page, f.id)).nodes.find((n: any) => n.id === created)
    expect(saved, 'nó não foi salvo').toBeTruthy()
    expect({ x: Math.round(saved.position.x), y: Math.round(saved.position.y) }).toEqual(pos)

    await page.reload()
    await expect(node(page, created)).toBeVisible()
    expect(await translateOf(page, created)).toEqual(pos)
  })
})

test.describe('T45 — arestas', () => {
  test('AC-T45-02 ligar um handle já ligado substitui a aresta anterior', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page)
    await putDef(page, f.id, f.start, [msg('m1', 300, 0), msg('m2', 650, -150), msg('m3', 650, 150)], [
      [f.startId, 'source', 'm1'],
      ['m1', 'source', 'm2'],
    ])
    await openEditor(page, f.id)
    await expect(page.locator('.react-flow__edge[data-id="e2"]')).toBeAttached()
    await connect(page, 'm1', 'source', 'm3')
    await expect(page.locator('.react-flow__edge[data-id="e2"]')).toHaveCount(0)
    await waitSaved(page)
    const edges = (await bundle(page, f.id)).edges.filter((e: any) => e.from === 'm1')
    expect(edges.map((e: any) => [e.handle, e.to])).toEqual([['source', 'm3']])
    expect(await page.locator('.react-flow__edge').count()).toBe(2)
  })
})

test.describe('T45 — copiar, colar e excluir', () => {
  test('AC-T45-03 Ctrl+C/Ctrl+V duplica os nós selecionados com deslocamento e ids novos', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page)
    await putDef(page, f.id, f.start, [msg('m1', 300, 0)], [[f.startId, 'source', 'm1']])
    await openEditor(page, f.id)
    const before = await nodeIds(page)
    const origin = (await translateOf(page, 'm1'))!
    await node(page, 'm1').click()
    await page.keyboard.press('ControlOrMeta+c')
    await page.keyboard.press('ControlOrMeta+v')
    await expect.poll(async () => (await nodeIds(page)).length).toBe(before.length + 1)
    const pasted = (await nodeIds(page)).find((id) => !before.includes(id))!
    expect(pasted).not.toBe('m1')
    expect(await translateOf(page, pasted)).toEqual({ x: origin.x + 50, y: origin.y + 50 })
    await expect(page.getByTestId(`flow-node-${pasted}`)).toHaveAttribute('data-type', 'message')
    await waitSaved(page)
    expect((await bundle(page, f.id)).nodes.map((n: any) => n.id)).toContain(pasted)
  })

  test('AC-T45-03 Delete pede confirmação; cancelar mantém e confirmar remove o nó e as arestas ligadas', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page)
    await putDef(page, f.id, f.start, [msg('m1', 300, 0), msg('m2', 650, 0)], [
      [f.startId, 'source', 'm1'],
      ['m1', 'source', 'm2'],
    ])
    await openEditor(page, f.id)
    await node(page, 'm1').click()
    await page.keyboard.press('Delete')
    const dialog = page.getByTestId('flow-delete-confirm')
    await expect(dialog).toBeVisible()
    await page.getByTestId('flow-delete-confirm-cancel').click()
    await expect(dialog).toBeHidden()
    await expect(node(page, 'm1')).toBeVisible()

    await node(page, 'm1').click()
    await page.keyboard.press('Delete')
    await page.getByTestId('flow-delete-confirm-ok').click()
    await expect(node(page, 'm1')).toHaveCount(0)
    await expect(page.locator('.react-flow__edge')).toHaveCount(0)
    await waitSaved(page)
    const def = await bundle(page, f.id)
    expect(def.nodes.map((n: any) => n.id)).not.toContain('m1')
    expect(def.edges.filter((e: any) => e.from === 'm1' || e.to === 'm1')).toHaveLength(0)
  })
})

test.describe('T45 — ativar', () => {
  test('AC-T45-04 ativar fluxo inválido marca os nós com erro e lista os problemas', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page)
    await putDef(page, f.id, f.start, [msg('m1', 300, 0, false)], [[f.startId, 'source', 'm1']])
    await openEditor(page, f.id)
    const resp = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/flows/${f.id}/activate`))
    await page.getByTestId('flow-activate').click()
    expect((await resp).status()).toBe(422)
    await expect(page.getByTestId('flow-node-m1')).toHaveAttribute('data-invalid', 'true')
    await expect(page.getByTestId('flow-node-error-m1')).toBeVisible()
    await expect(page.getByTestId('flow-errors')).toBeVisible()
    await expect(page.getByTestId('flow-errors').locator('[data-testid^="flow-error-"]').first()).toBeVisible()
    await expect(page.getByTestId('flow-status')).not.toHaveAttribute('data-status', 'active')
  })

  test('AC-T45-04 fluxo só com o início é inválido (erro no nó de início)', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page)
    await openEditor(page, f.id)
    await page.getByTestId('flow-activate').click()
    await expect(page.getByTestId(`flow-node-${f.startId}`)).toHaveAttribute('data-invalid', 'true')
    await expect(page.getByTestId('flow-errors')).toBeVisible()
  })

  test('AC-T45-04 fluxo válido mostra status "Ativo" (e pausar mostra "Pausado")', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page)
    await putDef(page, f.id, f.start, [msg('m1', 300, 0)], [[f.startId, 'source', 'm1']])
    await openEditor(page, f.id)
    await page.getByTestId('flow-activate').click()
    const status = page.getByTestId('flow-status')
    await expect(status).toHaveAttribute('data-status', 'active')
    await expect(status).toHaveText(/Ativo/)
    await expect(page.locator('[data-invalid="true"]')).toHaveCount(0)
    await page.getByTestId('flow-pause').click()
    await expect(status).toHaveAttribute('data-status', 'paused')
    await expect(status).toHaveText(/Pausado/)
  })
})

async function otherUser(browser: Browser, owner: Page, baseURL: string | undefined, role: 'admin' | 'member') {
  const ctx = await browser.newContext({ baseURL, viewport: owner.viewportSize() ?? undefined, isMobile: isMobile(owner), hasTouch: isMobile(owner) })
  const p = await ctx.newPage()
  await loginAs(p, role)
  return p
}

test.describe('T45 — leitura e tempo real', () => {
  test('AC-T45-05 sem flows.edit o editor abre só em leitura (sem paleta e sem arrastar)', async ({ page, browser, baseURL }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page)
    await putDef(page, f.id, f.start, [msg('m1', 300, 0)], [[f.startId, 'source', 'm1']])
    const team = await api(page, 'get', '/api/team')
    const m = (team.items ?? team.members ?? team).find((x: any) => (x.email ?? x.user?.email) === SEED_USERS.member)
    await api(page, 'patch', `/api/team/${m.user_id ?? m.user?.id}`, { permission_keys: ['flows.view'] })

    const member = await otherUser(browser, page, baseURL, 'member')
    await openEditor(member, f.id)
    await expect(member.getByTestId('flow-editor')).toHaveAttribute('data-readonly', 'true')
    await expect(member.getByTestId('flow-readonly-notice')).toBeVisible()
    await expect(member.getByTestId('flow-palette-toggle')).toHaveCount(0)
    await expect(member.getByTestId('flow-activate')).toHaveCount(0)

    const before = await translateOf(member, 'm1')
    const box = (await node(member, 'm1').boundingBox())!
    await member.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await member.mouse.down()
    await member.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 + 120, { steps: 15 })
    await member.mouse.up()
    expect(await translateOf(member, 'm1')).toEqual(before)
    await node(member, 'm1').click()
    await member.keyboard.press('Delete')
    await expect(member.getByTestId('flow-delete-confirm')).toHaveCount(0)
    await expect(node(member, 'm1')).toBeVisible()
    await member.context().close()

    // /flows/<id> é sempre leitura, com link para editar quando há permissão
    await openEditor(page, f.id, `/flows/${f.id}`)
    await expect(page.getByTestId('flow-editor')).toHaveAttribute('data-readonly', 'true')
    await expect(page.getByTestId('flow-edit-link')).toBeVisible()
  })

  test('AC-T45-05 mudança feita por outro usuário (SSE) aparece sem recarregar', async ({ page, browser, baseURL }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page)
    await putDef(page, f.id, f.start, [msg('m1', 300, 0)], [[f.startId, 'source', 'm1']])
    await trackSse(page)
    await openEditor(page, f.id)
    await waitSseOpen(page)
    await page.evaluate(() => ((window as any).__t45NoReload = true))

    const admin = await otherUser(browser, page, baseURL, 'admin')
    await putDef(admin, f.id, f.start, [msg('m1', 300, 0), msg('m9', 650, 80)], [
      [f.startId, 'source', 'm1'],
      ['m1', 'source', 'm9'],
    ])
    await admin.context().close()

    await expect(node(page, 'm9')).toBeVisible({ timeout: 20_000 })
    expect(await translateOf(page, 'm9')).toEqual({ x: 650, y: 80 })
    expect(await page.evaluate(() => (window as any).__t45NoReload)).toBe(true)
  })
})
