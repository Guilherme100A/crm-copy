// AC-T58-01..05 — abas de conteúdo do hub /settings: respostas rápidas (tabela com busca/paginação no servidor, editor
// de ações reordenáveis com mídia, 409 de atalho duplicado), modelos internos (prévia em balão com variáveis do contato
// de exemplo, sem menção a provedor), variáveis globais (prefixo g_ fixo, número validado no cliente), campos
// personalizados (Customizados × Sistema, descrição de sistema editável), etiquetas (cor e contagem) e o papel member
// sem botões de edição + cartões no mobile. Testids combinados com o Esquadro (brief T58, "Entrega do operário").
// O seed não tem contatos nem figurinhas: tudo é criado pela API.
import { expect, test, type Page, type Request } from '@playwright/test'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'patch', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

const PNG = (() => {
  const buf = Buffer.alloc(2048, 0x20)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
  return buf
})()
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20])

async function sticker(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/stickers', {
    multipart: { file: { name: `${name}.webp`, mimeType: 'image/webp', buffer: WEBP }, name },
    headers: XRW,
  })
  expect(res.status(), await res.text()).toBeLessThan(300)
  const body = await res.json()
  return (body.sticker ?? body).id
}

const quickReply = async (page: Page, shortcut: string, text = `texto ${shortcut}`) =>
  (await api(page, 'post', '/api/quick-replies', { shortcut, actions: [{ type: 'send_message', config: { message_text: text } }] }))
    .quick_reply as { id: string; shortcut: string }

const contact = async (page: Page, name: string, extra: Record<string, unknown> = {}) =>
  (await api(page, 'post', '/api/contacts', { name, phone: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, ...extra }))
    .contact as { id: string; name: string }

/** Abre a aba do hub e espera o replace de `?tab=` assentar (lição da T53) antes de olhar o conteúdo. */
async function openTab(page: Page, tab: string, testid: string) {
  await page.goto(`/settings?tab=${tab}`)
  await expect(page).toHaveURL(new RegExp(`[?&]tab=${tab}(&|$)`))
  await expect(page.getByTestId(testid)).toBeVisible()
  if (!isMobile(page)) {
    await expect(page.getByTestId(`settings-tab-${tab}`)).toBeVisible()
    return
  }
  // mobile (<1024 px, desde a T53): sem <nav>; a aba ativa é a opção marcada no select pesquisável
  const trigger = page.getByTestId('settings-tab-select')
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByTestId(`settings-tab-option-${tab}`)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-tab-select-search')).toHaveCount(0)
}

const tableRows = (page: Page, p: string) => page.getByTestId(`${p}-table`).locator('tbody > tr')

