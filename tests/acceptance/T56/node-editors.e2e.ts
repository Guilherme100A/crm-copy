// AC-T56-01..04 — editores de nó de mensagem e interativos (contrato `ne-*` de spec/reports/T56-entrega.md):
// ações do nó Mensagem (adicionar, reordenar, remover, upload `/api/media` → `blob:<sha256>`, variável), bloqueio do
// autosave por erro de schema (T10), menu com handles estáveis e prazo até 31 dias, prévias de carrossel e Pix.
// Persistência sempre conferida pelo `GET /api/flows/:id/editor-bundle`. Só desktop (nenhum AC cita mobile).
import { createHash } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const sha256 = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const PNG2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DAAMIg4j8AGvMD/UInS7AAAAAASUVORK5CYII=', 'base64')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

async function api(page: Page, method: 'get' | 'post' | 'put', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

const bundle = async (page: Page, flowId: string) => (await api(page, 'get', `/api/flows/${flowId}/editor-bundle`)).definition
const savedNode = async (page: Page, flowId: string, nodeId: string) => (await bundle(page, flowId)).nodes.find((n: any) => n.id === nodeId)
const savedActions = async (page: Page, flowId: string, nodeId: string) => ((await savedNode(page, flowId, nodeId))?.actions ?? []) as any[]
const savedConfig = async (page: Page, flowId: string, nodeId: string, type: string) =>
  (await savedActions(page, flowId, nodeId)).find((a) => a.type === type)?.config as Record<string, any> | undefined

/** Fluxo novo com os nós dados (o primeiro ligado ao início) e as arestas extras `[from, handle, to]`. */
async function flowWith(page: Page, nodes: any[], edges: Array<[string, string, string]> = []) {
  const body = await api(page, 'post', '/api/flows', { name: `Fluxo ${uniq()}` })
  const id = (body.flow ?? body).id as string
  const start = (await bundle(page, id)).nodes.find((n: any) => n.type === 'start')
  const all: Array<[string, string, string]> = [[start.id, 'source', nodes[0].id], ...edges]
  await api(page, 'put', `/api/flows/${id}/definition`, {
    schema: 'crm.flow/v1',
    entry: start.id,
    nodes: [start, ...nodes],
    edges: all.map(([from, handle, to], i) => ({ id: `e${i + 1}`, from, handle, to })),
    variables: [],
    refs: {},
  })
  return id
}

const nodeOf = (id: string, type: string, actions: any[] = [], x = 320, y = 0) => ({ id, type, name: `${type} ${id}`, position: { x, y }, actions })

/** Abre o editor do fluxo e seleciona o nó; devolve o painel `flow-node-editor`. */
async function openNode(page: Page, flowId: string, nodeId: string) {
  await page.goto(`/flows/${flowId}/edit`)
  await expect(page).toHaveURL(new RegExp(`/flows/${flowId}/edit`))
  await expect(page.getByTestId('flow-editor')).toBeVisible()
  const n = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  await expect(n).toBeVisible()
  await n.click()
  const panel = page.getByTestId('flow-node-editor').filter({ visible: true })
  await expect(panel).toBeVisible()
  return panel
}

const status = (panel: Locator) => panel.getByTestId('ne-status')
const actionIds = (panel: Locator) => panel.locator('[data-testid^="ne-action-"][data-action-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-action-id')!))

/** Clica na lista de variáveis do campo dentro de `scope` e escolhe `name`. */
async function pickVar(scope: Locator, name: string) {
  await scope.getByTestId('ne-var-picker').click()
  const list = scope.getByTestId('ne-var-list')
  await expect(list).toBeVisible()
  await list.getByTestId(`ne-var-${name}`).click()
}

/** Faz upload em `input` esperando o `POST /api/media` 201; devolve o `media` da resposta. */
async function upload(page: Page, input: Locator, file: { name: string; mimeType: string; buffer: Buffer }) {
  const resp = page.waitForResponse((r) => r.url().endsWith('/api/media') && r.request().method() === 'POST')
  await input.setInputFiles(file)
  const r = await resp
  expect(r.status(), await r.text()).toBe(201)
  return (await r.json()).media as { id: string; sha256: string }
}

// ------------------------------------------------------------------ AC-T56-01

