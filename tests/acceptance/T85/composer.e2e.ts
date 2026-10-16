// AC-T85-01..05 — compositor do chat: formatação/Enter/otimista, anexos/figurinhas/emojis/Pix, áudio PTT,
// respostas rápidas e assinatura, conexão desconectada e reenvio. Contrato de data-testid combinado com o Torno.
import { expect, test, type Page, type Request } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { createConnection, emit, messagesOf, newChat, trackSse, waitSseOpen, XRW } from '../helpers/chats-e2e'

// microfone falso do Chromium (AC-T85-03); inofensivo para os demais testes do arquivo
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } })

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const input = (page: Page) => page.getByTestId('chat-composer-input')
const isMessagePost = (chatId: string) => (r: Request) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/chats/${chatId}/messages`
const bodyOf = (r: Request) => JSON.parse(r.postData() ?? '{}')

async function setup(page: Page) {
  const login = await loginAs(page, 'owner')
  const conn = await createConnection(page)
  const chat = await newChat(page, conn.session_id)
  await trackSse(page)
  await page.goto(`/chats/${chat.id}`)
  await expect(page.getByTestId('chat-composer')).toBeVisible()
  await waitSseOpen(page)
  return { userName: login.user.name as string, userId: login.user.id as string, conn, chat }
}

/** Arquivo em memória com cabeçalho real do tipo. */
function file(kind: 'png' | 'exe' | 'webp', size: number, name?: string) {
  const buf = Buffer.alloc(size, 0x20)
  if (kind === 'png') Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
  if (kind === 'exe') Buffer.from([0x4d, 0x5a, 0x90, 0x00]).copy(buf)
  if (kind === 'webp') {
    Buffer.from('RIFF').copy(buf, 0)
    buf.writeUInt32LE(size - 8, 4)
    Buffer.from('WEBPVP8 ').copy(buf, 8)
  }
  const mimeType = { png: 'image/png', exe: 'application/x-msdownload', webp: 'image/webp' }[kind]
  return { name: name ?? `arquivo.${kind}`, mimeType, buffer: buf }
}

test.describe('T85 — texto', () => {
  test('AC-T85-01 formatação do WhatsApp: prévia no compositor e renderização na thread', async ({ page }) => {
    const { chat } = await setup(page)
    await input(page).fill('Oferta *imperdível* hoje _só hoje_ ~preço antigo~')
    const preview = page.getByTestId('chat-composer-preview')
    await expect(preview).toBeVisible()
    await expect(preview.locator('.font-semibold', { hasText: 'imperdível' })).toHaveCount(1)
    await expect(preview.locator('.italic', { hasText: 'só hoje' })).toHaveCount(1)
    await expect(preview.locator('.line-through', { hasText: 'preço antigo' })).toHaveCount(1)

    const post = page.waitForRequest(isMessagePost(chat.id))
    await page.getByTestId('chat-composer-send').click()
    expect(bodyOf(await post).text).toBe('Oferta *imperdível* hoje _só hoje_ ~preço antigo~')
    const last = page.locator('[data-testid^="chat-message-"][data-direction="outbound"]').last()
    await expect(last.locator('.font-semibold', { hasText: 'imperdível' })).toHaveCount(1)
    await expect(last.locator('.line-through', { hasText: 'preço antigo' })).toHaveCount(1)
  })

  test('AC-T85-01 botão de negrito envolve a seleção com *', async ({ page }) => {
    await setup(page)
    await input(page).fill('palavra importante')
    await input(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 18))
    await page.getByTestId('chat-composer-format-bold').click()
    await expect(input(page)).toHaveValue('palavra *importante*')
  })

  test('AC-T85-01 Enter envia; Shift+Enter quebra linha', async ({ page }) => {
    const { chat } = await setup(page)
    const posts: Request[] = []
    page.on('request', (r) => isMessagePost(chat.id)(r) && posts.push(r))
    await input(page).click()
    await page.keyboard.type('linha 1')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('linha 2')
    await page.waitForTimeout(300)
    expect(posts).toHaveLength(0)
    await expect(input(page)).toHaveValue('linha 1\nlinha 2')
    const post = page.waitForRequest(isMessagePost(chat.id))
    await page.keyboard.press('Enter')
    expect(bodyOf(await post).text).toBe('linha 1\nlinha 2')
    await expect(input(page)).toHaveValue('')
  })

  test('AC-T85-01 envio otimista aparece na hora e é confirmado pelo SSE', async ({ page }) => {
    const { conn, chat } = await setup(page)
    // segura a resposta do POST para provar que a mensagem aparece antes dela
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    await page.route(`**/api/chats/${chat.id}/messages`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      await gate
      await route.continue()
    })
    await input(page).fill('mensagem otimista')
    const response = page.waitForResponse((r) => isMessagePost(chat.id)(r.request()))
    await page.keyboard.press('Enter')
    const tmp = page.locator('[data-testid^="chat-message-tmp-"]', { hasText: 'mensagem otimista' })
    await expect(tmp).toBeVisible({ timeout: 3_000 })
    await expect(tmp).toHaveAttribute('data-direction', 'outbound')
    await expect(tmp).toHaveAttribute('data-status', 'queued')
    release()
    const { message } = await (await response).json()
    const real = page.getByTestId(`chat-message-${message.id}`)
    await expect(real).toBeVisible()
    await expect(page.locator('[data-testid^="chat-message-tmp-"]')).toHaveCount(0)
    await emit(page, { type: 'message.status', session_id: conn.session_id, message_id: message.pipeline_message_id, status: 'delivered' })
    await expect(real).toHaveAttribute('data-status', 'delivered', { timeout: 15_000 })
  })
})

test.describe('T85 — anexos, figurinhas, emojis e Pix', () => {
  test('AC-T85-02 anexo acima do limite ou de tipo não aceito é bloqueado no cliente (sem upload)', async ({ page }) => {
    await setup(page)
    const uploads: Request[] = []
    page.on('request', (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/media' && uploads.push(r))
    await page.getByTestId('chat-composer-file').setInputFiles(file('png', 20 * 1024 * 1024 + 1024, 'grande.png'))
    await expect(page.getByTestId('chat-composer-error')).toBeVisible()
    await expect(page.getByTestId('chat-composer-attachment')).toHaveCount(0)
    await page.getByTestId('chat-composer-file').setInputFiles(file('exe', 4096, 'programa.exe'))
    await expect(page.getByTestId('chat-composer-error')).toBeVisible()
    await expect(page.getByTestId('chat-composer-attachment')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(uploads).toHaveLength(0)
  })

  test('AC-T85-02 anexo válido envia mídia com o texto como legenda', async ({ page }) => {
    const { chat } = await setup(page)
    await page.getByTestId('chat-composer-file').setInputFiles(file('png', 8 * 1024, 'foto.png'))
    await expect(page.getByTestId('chat-composer-attachment')).toBeVisible()
    await input(page).fill('veja a foto')
    const upload = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/media')
    const post = page.waitForRequest(isMessagePost(chat.id))
    await page.getByTestId('chat-composer-send').click()
    await upload
    const body = bodyOf(await post)
    expect(body).toMatchObject({ type: 'image', caption: 'veja a foto' })
    expect(body.media_id).toBeTruthy()
    await expect(page.getByTestId('chat-composer-attachment')).toHaveCount(0)
  })

  test('AC-T85-02 figurinha e emoji', async ({ page }) => {
    const { chat } = await setup(page)
    const st = await page.request.post('/api/stickers', { multipart: { file: file('webp', 2048, 'fig.webp') }, headers: XRW })
    expect(st.status(), await st.text()).toBeLessThan(300)
    const sticker = (await st.json()).sticker
    await page.reload()
    await expect(page.getByTestId('chat-composer')).toBeVisible()

    await page.getByTestId('chat-composer-sticker').click()
    await expect(page.getByTestId('chat-composer-sticker-picker')).toBeVisible()
    const post = page.waitForRequest(isMessagePost(chat.id))
    await page.getByTestId(`chat-composer-sticker-${sticker.id}`).click()
    const body = bodyOf(await post)
    expect(body.type).toBe('sticker')
    expect(body.media_id).toBeTruthy()

    await input(page).fill('oi ')
    await page.getByTestId('chat-composer-emoji').click()
    const option = page.getByTestId('chat-composer-emoji-option').first()
    const emoji = (await option.getAttribute('data-emoji'))!
    await option.click()
    await expect(input(page)).toHaveValue(`oi ${emoji}`)
  })

  test('AC-T85-02 Pix vai como texto com a chave copiável', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const { chat } = await setup(page)
    await page.getByTestId('chat-composer-pix').click()
    await expect(page.getByTestId('chat-composer-pix-modal')).toBeVisible()
    await page.getByTestId('chat-composer-pix-key').fill('pix@lojaexemplo.test')
    await page.getByTestId('chat-composer-pix-name').fill('Loja Exemplo')
    await page.getByTestId('chat-composer-pix-amount').fill('12,50')
    await expect(page.getByTestId('chat-composer-pix-preview')).toContainText('pix@lojaexemplo.test')
    await page.getByTestId('chat-composer-pix-copy').click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('pix@lojaexemplo.test')

    const post = page.waitForRequest(isMessagePost(chat.id))
    await page.getByTestId('chat-composer-pix-submit').click()
    const body = bodyOf(await post)
    expect(body).toMatchObject({ type: 'pix', pix: { key: 'pix@lojaexemplo.test', name: 'Loja Exemplo', amount_cents: 1250 } })
    // vai como texto, com a chave numa linha própria
    await expect.poll(async () => (await messagesOf(page, chat.id)).filter((m) => m.direction === 'outbound').at(-1)?.body ?? '').toMatch(/(^|\n)[^\n]*pix@lojaexemplo\.test[^\n]*(\n|$)/)
  })
})

test.describe('T85 — áudio', () => {
  test.use({ permissions: ['microphone'] })

  test('AC-T85-03 gravar áudio envia como PTT e silencia notificações durante a gravação', async ({ page }) => {
    const { chat } = await setup(page)
    const muted = () => page.evaluate(() => document.body.getAttribute('data-notifications-muted'))
    expect(await muted()).not.toBe('true')
    await page.getByTestId('chat-composer-record').click()
    await expect(page.getByTestId('chat-composer-recording')).toBeVisible()
    expect(await muted()).toBe('true')
    await page.waitForTimeout(1500)
    const upload = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/media')
    const post = page.waitForRequest(isMessagePost(chat.id))
    await page.getByTestId('chat-composer-record-stop').click()
    await upload
    const body = bodyOf(await post)
    expect(body).toMatchObject({ type: 'audio', ptt: true })
    expect(body.media_id).toBeTruthy()
    await expect(page.getByTestId('chat-composer-recording')).toHaveCount(0)
    expect(await muted()).not.toBe('true')
    const res = await page.waitForResponse((r) => isMessagePost(chat.id)(r.request())).catch(() => null)
    if (res) expect(res.status(), await res.text()).toBeLessThan(300)
  })

  test('AC-T85-03 cancelar a gravação não envia e devolve o som das notificações', async ({ page }) => {
    const { chat } = await setup(page)
    const posts: Request[] = []
    page.on('request', (r) => isMessagePost(chat.id)(r) && posts.push(r))
    await page.getByTestId('chat-composer-record').click()
    await expect(page.getByTestId('chat-composer-recording')).toBeVisible()
    await page.getByTestId('chat-composer-record-cancel').click()
    await expect(page.getByTestId('chat-composer-recording')).toHaveCount(0)
    expect(await page.evaluate(() => document.body.getAttribute('data-notifications-muted'))).not.toBe('true')
    await page.waitForTimeout(500)
    expect(posts).toHaveLength(0)
  })
})

test.describe('T85 — respostas rápidas e assinatura', () => {
  test('AC-T85-04 "/" abre as respostas rápidas com busca e insere com variáveis renderizadas', async ({ page }) => {
    const { chat } = await setup(page)
    const gv = await page.request.post('/api/global-variables', { data: { name: 'g_loja', type: 'text', value: 'Loja X' }, headers: XRW })
    expect(gv.status(), await gv.text()).toBeLessThan(300)
    const qr = await page.request.post('/api/quick-replies', {
      data: { shortcut: 'boasvindas', actions: [{ type: 'send_message', config: { message_text: 'Olá {{customer.full_name}}, {saudacao}! {{global.g_loja}}' } }] },
      headers: XRW,
    })
    expect(qr.status(), await qr.text()).toBeLessThan(300)
    const quick = (await qr.json()).quick_reply
    await page.request.post('/api/quick-replies', { data: { shortcut: 'promocao', actions: [{ type: 'send_message', config: { message_text: 'Promo!' } }] }, headers: XRW })
    const contactName = (await (await page.request.get(`/api/chats/${chat.id}`)).json()).chat.contact.name as string
    await page.reload()
    await expect(page.getByTestId('chat-composer')).toBeVisible()

    await input(page).click()
    await page.keyboard.type('/boas')
    const popup = page.getByTestId('chat-composer-quick-replies')
    await expect(popup).toBeVisible()
    await expect(page.getByTestId(`chat-composer-quick-reply-${quick.id}`)).toBeVisible()
    await expect(popup.getByText('promocao')).toHaveCount(0)
    await page.getByTestId(`chat-composer-quick-reply-${quick.id}`).click()
    await expect(popup).toBeHidden()
    const value = await input(page).inputValue()
    expect(value).toContain(contactName)
    expect(value).toContain('Loja X')
    expect(value).toMatch(/bom dia|boa tarde|boa noite/i)
    expect(value).not.toContain('{')
    expect(value).not.toContain('/boas')

    await input(page).fill('')
    await page.keyboard.type('/naoexiste')
    await expect(page.getByTestId('chat-composer-quick-replies-empty')).toBeVisible()
  })

  test('AC-T85-04 assinatura *Nome*: liga/desliga e persiste', async ({ page }) => {
    const { chat, userName } = await setup(page)
    const toggle = page.getByTestId('chat-composer-signature')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    await input(page).fill('com assinatura')
    let post = page.waitForRequest(isMessagePost(chat.id))
    await page.keyboard.press('Enter')
    expect(bodyOf(await post).signature).toBe(true)
    await expect
      .poll(async () => (await messagesOf(page, chat.id)).filter((m) => m.direction === 'outbound').at(-1)?.body ?? '')
      .toMatch(new RegExp(`^\\*${userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*:`))

    await page.reload()
    await expect(page.getByTestId('chat-composer-signature')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('chat-composer-signature').click()
    await expect(page.getByTestId('chat-composer-signature')).toHaveAttribute('aria-pressed', 'false')
    await input(page).fill('sem assinatura')
    post = page.waitForRequest(isMessagePost(chat.id))
    await page.keyboard.press('Enter')
    expect(bodyOf(await post).signature ?? false).toBe(false)
    await page.reload()
    await expect(page.getByTestId('chat-composer-signature')).toHaveAttribute('aria-pressed', 'false')
  })
})

test.describe('T85 — conexão e falhas', () => {
  test('AC-T85-05 conexão desconectada mostra banner e bloqueia o envio', async ({ page }) => {
    const { conn, chat } = await setup(page)
    const dis = await page.request.post(`/api/connections/${conn.id}/disconnect`, { data: {}, headers: XRW })
    expect(dis.status(), await dis.text()).toBeLessThan(300)
    await page.reload()
    await expect(page.getByTestId('chat-composer-disconnected')).toBeVisible({ timeout: 15_000 })
    await expect(input(page)).toBeDisabled()
    // com o campo vazio o compositor mostra o microfone no lugar do enviar: os dois ficam bloqueados
    const send = page.getByTestId('chat-composer-send')
    if (await send.count()) await expect(send).toBeDisabled()
    await expect(page.getByTestId('chat-composer-record')).toBeDisabled()
    const posts: Request[] = []
    page.on('request', (r) => isMessagePost(chat.id)(r) && posts.push(r))
    await input(page).focus().catch(() => {})
    await page.keyboard.press('Enter')
    await page.getByTestId('chat-composer-send').click({ force: true }).catch(() => {})
    await page.waitForTimeout(800)
    expect(posts).toHaveLength(0)
  })

  test('AC-T85-05 falha de envio permite tentar de novo', async ({ page }) => {
    const { chat } = await setup(page)
    let failed = 0
    await page.route(`**/api/chats/${chat.id}/messages`, async (route) => {
      if (route.request().method() === 'POST' && failed === 0) {
        failed++
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'falha simulada' } }) })
      }
      return route.continue()
    })
    await input(page).fill('tentar de novo')
    await page.keyboard.press('Enter')
    // aviso de falha de envio (chat-composer-failure; o contrato citava chat-composer-error)
    const failure = page.getByTestId('chat-composer-failure').or(page.getByTestId('chat-composer-error'))
    await expect(failure.first()).toBeVisible()
    const retry = page.getByTestId('chat-composer-retry')
    await expect(retry).toBeVisible()
    const post = page.waitForResponse((r) => isMessagePost(chat.id)(r.request()) && r.status() < 300)
    await retry.click()
    const res = await post
    expect(bodyOf(res.request()).text).toBe('tentar de novo')
    await expect(page.getByTestId('chat-composer-failure')).toHaveCount(0)
    await expect(page.getByTestId('chat-composer-error')).toHaveCount(0)
    await expect.poll(async () => (await messagesOf(page, chat.id)).filter((m) => m.direction === 'outbound' && m.body === 'tentar de novo').length).toBe(1)
  })
})