// ---------------------------------------------------------------------------------------------------------------
test.describe('T58 — respostas rápidas', () => {
  test('AC-T58-01 tabela com paginação de 20 e busca no servidor', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    for (let i = 0; i < 21; i++) await quickReply(page, `qr${tag}-${String(i).padStart(2, '0')}`)
    const promo = await quickReply(page, `promo${tag}`, 'Cupom de desconto')
    const total = (await api(page, 'get', '/api/quick-replies?page=1&limit=1')).page.total_count as number
    expect(total).toBeGreaterThanOrEqual(22)

    await openTab(page, 'quick_replies', 'page-quick-replies')
    await expect(page.getByTestId('quick-replies-table')).toBeVisible()
    await expect(tableRows(page, 'quick-replies')).toHaveCount(20)
    const pages = Math.ceil(total / 20)
    await expect(page.getByTestId('quick-replies-page')).toContainText(`${pages}`)
    await expect(page.getByTestId('quick-replies-prev')).toBeDisabled()

    const next = page.waitForRequest((r) => r.url().includes('/api/quick-replies?') && new URL(r.url()).searchParams.get('page') === '2')
    await page.getByTestId('quick-replies-next').click()
    await next
    await expect(tableRows(page, 'quick-replies')).toHaveCount(Math.min(20, total - 20))
    await expect(page.getByTestId('quick-replies-prev')).toBeEnabled()

    // busca vai ao servidor (search=) e volta para a página 1
    const searched = page.waitForRequest((r) => r.url().includes('/api/quick-replies?') && new URL(r.url()).searchParams.get('search') === `promo${tag}`)
    await page.getByTestId('quick-replies-search').fill(`promo${tag}`)
    const req = await searched
    expect(new URL(req.url()).searchParams.get('page')).toBe('1')
    await expect(tableRows(page, 'quick-replies')).toHaveCount(1)
    await expect(page.getByTestId(`quick-replies-item-shortcut-${promo.id}`)).toHaveText(`/promo${tag}`)
    await expect(page.getByTestId(`quick-replies-item-count-${promo.id}`)).toHaveText('1')
    await expect(page.getByTestId('quick-replies-next')).toHaveCount(0)

    // busca também pelo texto da mensagem
    await page.getByTestId('quick-replies-search').fill('Cupom de desconto')
    await expect(page.getByTestId(`quick-replies-item-${promo.id}`)).toBeVisible()
    await page.getByTestId('quick-replies-search').fill(`nada${tag}`)
    await expect(page.getByTestId('quick-replies-empty')).toBeVisible()
  })

  test('AC-T58-01 editor com mensagem, mídia enviada, figurinha e contato; reordenar e salvar na nova ordem', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const stickerId = await sticker(page, `fig${tag}`)
    await openTab(page, 'quick_replies', 'page-quick-replies')
    await page.getByTestId('quick-replies-new').click()
    await expect(page.getByTestId('quick-replies-editor')).toBeVisible()
    await expect(page.getByTestId('quick-replies-actions-empty')).toBeVisible()
    await page.getByTestId('quick-replies-shortcut').fill(`boas ${tag}`)

    await page.getByTestId('quick-replies-add-send_message').click()
    await page.getByTestId('quick-replies-action-text-0').fill('Olá, tudo bem?')

    await page.getByTestId('quick-replies-add-send_multi_media').click()
    const upload = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/media')
    await page.getByTestId('quick-replies-action-file-1').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: PNG })
    const media = (await (await upload).json()).media
    await expect(page.getByTestId('quick-replies-action-file-name-1')).toHaveText('foto.png')
    await expect(page.getByTestId('quick-replies-action-media-type-1')).toHaveValue('image')
    await page.getByTestId('quick-replies-action-caption-1').fill('Nosso catálogo')

    await page.getByTestId('quick-replies-add-send_sticker').click()
    await page.getByTestId(`quick-replies-action-sticker-2-${stickerId}`).click()
    await expect(page.getByTestId(`quick-replies-action-sticker-2-${stickerId}`)).toHaveAttribute('aria-checked', 'true')

    await page.getByTestId('quick-replies-add-send_contact').click()
    await page.getByTestId('quick-replies-action-contact-name-3').fill('Suporte')
    await page.getByTestId('quick-replies-action-contact-phone-3').fill('+5511988887777')

    const types = () => page.locator('[data-testid^="quick-replies-action-"][data-type]').evaluateAll((els) => els.map((e) => e.getAttribute('data-type')))
    expect(await types()).toEqual(['send_message', 'send_multi_media', 'send_sticker', 'send_contact'])
    await expect(page.getByTestId('quick-replies-action-up-0')).toBeDisabled()
    await expect(page.getByTestId('quick-replies-action-down-3')).toBeDisabled()

    // reordena: mensagem desce para 2º; contato sobe para 3º
    await page.getByTestId('quick-replies-action-down-0').click()
    await page.getByTestId('quick-replies-action-up-3').click()
    await expect.poll(types).toEqual(['send_multi_media', 'send_message', 'send_contact', 'send_sticker'])
    // os valores acompanham a ação movida
    await expect(page.getByTestId('quick-replies-action-text-1')).toHaveValue('Olá, tudo bem?')
    await expect(page.getByTestId('quick-replies-action-caption-0')).toHaveValue('Nosso catálogo')

    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/quick-replies')
    await page.getByTestId('quick-replies-save').click()
    const body = JSON.parse((await post).postData() ?? '{}')
    expect(body.shortcut).toBe(`boas ${tag}`)
    expect(body.actions.map((a: any) => a.type)).toEqual(['send_multi_media', 'send_message', 'send_contact', 'send_sticker'])
    expect(body.actions.map((a: any) => a.order)).toEqual([0, 1, 2, 3].map((n) => body.actions[0].order + n))
    expect(body.actions[0].config).toMatchObject({ media_id: media.id, media_type: 'image', caption: 'Nosso catálogo' })
    expect(body.actions[3].config).toMatchObject({ sticker_id: stickerId })
    await expect(page.getByTestId('quick-replies-editor')).toHaveCount(0)

    const list = await api(page, 'get', `/api/quick-replies?page=1&limit=20&search=${encodeURIComponent(`boas ${tag}`)}`)
    const saved = list.items[0]
    expect(saved.actions.sort((a: any, b: any) => a.order - b.order).map((a: any) => a.type)).toEqual([
      'send_multi_media',
      'send_message',
      'send_contact',
      'send_sticker',
    ])
    await expect(page.getByTestId(`quick-replies-item-count-${saved.id}`)).toHaveText('4')

    // reabrir mostra a ordem salva e a mídia anexada
    await page.getByTestId(`quick-replies-item-edit-${saved.id}`).click()
    expect(await types()).toEqual(['send_multi_media', 'send_message', 'send_contact', 'send_sticker'])
    await expect(page.getByTestId('quick-replies-action-file-name-0')).not.toBeEmpty()
    await page.getByTestId('quick-replies-action-remove-2').click()
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/quick-replies/${saved.id}`))
    await page.getByTestId('quick-replies-save').click()
    expect(JSON.parse((await patch).postData() ?? '{}').actions.map((a: any) => a.type)).toEqual(['send_multi_media', 'send_message', 'send_sticker'])
    await expect(page.getByTestId(`quick-replies-item-count-${saved.id}`)).toHaveText('3')
  })

  test('AC-T58-01 reordenar arrastando pela alça (ponteiro, @dnd-kit)', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'quick_replies', 'page-quick-replies')
    await page.getByTestId('quick-replies-new').click()
    await page.getByTestId('quick-replies-add-send_message').click()
    await page.getByTestId('quick-replies-action-text-0').fill('primeira')
    await page.getByTestId('quick-replies-add-send_contact').click()
    const types = () => page.locator('[data-testid^="quick-replies-action-"][data-type]').evaluateAll((els) => els.map((e) => e.getAttribute('data-type')))
    expect(await types()).toEqual(['send_message', 'send_contact'])

    const handle = page.getByTestId('quick-replies-action-handle-0')
    const target = page.getByTestId('quick-replies-action-1')
    const a = (await handle.boundingBox())!
    const b = (await target.boundingBox())!
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 10, { steps: 4 })
    await page.mouse.move(a.x + a.width / 2, b.y + b.height - 4, { steps: 12 })
    await page.mouse.up()
    await expect.poll(types).toEqual(['send_contact', 'send_message'])
    await expect(page.getByTestId('quick-replies-action-text-1')).toHaveValue('primeira')
  })

  test('AC-T58-01 atalho duplicado mostra o erro do servidor no campo', async ({ page }) => {
    await loginAs(page, 'owner')
    const shortcut = `dup${uniq()}`
    await quickReply(page, shortcut)
    await openTab(page, 'quick_replies', 'page-quick-replies')
    await page.getByTestId('quick-replies-new').click()
    await page.getByTestId('quick-replies-shortcut').fill(shortcut.toUpperCase())
    await expect(page.getByTestId('quick-replies-shortcut')).toHaveValue(shortcut)
    await page.getByTestId('quick-replies-add-send_message').click()
    await page.getByTestId('quick-replies-action-text-0').fill('outra')
    const res = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/quick-replies')
    await page.getByTestId('quick-replies-save').click()
    const r = await res
    expect(r.status()).toBe(409)
    const err = (await r.json()).error ?? (await r.json())
    const msg = err.details?.fields?.find((f: any) => f.path === 'shortcut')?.message ?? err.message
    expect(err.details?.error_code).toBe('shortcut_taken')
    await expect(page.getByTestId('quick-replies-shortcut-error')).toHaveText(msg)
    await expect(page.getByTestId('quick-replies-editor')).toBeVisible()
    // corrigir o atalho limpa o erro e salva
    await page.getByTestId('quick-replies-shortcut').fill(`${shortcut}b`)
    await expect(page.getByTestId('quick-replies-shortcut-error')).toHaveCount(0)
    await page.getByTestId('quick-replies-save').click()
    await expect(page.getByTestId('quick-replies-editor')).toHaveCount(0)
  })

  test('AC-T58-01 excluir com confirmação', async ({ page }) => {
    await loginAs(page, 'owner')
    const qr = await quickReply(page, `del${uniq()}`)
    await openTab(page, 'quick_replies', 'page-quick-replies')
    await page.getByTestId('quick-replies-search').fill(qr.shortcut)
    await page.getByTestId(`quick-replies-item-delete-${qr.id}`).click()
    await expect(page.getByTestId('quick-replies-confirm')).toBeVisible()
    await page.getByTestId('quick-replies-confirm-cancel').click()
    await expect(page.getByTestId(`quick-replies-item-${qr.id}`)).toBeVisible()
    await page.getByTestId(`quick-replies-item-delete-${qr.id}`).click()
    await page.getByTestId('quick-replies-confirm-ok').click()
    await expect(page.getByTestId(`quick-replies-item-${qr.id}`)).toHaveCount(0)
    expect((await page.request.get(`/api/quick-replies/${qr.id}`)).status()).toBe(404)
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('T58 — modelos de mensagem', () => {
  test('AC-T58-02 prévia em balão de chat com variáveis do contato de exemplo e globais; salvar', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const c = await contact(page, `Mariana${tag} Souza`)
    const g = (await api(page, 'post', '/api/global-variables', { name: `loja${tag}`, type: 'text', value: 'Loja Centro' })).global_variable
    await openTab(page, 'message_templates', 'page-templates')
    await page.getByTestId('templates-new').click()
    await expect(page.getByTestId('templates-editor')).toBeVisible()
    await page.getByTestId('templates-name').fill(`Boas-vindas ${tag}`)
    await page.getByTestId('templates-body').fill('Oi ')
    await page.getByTestId('templates-var-first_name').click()
    await page.getByTestId('templates-body').press('End')
    await page.getByTestId('templates-body').pressSequentially(', bem-vinda à ')
    await page.getByTestId(`templates-var-${g.name}`).click()
    await expect(page.getByTestId('templates-body')).toHaveValue(`Oi {first_name}, bem-vinda à {${g.name}}`)
    await page.getByTestId('templates-footer').fill('Responda SAIR para parar')
    await page.getByTestId('templates-add-button').click()
    await page.getByTestId('templates-button-text-0').fill('Quero saber mais')
    await page.getByTestId('templates-add-button').click()
    await page.getByTestId('templates-button-type-1').selectOption('url')
    await page.getByTestId('templates-button-text-1').fill('Site')
    await page.getByTestId('templates-button-url-1').fill('https://exemplo.test')

    // prévia renderizada pelo servidor dentro do balão
    const preview = page.getByTestId('templates-preview')
    const text = page.getByTestId('templates-preview-text')
    await expect(preview).toBeVisible()
    await expect(text).toContainText('Loja Centro')
    await expect(text).toContainText('1 - Quero saber mais')
    await expect(text).toContainText('Site: https://exemplo.test')
    await expect(text).toContainText('Responda SAIR para parar')

    // contato de exemplo: busca e escolha → variáveis do contato
    await page.getByTestId('templates-preview-contact-search').fill(`Mariana${tag}`)
    await expect(page.getByTestId('templates-preview-contact').locator(`option[value="${c.id}"]`)).toHaveCount(1)
    const render = page.waitForRequest(
      (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/content/render' && JSON.parse(r.postData() ?? '{}').contact_id === c.id,
    )
    await page.getByTestId('templates-preview-contact').selectOption(c.id)
    await render
    await expect(text).toContainText(`Oi Mariana${tag}, bem-vinda à Loja Centro`)

    // cabeçalho de mídia aparece no balão
    await page.getByTestId('templates-header-type').selectOption('image')
    await expect(page.getByTestId('templates-preview-media')).toBeVisible()
    const up = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/media')
    await page.getByTestId('templates-header-file').setInputFiles({ name: 'capa.png', mimeType: 'image/png', buffer: PNG })
    expect((await up).status()).toBe(201)

    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/message-templates')
    await page.getByTestId('templates-save').click()
    const res = await post
    expect(res.status(), await res.text()).toBe(201)
    const tpl = (await res.json()).template
    expect(tpl.body).toBe(`Oi {first_name}, bem-vinda à {${g.name}}`)
    expect(tpl.header.type).toBe('image')
    expect(tpl.header.media_id).toBeTruthy()
    expect(tpl.buttons).toHaveLength(2)
    await expect(page.getByTestId('templates-editor')).toHaveCount(0)
    await expect(page.getByTestId(`templates-item-name-${tpl.id}`)).toHaveText(`Boas-vindas ${tag}`)
  })

  test('AC-T58-02 validação no cliente: nome e corpo obrigatórios', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'message_templates', 'page-templates')
    await page.getByTestId('templates-new').click()
    const calls: Request[] = []
    page.on('request', (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/message-templates' && calls.push(r))
    await page.getByTestId('templates-save').click()
    await expect(page.getByTestId('templates-name-error')).toBeVisible()
    await page.getByTestId('templates-name').fill('Sem corpo')
    await page.getByTestId('templates-save').click()
    await expect(page.getByTestId('templates-body-error')).toBeVisible()
    expect(calls).toHaveLength(0)
  })

  test('AC-T58-02 nenhuma menção a aprovação da Meta na lista nem no editor', async ({ page }) => {
    await loginAs(page, 'owner')
    await api(page, 'post', '/api/message-templates', { name: `Modelo ${uniq()}`, body: 'Olá {full_name}' })
    await openTab(page, 'message_templates', 'page-templates')
    await expect(page.getByTestId('templates-table')).toBeVisible()
    const forbidden = [/\bmeta\b/i, /aprova/i, /\bwaba\b/i, /whatsapp business/i, /approv/i, /pendente/i, /rejeitad/i, /categoria/i]
    const check = async (testid: string) => {
      const text = await page.getByTestId(testid).innerText()
      for (const re of forbidden) expect(text, `texto proibido ${re}`).not.toMatch(re)
    }
    await check('page-templates')
    await page.getByTestId('templates-new').click()
    await expect(page.getByTestId('templates-editor')).toBeVisible()
    await check('templates-editor')
    const headerOpts = await page.getByTestId('templates-header-type').locator('option').allInnerTexts()
    for (const o of headerOpts) for (const re of forbidden) expect(o).not.toMatch(re)
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('T58 — variáveis globais', () => {
  test('AC-T58-03 prefixo g_ fixo: só o sufixo é digitado; nome imutável na edição', async ({ page }) => {
    await loginAs(page, 'owner')
    const suffix = `loja${uniq()}`
    await openTab(page, 'global_variables', 'page-variables')
    await page.getByTestId('variables-new').click()
    await expect(page.getByTestId('variables-prefix')).toHaveText('g_')
    // colar com o prefixo não duplica
    await page.getByTestId('variables-name').fill(`g_${suffix}`)
    await expect(page.getByTestId('variables-name')).toHaveValue(suffix)
    await expect(page.getByTestId('variables-prefix')).toHaveText('g_')
    await page.getByTestId('variables-value').fill('Centro')
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/global-variables')
    await page.getByTestId('variables-save').click()
    const res = await post
    expect(res.status(), await res.text()).toBe(201)
    const v = (await res.json()).global_variable
    expect(v.name).toBe(`g_${suffix}`)
    await expect(page.getByTestId(`variables-item-name-${v.id}`)).toHaveText(`g_${suffix}`)
    await expect(page.getByTestId(`variables-item-value-${v.id}`)).toHaveText('Centro')

    await page.getByTestId(`variables-item-edit-${v.id}`).click()
    await expect(page.getByTestId('variables-prefix')).toHaveText('g_')
    await expect(page.getByTestId('variables-name')).toHaveValue(suffix)
    await expect(page.getByTestId('variables-name')).toBeDisabled()
  })

  test('AC-T58-03 tipo número rejeita texto no cliente sem chamar o servidor', async ({ page }) => {
    await loginAs(page, 'owner')
    const suffix = `preco${uniq()}`
    await openTab(page, 'global_variables', 'page-variables')
    await page.getByTestId('variables-new').click()
    await page.getByTestId('variables-name').fill(suffix)
    await page.getByTestId('variables-type').selectOption('number')
    const calls: Request[] = []
    page.on('request', (r) => ['POST', 'PATCH'].includes(r.method()) && new URL(r.url()).pathname.startsWith('/api/global-variables') && calls.push(r))
    for (const bad of ['abc', '1,5', '12a', '1.']) {
      await page.getByTestId('variables-value').fill(bad)
      await expect(page.getByTestId('variables-value-error'), bad).toBeVisible()
      await page.getByTestId('variables-save').click()
      await expect(page.getByTestId('variables-editor')).toBeVisible()
    }
    expect(calls, 'nenhuma ida ao servidor com valor inválido').toHaveLength(0)

    await page.getByTestId('variables-value').fill('-12.5')
    await expect(page.getByTestId('variables-value-error')).toHaveCount(0)
    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/global-variables')
    await page.getByTestId('variables-save').click()
    expect(JSON.parse((await post).postData() ?? '{}')).toMatchObject({ name: `g_${suffix}`, type: 'number', value: '-12.5' })
    await expect(page.getByTestId('variables-editor')).toHaveCount(0)

    // texto continua aceito no tipo texto
    await page.getByTestId('variables-new').click()
    await page.getByTestId('variables-type').selectOption('number')
    await page.getByTestId('variables-value').fill('abc')
    await expect(page.getByTestId('variables-value-error')).toBeVisible()
    await page.getByTestId('variables-type').selectOption('text')
    await expect(page.getByTestId('variables-value-error')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('T58 — campos e etiquetas', () => {
  test('AC-T58-04 abas Customizados e Sistema; criar campo customizado', async ({ page }) => {
    await loginAs(page, 'owner')
    const key = `cf_${uniq()}`
    await openTab(page, 'custom_fields', 'page-fields')
    await expect(page.getByTestId('fields-tab-custom')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('fields-tab-system')).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByTestId('fields-item-full_name')).toHaveCount(0)

    await page.getByTestId('fields-new').click()
    await page.getByTestId('fields-key').fill(key.toUpperCase())
    await page.getByTestId('fields-description').fill('Código do cliente')
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/custom-fields')
    await page.getByTestId('fields-save').click()
    expect((await post).status()).toBe(201)
    await expect(page.getByTestId(`fields-item-${key}`)).toBeVisible()
    await expect(page.getByTestId(`fields-item-description-${key}`)).toHaveText('Código do cliente')
    await expect(page.getByTestId(`fields-item-readonly-${key}`)).toHaveCount(0)
    // chave imutável na edição, sem excluir
    await page.getByTestId(`fields-item-edit-${key}`).click()
    await expect(page.getByTestId('fields-key')).toBeDisabled()
    await expect(page.getByTestId('fields-system-note')).toHaveCount(0)
    await page.getByTestId('fields-cancel').click()
    await expect(page.locator('[data-testid^="fields-item-delete-"]')).toHaveCount(0)

    // chave duplicada → erro do servidor no campo
    await page.getByTestId('fields-new').click()
    await page.getByTestId('fields-key').fill(key)
    const dup = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/custom-fields')
    await page.getByTestId('fields-save').click()
    expect((await dup).status()).toBe(409)
    await expect(page.getByTestId('fields-editor')).toBeVisible()
    await expect(page.getByTestId('fields-key-error').or(page.getByTestId('fields-error'))).toBeVisible()
    await page.getByTestId('fields-cancel').click()

    await page.getByTestId('fields-tab-system').click()
    await expect(page.getByTestId('fields-tab-system')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('fields-new')).toHaveCount(0)
    await expect(page.getByTestId(`fields-item-${key}`)).toHaveCount(0)
    const system = (await api(page, 'get', '/api/custom-fields')).items.filter((f: any) => f.system)
    expect(system.length).toBe(8)
    for (const f of system) {
      await expect(page.getByTestId(`fields-item-${f.key}`)).toBeVisible()
      await expect(page.getByTestId(`fields-item-readonly-${f.key}`)).toBeVisible()
    }
    await expect(page.locator('[data-testid^="fields-item-delete-"]')).toHaveCount(0)
  })

  test('AC-T58-04 campo de sistema: valor só leitura e descrição editável', async ({ page }) => {
    await loginAs(page, 'owner')
    const desc = `Nome do cliente ${uniq()}`
    await openTab(page, 'custom_fields', 'page-fields')
    await page.getByTestId('fields-tab-system').click()
    await page.getByTestId('fields-item-edit-first_name').click()
    await expect(page.getByTestId('fields-editor')).toBeVisible()
    await expect(page.getByTestId('fields-key')).toBeDisabled()
    await expect(page.getByTestId('fields-key')).toHaveValue('first_name')
    await expect(page.getByTestId('fields-system-note')).toBeVisible()
    await page.getByTestId('fields-description').fill(desc)
    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/custom-fields/first_name')
    await page.getByTestId('fields-save').click()
    const res = await patch
    expect(res.status(), await res.text()).toBeLessThan(300)
    await expect(page.getByTestId('fields-editor')).toHaveCount(0)
    await expect(page.getByTestId('fields-item-description-first_name')).toHaveText(desc)
    await expect(page.getByTestId('fields-item-readonly-first_name')).toBeVisible()
    const f = (await api(page, 'get', '/api/custom-fields')).items.find((x: any) => x.key === 'first_name')
    expect(f).toMatchObject({ system: true, description: desc })

    // chave com ponto (response.type) é codificada na URL
    await page.getByTestId('fields-item-edit-response.type').click()
    await page.getByTestId('fields-description').fill(`${desc} mime`)
    const patch2 = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/custom-fields/'))
    await page.getByTestId('fields-save').click()
    expect((await patch2).status()).toBeLessThan(300)
    await expect(page.getByTestId('fields-item-description-response.type')).toHaveText(`${desc} mime`)
  })

  test('AC-T58-04 etiquetas com cor e contagem de contatos; criar com cor da paleta', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const label = (await api(page, 'post', '/api/labels', { name: `VIP ${tag}`, color: '#EF4444' })).label
    await contact(page, `Ana ${tag}`, { label_ids: [label.id] })
    await contact(page, `Bia ${tag}`, { label_ids: [label.id] })
    await openTab(page, 'tags', 'page-labels')
    await expect(page.getByTestId(`labels-item-name-${label.id}`)).toHaveText(`VIP ${tag}`)
    await expect(page.getByTestId(`labels-item-color-${label.id}`)).toHaveAttribute('data-color', '#EF4444')
    await expect(page.getByTestId(`labels-item-count-${label.id}`)).toHaveText('2')

    await page.getByTestId('labels-new').click()
    await page.getByTestId('labels-name').fill(`Novo ${tag}`)
    await page.getByTestId('labels-preset-F97316').click()
    await expect(page.getByTestId('labels-color-hex')).toHaveValue('#F97316')
    await expect(page.getByTestId('labels-preview')).toHaveText(`Novo ${tag}`)
    await expect(page.getByTestId('labels-preview')).toHaveCSS('background-color', 'rgb(249, 115, 22)')
    // cor inválida é barrada no cliente
    await page.getByTestId('labels-color-hex').fill('#12')
    await page.getByTestId('labels-save').click()
    await expect(page.getByTestId('labels-color-error')).toBeVisible()
    await page.getByTestId('labels-color-hex').fill('#3b82f6')
    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/labels')
    await page.getByTestId('labels-save').click()
    const sent = JSON.parse((await post).postData() ?? '{}')
    expect(sent).toEqual({ name: `Novo ${tag}`, color: '#3B82F6' })
    const created = (await api(page, 'get', '/api/labels')).items.find((l: any) => l.name === `Novo ${tag}`)
    await expect(page.getByTestId(`labels-item-color-${created.id}`)).toHaveAttribute('data-color', '#3B82F6')
    await expect(page.getByTestId(`labels-item-count-${created.id}`)).toHaveText('0')

    // busca local
    await page.getByTestId('labels-search').fill(`vip ${tag}`)
    await expect(page.getByTestId(`labels-item-${label.id}`)).toBeVisible()
    await expect(page.getByTestId(`labels-item-${created.id}`)).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('T58 — permissões e layout', () => {
  async function seedAll(page: Page) {
    const tag = uniq()
    const qr = await quickReply(page, `perm${tag}`)
    const tpl = (await api(page, 'post', '/api/message-templates', { name: `Perm ${tag}`, body: 'Olá' })).template
    const v = (await api(page, 'post', '/api/global-variables', { name: `perm${tag}`, type: 'text', value: 'x' })).global_variable
    const key = `perm_${tag}`
    await api(page, 'post', '/api/custom-fields', { key, description: 'perm' })
    const label = (await api(page, 'post', '/api/labels', { name: `Perm ${tag}`, color: '#22C55E' })).label
    return { qr, tpl, v, key, label }
  }

  test('AC-T58-05 member vê modelos, campos e etiquetas sem criar/editar/excluir', async ({ page }) => {
    await loginAs(page, 'owner')
    const s = await seedAll(page)
    await loginAs(page, 'member')

    await openTab(page, 'message_templates', 'page-templates')
    await expect(page.getByTestId(`templates-item-${s.tpl.id}`)).toBeVisible()
    await expect(page.getByTestId('templates-new')).toHaveCount(0)
    await expect(page.locator('[data-testid^="templates-item-edit-"], [data-testid^="templates-item-delete-"]')).toHaveCount(0)

    await openTab(page, 'custom_fields', 'page-fields')
    await expect(page.getByTestId(`fields-item-${s.key}`)).toBeVisible()
    await expect(page.getByTestId('fields-new')).toHaveCount(0)
    await expect(page.locator('[data-testid^="fields-item-edit-"], [data-testid^="fields-item-delete-"]')).toHaveCount(0)
    await page.getByTestId('fields-tab-system').click()
    await expect(page.getByTestId('fields-item-full_name')).toBeVisible()
    await expect(page.locator('[data-testid^="fields-item-edit-"]')).toHaveCount(0)

    await openTab(page, 'tags', 'page-labels')
    await expect(page.getByTestId(`labels-item-${s.label.id}`)).toBeVisible()
    await expect(page.getByTestId('labels-new')).toHaveCount(0)
    await expect(page.locator('[data-testid^="labels-item-edit-"], [data-testid^="labels-item-delete-"]')).toHaveCount(0)

    // matriz atual: member edita respostas rápidas (sem excluir) e tudo em variáveis globais
    await openTab(page, 'quick_replies', 'page-quick-replies')
    await expect(page.getByTestId(`quick-replies-item-${s.qr.id}`)).toBeVisible()
    await expect(page.getByTestId('quick-replies-new')).toBeVisible()
    await expect(page.getByTestId(`quick-replies-item-edit-${s.qr.id}`)).toBeVisible()
    await expect(page.getByTestId(`quick-replies-item-delete-${s.qr.id}`)).toHaveCount(0)
    await openTab(page, 'global_variables', 'page-variables')
    await expect(page.getByTestId('variables-new')).toBeVisible()
    await expect(page.getByTestId(`variables-item-edit-${s.v.id}`)).toBeVisible()
    await expect(page.getByTestId(`variables-item-delete-${s.v.id}`)).toBeVisible()
  })

  test('AC-T58-05 layout mobile em cartões (tabela no desktop) nas cinco abas, sem rolagem horizontal', async ({ page }) => {
    await loginAs(page, 'owner')
    const s = await seedAll(page)
    const tabs = [
      { tab: 'quick_replies', p: 'quick-replies', page: 'page-quick-replies', id: s.qr.id },
      { tab: 'message_templates', p: 'templates', page: 'page-templates', id: s.tpl.id },
      { tab: 'global_variables', p: 'variables', page: 'page-variables', id: s.v.id },
      { tab: 'custom_fields', p: 'fields', page: 'page-fields', id: s.key },
      { tab: 'tags', p: 'labels', page: 'page-labels', id: s.label.id },
    ]
    for (const t of tabs) {
      await openTab(page, t.tab, t.page)
      const item = page.getByTestId(`${t.p}-item-${t.id}`)
      await expect(item).toBeVisible()
      if (isMobile(page)) {
        await expect(page.getByTestId(`${t.p}-cards`), t.tab).toBeVisible()
        await expect(page.getByTestId(`${t.p}-table`)).toHaveCount(0)
        await expect(page.getByTestId(`${t.p}-cards`).getByTestId(`${t.p}-item-${t.id}`)).toBeVisible()
        await expect(page.getByTestId(`${t.p}-item-edit-${t.id}`)).toBeVisible()
        await expectNoHorizontalScroll(page)
      } else {
        await expect(page.getByTestId(`${t.p}-table`), t.tab).toBeVisible()
        await expect(page.getByTestId(`${t.p}-cards`)).toHaveCount(0)
      }
    }
  })

  test('AC-T58-05 member no mobile: cartões sem botões de edição', async ({ page }) => {
    await loginAs(page, 'owner')
    const s = await seedAll(page)
    await loginAs(page, 'member')
    await openTab(page, 'tags', 'page-labels')
    await expect(page.getByTestId(`labels-item-${s.label.id}`)).toBeVisible()
    await expect(page.getByTestId(isMobile(page) ? 'labels-cards' : 'labels-table')).toBeVisible()
    await expect(page.locator('[data-testid^="labels-item-edit-"], [data-testid^="labels-item-delete-"], [data-testid="labels-new"]')).toHaveCount(0)
    await openTab(page, 'message_templates', 'page-templates')
    await expect(page.getByTestId(isMobile(page) ? 'templates-cards' : 'templates-table')).toBeVisible()
    await expect(page.locator('[data-testid^="templates-item-edit-"], [data-testid="templates-new"]')).toHaveCount(0)
    if (isMobile(page)) await expectNoHorizontalScroll(page)
  })
})