test.describe('T56 — nó Mensagem', () => {
  test('AC-T56-01 adiciona texto, mídia, arquivo, figurinha, contato e atraso; upload via /api/media grava blob:<sha256>; variável entra no cursor', async ({ page }) => {
    await loginAs(page, 'owner')
    // Seed sem figurinhas: uma na biblioteca da empresa.
    const st = await page.request.post('/api/stickers', { headers: XRW, multipart: { file: { name: 'oi.webp', mimeType: 'image/webp', buffer: WEBP }, name: 'Oi' } })
    expect(st.status(), await st.text()).toBe(201)
    const stickerId = (await st.json()).sticker.id as string

    const flowId = await flowWith(page, [nodeOf('m1', 'message')])
    const panel = await openNode(page, flowId, 'm1')
    await expect(panel.getByTestId('ne-message')).toBeVisible()
    await expect(panel.getByTestId('ne-msg-empty')).toBeVisible()

    // Texto com variável inserida no meio (posição do cursor).
    await panel.getByTestId('ne-msg-add-send_message').click()
    const row0 = panel.getByTestId('ne-action-0')
    await expect(row0).toHaveAttribute('data-type', 'send_message')
    const text = row0.getByTestId('ne-action-text-0')
    await text.fill('Oi , tudo bem?')
    await text.evaluate((el: HTMLTextAreaElement) => {
      el.focus()
      el.setSelectionRange(3, 3)
    })
    await pickVar(row0, 'first_name')
    await expect(text).toHaveValue('Oi {first_name}, tudo bem?')

    // Mídia (imagem) por upload.
    await panel.getByTestId('ne-msg-add-send_multi_media').click()
    const row1 = panel.getByTestId('ne-action-1')
    await expect(row1).toHaveAttribute('data-type', 'send_multi_media')
    const img = await upload(page, row1.getByTestId('ne-action-file-1'), { name: 'foto.png', mimeType: 'image/png', buffer: PNG })
    expect(img.sha256).toBe(sha256(PNG))
    await expect(row1.getByTestId('ne-action-name-1')).toHaveText('foto.png')
    await row1.getByTestId('ne-action-caption-1').fill('Veja')

    // Arquivo por upload (nome do arquivo preenchido).
    await panel.getByTestId('ne-msg-add-send_file').click()
    const row2 = panel.getByTestId('ne-action-2')
    const doc = await upload(page, row2.getByTestId('ne-action-file-2'), { name: 'tabela.pdf', mimeType: 'application/pdf', buffer: PDF })
    expect(doc.sha256).toBe(sha256(PDF))
    await expect(row2.getByTestId('ne-action-file-name-2')).toHaveValue('tabela.pdf')

    // Figurinha da biblioteca (reenviada ao /api/media, endereçada por conteúdo).
    await panel.getByTestId('ne-msg-add-send_sticker').click()
    const row3 = panel.getByTestId('ne-action-3')
    const stickerResp = page.waitForResponse((r) => r.url().endsWith('/api/media') && r.request().method() === 'POST')
    await row3.getByTestId(`ne-action-sticker-${stickerId}-3`).click()
    expect((await stickerResp).status()).toBe(201)
    await expect(row3.getByTestId('ne-action-sticker-name-3')).toHaveValue('Oi')

    // Contato e atraso.
    await panel.getByTestId('ne-msg-add-send_contact').click()
    const row4 = panel.getByTestId('ne-action-4')
    await row4.getByTestId('ne-action-contact-name-4').fill('Suporte')
    await row4.getByTestId('ne-action-contact-phone-4').fill('+5511999990000')
    await panel.getByTestId('ne-msg-add-delay_between_messages').click()
    const row5 = panel.getByTestId('ne-action-5')
    await row5.getByTestId('ne-action-delay-5').fill('5')

    await expect(status(panel)).toHaveAttribute('data-state', 'saved')
    const types = ['send_message', 'send_multi_media', 'send_file', 'send_sticker', 'send_contact', 'delay_between_messages']
    await expect.poll(async () => (await savedActions(page, flowId, 'm1')).map((a) => a.type), { timeout: 20_000 }).toEqual(types)
    await expect.poll(async () => (await savedActions(page, flowId, 'm1')).find((a) => a.type === 'delay_between_messages')?.config.delay_seconds).toBe(5)
    const saved = await savedActions(page, flowId, 'm1')
    const cfg = (t: string) => saved.find((a) => a.type === t)!.config
    expect(saved.map((a) => a.order)).toEqual([0, 1, 2, 3, 4, 5])
    expect(new Set(saved.map((a) => a.id)).size).toBe(6)
    expect(cfg('send_message').message_text).toBe('Oi {first_name}, tudo bem?')
    expect(cfg('send_multi_media')).toMatchObject({ media_type: 'image', media_url: `blob:${sha256(PNG)}` })
    expect(cfg('send_multi_media').messages?.[0]?.caption).toBe('Veja')
    expect(cfg('send_file')).toMatchObject({ file_url: `blob:${sha256(PDF)}`, file_name: 'tabela.pdf' })
    expect(cfg('send_sticker')).toMatchObject({ sticker_url: `blob:${sha256(WEBP)}`, sticker_name: 'Oi' })
    expect(cfg('send_contact')).toMatchObject({ contact_name: 'Suporte', contact_phone: '+5511999990000' })

    // Recarregar mostra o mesmo nó.
    await page.reload()
    const again = await openNode(page, flowId, 'm1')
    await expect(again.getByTestId('ne-action-0').getByTestId('ne-action-text-0')).toHaveValue('Oi {first_name}, tudo bem?')
    expect(await actionIds(again)).toEqual(saved.map((a) => a.id))
  })

  test('AC-T56-01 reordena (subir/descer e arrastar pela alça) e remove ações; a ordem salva acompanha', async ({ page }) => {
    await loginAs(page, 'owner')
    const acts = [
      { id: 'a_texto', type: 'send_message', order: 0, config: { message_text: 'Primeiro' } },
      { id: 'a_contato', type: 'send_contact', order: 1, config: { contact_name: 'Ana', contact_phone: '+5511988887777' } },
      { id: 'a_atraso', type: 'delay_between_messages', order: 2, config: { delay_seconds: 4 } },
    ]
    const flowId = await flowWith(page, [nodeOf('m1', 'message', acts)])
    const panel = await openNode(page, flowId, 'm1')
    expect(await actionIds(panel)).toEqual(['a_texto', 'a_contato', 'a_atraso'])
    const savedIds = async () => (await savedActions(page, flowId, 'm1')).map((a) => a.id)

    // Subir o contato.
    await panel.getByTestId('ne-action-up-1').click()
    expect(await actionIds(panel)).toEqual(['a_contato', 'a_texto', 'a_atraso'])
    await expect.poll(savedIds, { timeout: 20_000 }).toEqual(['a_contato', 'a_texto', 'a_atraso'])
    expect((await savedActions(page, flowId, 'm1')).map((a) => a.order)).toEqual([0, 1, 2])

    // Descer o contato de volta.
    await panel.getByTestId('ne-action-down-0').click()
    await expect.poll(savedIds, { timeout: 20_000 }).toEqual(['a_texto', 'a_contato', 'a_atraso'])

    // Arrastar o atraso (último) para o topo pela alça.
    const handle = panel.getByTestId('ne-action-handle-2')
    const target = panel.getByTestId('ne-action-0')
    await handle.scrollIntoViewIfNeeded() // o painel rola: a alça da última linha fica abaixo da dobra
    const a = (await handle.boundingBox())!
    const b = (await target.boundingBox())!
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + a.width / 2, a.y - 10, { steps: 5 })
    await page.mouse.move(a.x + a.width / 2, b.y + 4, { steps: 20 })
    await page.mouse.up()
    await expect.poll(() => actionIds(panel)).toEqual(['a_atraso', 'a_texto', 'a_contato'])
    await expect.poll(savedIds, { timeout: 20_000 }).toEqual(['a_atraso', 'a_texto', 'a_contato'])

    // Remover o texto.
    await panel.getByTestId('ne-action-remove-1').click()
    expect(await actionIds(panel)).toEqual(['a_atraso', 'a_contato'])
    await expect.poll(savedIds, { timeout: 20_000 }).toEqual(['a_atraso', 'a_contato'])
    expect((await savedActions(page, flowId, 'm1')).map((a) => a.order)).toEqual([0, 1])
  })
})

// ------------------------------------------------------------------ AC-T56-02

test.describe('T56 — validação bloqueia salvar', () => {
  test('AC-T56-02 texto vazio e atraso acima de 120 s mostram erro inline no campo e o nó salvo fica no último estado válido', async ({ page }) => {
    await loginAs(page, 'owner')
    const acts = [
      { id: 'a_texto', type: 'send_message', order: 0, config: { message_text: 'Olá' } },
      { id: 'a_atraso', type: 'delay_between_messages', order: 1, config: { delay_seconds: 3 } },
    ]
    const flowId = await flowWith(page, [nodeOf('m1', 'message', acts)])
    const panel = await openNode(page, flowId, 'm1')
    await expect(status(panel)).toHaveAttribute('data-state', 'saved')

    // Texto obrigatório (schema do T10).
    const row0 = panel.getByTestId('ne-action-0')
    await row0.getByTestId('ne-action-text-0').fill('')
    await expect(row0.getByTestId('ne-error-message_text')).toBeVisible()
    await expect(row0.getByTestId('ne-action-text-0')).toHaveAttribute('aria-invalid', 'true')
    await expect(row0).toHaveAttribute('data-invalid', 'true')
    await expect(status(panel)).toHaveAttribute('data-state', 'blocked')
    // Uma mudança válida em outra ação também não sai enquanto houver erro.
    await panel.getByTestId('ne-action-1').getByTestId('ne-action-delay-1').fill('7')
    await page.waitForTimeout(3500)
    let saved = await savedActions(page, flowId, 'm1')
    expect(saved.find((a) => a.id === 'a_texto')!.config.message_text).toBe('Olá')
    expect(saved.find((a) => a.id === 'a_atraso')!.config.delay_seconds).toBe(3)

    // Corrigir libera o salvamento (com a mudança pendente).
    await row0.getByTestId('ne-action-text-0').fill('Olá de novo')
    await expect(row0.getByTestId('ne-error-message_text')).toHaveCount(0)
    await expect(status(panel)).toHaveAttribute('data-state', 'saved')
    await expect.poll(async () => (await savedActions(page, flowId, 'm1')).map((a) => a.config.message_text ?? a.config.delay_seconds), { timeout: 20_000 }).toEqual(['Olá de novo', 7])

    // Atraso acima do máximo (120 s).
    const row1 = panel.getByTestId('ne-action-1')
    await row1.getByTestId('ne-action-delay-1').fill('121')
    await expect(row1.getByTestId('ne-error-delay_seconds')).toBeVisible()
    await expect(status(panel)).toHaveAttribute('data-state', 'blocked')
    await page.waitForTimeout(3500)
    saved = await savedActions(page, flowId, 'm1')
    expect(saved.find((a) => a.id === 'a_atraso')!.config.delay_seconds).toBe(7)
    await row1.getByTestId('ne-action-delay-1').fill('120')
    await expect(status(panel)).toHaveAttribute('data-state', 'saved')
    await expect.poll(async () => (await savedActions(page, flowId, 'm1')).find((a) => a.id === 'a_atraso')!.config.delay_seconds, { timeout: 20_000 }).toBe(120)
  })

  test('AC-T56-02 menu com opção sem título e Pix com chave inválida para o tipo ficam bloqueados com erro no campo', async ({ page }) => {
    await loginAs(page, 'owner')
    const menuCfg = { menuType: 'list', message: 'Escolha', buttonLabel: 'Ver', options: [{ id: 'option_a', title: 'Vendas' }], timeout_value: 0, timeout_unit: 'days' }
    const pixCfg = { pix_type: 'EMAIL', pix_key: 'contato@loja.test' }
    const flowId = await flowWith(page, [
      nodeOf('menu1', 'interactive_menu', [{ id: 'a_menu', type: 'send_interactive_menu', order: 0, config: menuCfg }]),
      nodeOf('pix1', 'pix', [{ id: 'a_pix', type: 'send_pix_button', order: 0, config: pixCfg }], 320, 260),
    ])

    const panel = await openNode(page, flowId, 'menu1')
    const opt = panel.getByTestId('ne-menu-option-option_a')
    await opt.getByTestId('ne-menu-option-title-option_a').fill('')
    await expect(opt.getByTestId('ne-error-options.0.title')).toBeVisible()
    await expect(status(panel)).toHaveAttribute('data-state', 'blocked')
    await panel.getByTestId('ne-menu-button-label').fill('')
    await expect(panel.getByTestId('ne-error-buttonLabel')).toBeVisible()
    await page.waitForTimeout(3500)
    expect(await savedConfig(page, flowId, 'menu1', 'send_interactive_menu')).toMatchObject({ buttonLabel: 'Ver', options: [{ id: 'option_a', title: 'Vendas' }] })

    // Pix: CPF exige 11 dígitos; e-mail como CPF é recusado.
    await page.locator('.react-flow__node[data-id="pix1"]').click()
    const pix = page.getByTestId('flow-node-editor').filter({ visible: true })
    await expect(pix.getByTestId('ne-pix')).toBeVisible()
    await pix.getByTestId('ne-pix-type').selectOption('CPF')
    await expect(pix.getByTestId('ne-error-pix_key')).toBeVisible()
    await expect(status(pix)).toHaveAttribute('data-state', 'blocked')
    await page.waitForTimeout(3500)
    expect(await savedConfig(page, flowId, 'pix1', 'send_pix_button')).toMatchObject(pixCfg)
    await pix.getByTestId('ne-pix-key').fill('123.456.789-09')
    await expect(pix.getByTestId('ne-error-pix_key')).toHaveCount(0)
    await expect(status(pix)).toHaveAttribute('data-state', 'saved')
    await expect.poll(async () => (await savedConfig(page, flowId, 'pix1', 'send_pix_button'))?.pix_type, { timeout: 20_000 }).toBe('CPF')
  })
})

// ------------------------------------------------------------------ AC-T56-03

const optionIds = (panel: Locator) =>
  panel.getByTestId('ne-menu-options').locator('[data-testid^="ne-menu-option-"][data-handle]').evaluateAll((els) => els.map((e) => e.getAttribute('data-handle')!.replace(/^option:/, '')))
const canvasHandle = (page: Page, nodeId: string, optId: string) => page.locator(`.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="option:${optId}"]`)

test.describe('T56 — menu interativo', () => {
  test('AC-T56-03 cria opções com ids estáveis (handles option:<id> no canvas), mostra o aviso de menu numerado em texto e salva', async ({ page }) => {
    await loginAs(page, 'owner')
    const flowId = await flowWith(page, [nodeOf('menu1', 'interactive_menu')])
    const panel = await openNode(page, flowId, 'menu1')
    await expect(panel.getByTestId('ne-menu-baileys-notice')).toContainText(/enviado como menu numerado em texto/i)

    await panel.getByTestId('ne-menu-message').fill('Como posso ajudar?')
    let ids = await optionIds(panel)
    expect(ids).toHaveLength(1)
    await panel.getByTestId(`ne-menu-option-title-${ids[0]}`).fill('Vendas')
    for (const title of ['Suporte', 'Financeiro']) {
      await panel.getByTestId('ne-menu-add-option').click()
      ids = await optionIds(panel)
      await panel.getByTestId(`ne-menu-option-title-${ids.at(-1)}`).fill(title)
    }
    ids = await optionIds(panel)
    expect(ids).toHaveLength(3)
    for (const id of ids) expect(id).toMatch(/^option_[a-z0-9]+$/)
    expect(new Set(ids).size).toBe(3)
    await expect(status(panel)).toHaveAttribute('data-state', 'saved')
    for (const id of ids) await expect(canvasHandle(page, 'menu1', id)).toHaveCount(1)

    await expect.poll(async () => (await savedConfig(page, flowId, 'menu1', 'send_interactive_menu'))?.options?.map((o: any) => [o.id, o.title]), { timeout: 20_000 }).toEqual([
      [ids[0], 'Vendas'],
      [ids[1], 'Suporte'],
      [ids[2], 'Financeiro'],
    ])

    // Reordenar não muda os ids (nem os handles); o título acompanha o id.
    await panel.getByTestId(`ne-menu-option-down-${ids[0]}`).click()
    expect(await optionIds(panel)).toEqual([ids[1], ids[0], ids[2]])
    await expect.poll(async () => (await savedConfig(page, flowId, 'menu1', 'send_interactive_menu'))?.options?.map((o: any) => [o.id, o.title]), { timeout: 20_000 }).toEqual([
      [ids[1], 'Suporte'],
      [ids[0], 'Vendas'],
      [ids[2], 'Financeiro'],
    ])
    for (const id of ids) await expect(canvasHandle(page, 'menu1', id)).toHaveCount(1)

    // Recarregar mantém os mesmos ids.
    await page.reload()
    const again = await openNode(page, flowId, 'menu1')
    expect(await optionIds(again)).toEqual([ids[1], ids[0], ids[2]])
  })

  test('AC-T56-03 aresta ligada a uma opção sobrevive a reordenar, adicionar e remover outras opções', async ({ page }) => {
    await loginAs(page, 'owner')
    const cfg = {
      menuType: 'list',
      message: 'Escolha',
      buttonLabel: 'Ver opções',
      options: [
        { id: 'option_a', title: 'A' },
        { id: 'option_b', title: 'B' },
        { id: 'option_c', title: 'C' },
      ],
      timeout_value: 0,
      timeout_unit: 'days',
    }
    const flowId = await flowWith(
      page,
      [nodeOf('menu1', 'interactive_menu', [{ id: 'a_menu', type: 'send_interactive_menu', order: 0, config: cfg }]), nodeOf('m2', 'message', [{ id: 'a2', type: 'send_message', order: 0, config: { message_text: 'B escolhido' } }], 760, 0)],
      [['menu1', 'option:option_b', 'm2']],
    )
    const panel = await openNode(page, flowId, 'menu1')
    await panel.getByTestId('ne-menu-option-up-option_b').click()
    await panel.getByTestId('ne-menu-option-remove-option_c').click()
    await panel.getByTestId('ne-menu-add-option').click()
    const ids = await optionIds(panel)
    expect(ids.slice(0, 2)).toEqual(['option_b', 'option_a'])
    const fresh = ids[2]!
    expect(['option_a', 'option_b', 'option_c']).not.toContain(fresh)
    await panel.getByTestId(`ne-menu-option-title-${fresh}`).fill('D')
    await expect(status(panel)).toHaveAttribute('data-state', 'saved')

    await expect.poll(async () => (await savedConfig(page, flowId, 'menu1', 'send_interactive_menu'))?.options?.map((o: any) => o.id), { timeout: 20_000 }).toEqual(['option_b', 'option_a', fresh])
    const def = await bundle(page, flowId)
    expect(def.edges.filter((e: any) => e.from === 'menu1').map((e: any) => [e.handle, e.to])).toEqual([['option:option_b', 'm2']])
    await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  })

  test('AC-T56-03 prazo aceita até 31 dias (31 dias e 744 horas salvam; 32 dias e 745 horas bloqueiam)', async ({ page }) => {
    await loginAs(page, 'owner')
    const cfg = { menuType: 'list', message: 'Escolha', buttonLabel: 'Ver', options: [{ id: 'option_a', title: 'A' }], timeout_value: 0, timeout_unit: 'days' }
    const flowId = await flowWith(page, [nodeOf('menu1', 'interactive_menu', [{ id: 'a_menu', type: 'send_interactive_menu', order: 0, config: cfg }])])
    const panel = await openNode(page, flowId, 'menu1')
    const value = panel.getByTestId('ne-timeout-value')
    const unit = panel.getByTestId('ne-timeout-unit')
    const timeout = async () => {
      const c = await savedConfig(page, flowId, 'menu1', 'send_interactive_menu')
      return [c?.timeout_value, c?.timeout_unit]
    }

    await unit.selectOption('days')
    await value.fill('31')
    await expect(status(panel)).toHaveAttribute('data-state', 'saved')
    await expect.poll(timeout, { timeout: 20_000 }).toEqual([31, 'days'])

    await value.fill('32')
    await expect(panel.getByTestId('ne-error-timeout_value')).toBeVisible()
    await expect(status(panel)).toHaveAttribute('data-state', 'blocked')
    await page.waitForTimeout(3500)
    expect(await timeout()).toEqual([31, 'days'])

    await unit.selectOption('hours')
    await value.fill('744')
    await expect(panel.getByTestId('ne-error-timeout_value')).toHaveCount(0)
    await expect.poll(timeout, { timeout: 20_000 }).toEqual([744, 'hours'])
    await value.fill('745')
    await expect(panel.getByTestId('ne-error-timeout_value')).toBeVisible()
    await expect(status(panel)).toHaveAttribute('data-state', 'blocked')
  })

  test('AC-T56-03 lista de opções legada (menu) também mostra o aviso de menu numerado em texto', async ({ page }) => {
    await loginAs(page, 'owner')
    const flowId = await flowWith(page, [nodeOf('leg1', 'menu')])
    const panel = await openNode(page, flowId, 'leg1')
    await expect(panel.getByTestId('ne-menu-baileys-notice')).toContainText(/enviado como menu numerado em texto/i)
    await expect(panel.getByTestId('ne-menu-legacy-notice')).toBeVisible()
    const [id] = await optionIds(panel)
    await panel.getByTestId('ne-menu-message').fill('Menu antigo')
    await panel.getByTestId(`ne-menu-option-title-${id}`).fill('Única')
    await expect.poll(async () => (await savedConfig(page, flowId, 'leg1', 'send_option_list'))?.options?.map((o: any) => o.id), { timeout: 20_000 }).toEqual([id])
    await expect(canvasHandle(page, 'leg1', id!)).toHaveCount(1)
  })
})

// ------------------------------------------------------------------ AC-T56-04

/** BR Code estático como o motor (packages/core/src/flows/nodes/messaging/pix.ts), refeito aqui como oráculo. */
function expectedEmv(key: string, merchant: string, amount: string) {
  const f = (id: string, v: string) => `${id}${String(Buffer.byteLength(v)).padStart(2, '0')}${v}`
  const payload =
    f('00', '01') + f('26', f('00', 'br.gov.bcb.pix') + f('01', key)) + f('52', '0000') + f('53', '986') + f('54', amount) + f('58', 'BR') + f('59', merchant) + f('60', 'BRASIL') + f('62', f('05', '***')) + '6304'
  let crc = 0xffff
  for (const byte of Buffer.from(payload)) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return payload + crc.toString(16).toUpperCase().padStart(4, '0')
}

test.describe('T56 — prévias', () => {
  test('AC-T56-04 Pix mostra a prévia em balão de chat com chave, recebedor, valor e o copia e cola (CRC16) que será enviado', async ({ page }) => {
    await loginAs(page, 'owner')
    const flowId = await flowWith(page, [nodeOf('pix1', 'pix')])
    const panel = await openNode(page, flowId, 'pix1')
    await panel.getByTestId('ne-pix-type').selectOption('EMAIL')
    await panel.getByTestId('ne-pix-key').fill('Contato@Loja.test')
    await panel.getByTestId('ne-pix-merchant').fill('Loja Teste')
    await panel.getByTestId('ne-pix-amount').fill('49,90')

    const preview = panel.getByTestId('ne-preview')
    await expect(preview.getByTestId('ne-preview-message-0')).toHaveAttribute('data-kind', 'text')
    await expect(preview.getByTestId('ne-preview-text-0')).toHaveText('Chave Pix: Contato@Loja.test\nRecebedor: Loja Teste\nValor: R$ 49,90\n\nPix copia e cola:', { useInnerText: true })
    await expect(preview.getByTestId('ne-preview-code-0')).toHaveText(expectedEmv('contato@loja.test', 'Loja Teste', '49.90'))
    await expect.poll(async () => await savedConfig(page, flowId, 'pix1', 'send_pix_button'), { timeout: 20_000 }).toMatchObject({ pix_type: 'EMAIL', pix_key: 'Contato@Loja.test', merchant_name: 'Loja Teste', amount_reais: '49,90' })

    // A prévia acompanha a edição; com variável na chave o código é montado no envio.
    await panel.getByTestId('ne-pix-amount').fill('')
    await expect(preview.getByTestId('ne-preview-text-0')).toHaveText('Chave Pix: Contato@Loja.test\nRecebedor: Loja Teste\n\nPix copia e cola:', { useInnerText: true })
    await panel.getByTestId('ne-pix-key').fill('{pix_chave}')
    await expect(preview.getByTestId('ne-preview-text-0')).toContainText('Chave Pix: {pix_chave}')
    await expect(preview.getByTestId('ne-preview-code-0')).toHaveText('(código gerado no envio)')
  })

  test('AC-T56-04 carrossel mostra a prévia em formato de chat: cada cartão como imagem com legenda e, no fim, o menu numerado dos botões de resposta', async ({ page }) => {
    await loginAs(page, 'owner')
    const flowId = await flowWith(page, [nodeOf('car1', 'carousel')])
    const panel = await openNode(page, flowId, 'car1')
    await expect(panel.getByTestId('ne-carousel-baileys-notice')).toBeVisible()
    await panel.getByTestId('ne-carousel-text').fill('Escolha um plano')

    // Cartão 1: imagem enviada, botão de resposta e link.
    const card0 = panel.getByTestId('ne-carousel-card-0')
    await card0.getByTestId('ne-carousel-card-text-0').fill('Plano Básico')
    const m0 = await upload(page, card0.getByTestId('ne-carousel-card-file-0'), { name: 'basico.png', mimeType: 'image/png', buffer: PNG })
    await card0.getByTestId('ne-carousel-add-button-0').click()
    await card0.locator('[data-testid^="ne-carousel-button-text-"]').nth(0).fill('Quero')
    await card0.getByTestId('ne-carousel-add-button-0').click()
    await card0.locator('[data-testid^="ne-carousel-button-type-"]').nth(1).selectOption('URL')
    await card0.locator('[data-testid^="ne-carousel-button-text-"]').nth(1).fill('Site')
    await card0.locator('[data-testid^="ne-carousel-button-payload-"]').first().fill('https://loja.test/basico')

    // Cartão 2.
    await panel.getByTestId('ne-carousel-add-card').click()
    const card1 = panel.getByTestId('ne-carousel-card-1')
    await card1.getByTestId('ne-carousel-card-text-1').fill('Plano Pro')
    const m1 = await upload(page, card1.getByTestId('ne-carousel-card-file-1'), { name: 'pro.png', mimeType: 'image/png', buffer: PNG2 })
    await card1.getByTestId('ne-carousel-add-button-1').click()
    await card1.locator('[data-testid^="ne-carousel-button-text-"]').nth(0).fill('Quero o Pro')

    const preview = panel.getByTestId('ne-preview')
    await expect(preview.locator('[data-testid^="ne-preview-message-"]')).toHaveCount(3)
    await expect(preview.getByTestId('ne-preview-message-0')).toHaveAttribute('data-kind', 'image')
    await expect(preview.getByTestId('ne-preview-text-0')).toHaveText('Plano Básico\nSite: https://loja.test/basico', { useInnerText: true })
    await expect(preview.getByTestId('ne-preview-message-1')).toHaveAttribute('data-kind', 'image')
    await expect(preview.getByTestId('ne-preview-text-1')).toHaveText('Plano Pro')
    await expect(preview.getByTestId('ne-preview-message-2')).toHaveAttribute('data-kind', 'text')
    await expect(preview.getByTestId('ne-preview-text-2')).toHaveText('Escolha um plano\n\n1 - Quero\n2 - Quero o Pro', { useInnerText: true })
    // As imagens da prévia carregam (mídia enviada, sem URL externa).
    for (const [i, m] of [[0, m0], [1, m1]] as const) {
      const im = preview.getByTestId(`ne-preview-message-${i}`).locator('img')
      await expect(im).toHaveAttribute('src', new RegExp(m.id))
      await expect.poll(() => im.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0)
    }

    await expect(status(panel)).toHaveAttribute('data-state', 'saved')
    await expect.poll(async () => (await savedConfig(page, flowId, 'car1', 'send_carousel'))?.carousel?.map((k: any) => [k.text, k.image]), { timeout: 20_000 }).toEqual([
      ['Plano Básico', `blob:${sha256(PNG)}`],
      ['Plano Pro', `blob:${sha256(PNG2)}`],
    ])

    // Reordenar os cartões reordena a prévia.
    await panel.getByTestId('ne-carousel-card-up-1').click()
    await expect(preview.getByTestId('ne-preview-text-0')).toHaveText('Plano Pro')
    await expect(preview.getByTestId('ne-preview-text-2')).toHaveText('Escolha um plano\n\n1 - Quero o Pro\n2 - Quero', { useInnerText: true })
  })
})
