// AC-T75-01..05 — conversa: histórico reverso + lido, tipos de mensagem, ticks/retry, menu por mensagem, SSE e auto-rolagem.
import { expect, test, type Page } from '@playwright/test'
import { isMobile, loginAs, resetSeed } from '../helpers/e2e'
import {
  chatIdOf,
  createConnection,
  emit,
  inbound,
  messageByWaId,
  messagesOf,
  newChat,
  newPhone,
  sendText,
  trackSse,
  markSent,
  uploadPng,
  waitSseOpen,
  XRW,
} from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

async function setup(page: Page) {
  await loginAs(page, 'owner')
  return createConnection(page)
}

const thread = (page: Page) => page.getByTestId('chat-thread')
const msg = (page: Page, id: string) => page.getByTestId(`chat-message-${id}`)
// "no fim" com uma pequena folga (padding do rodapé da thread; o produto considera fim até 80 px)
const atBottom = (page: Page) => thread(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 32)
const renderedMessages = (page: Page) => page.locator('[data-testid^="chat-message-"][data-direction]')

async function openChat(page: Page, chatId: string) {
  await trackSse(page)
  await page.goto(`/chats/${chatId}`)
  await expect(thread(page)).toBeVisible()
  await expect(thread(page)).toHaveAttribute('data-chat-id', chatId)
  await waitSseOpen(page)
}

/** Chat com `n` mensagens recebidas em sequência. */
async function chatWith(page: Page, sessionId: string, n: number) {
  const phone = newPhone()
  for (let i = 1; i <= n; i++) await inbound(page, sessionId, phone, { text: `mensagem ${String(i).padStart(2, '0')}` })
  return { id: await chatIdOf(page, phone), phone }
}

async function openMenu(page: Page, id: string) {
  await msg(page, id).hover().catch(() => {})
  await page.getByTestId(`chat-message-menu-${id}`).click()
}

test.describe('T75 — histórico', () => {
  test('AC-T75-01 rolagem reversa: subir carrega mais 25 mantendo a posição', async ({ page }) => {
    test.setTimeout(240_000)
    const conn = await setup(page)
    const chat = await chatWith(page, conn.session_id, 30)
    await openChat(page, chat.id)
    await expect(renderedMessages(page)).toHaveCount(25)
    await expect.poll(() => atBottom(page)).toBe(true)

    // a mensagem mais antiga carregada vira a âncora
    const anchor = renderedMessages(page).first()
    const anchorId = await anchor.getAttribute('data-testid')
    await thread(page).evaluate((el) => el.scrollTo(0, 0))
    await expect(renderedMessages(page)).toHaveCount(30, { timeout: 20_000 })
    await expect(page.getByTestId('chat-thread-loading-older')).toHaveCount(0)
    const a = page.getByTestId(anchorId!)
    await expect(a).toBeInViewport()
    const topAfter = await a.evaluate((el) => el.getBoundingClientRect().top)
    const threadTop = await thread(page).evaluate((el) => el.getBoundingClientRect().top)
    // a âncora continua perto do topo visível (não saltou para baixo nem sumiu)
    expect(topAfter - threadTop).toBeGreaterThanOrEqual(-5)
    expect(await thread(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await expect(page.getByTestId('chat-message-text-' + anchorId!.replace('chat-message-', ''))).toContainText('mensagem 06')
  })

  test('AC-T75-01 abrir o chat marca como lido', async ({ page }) => {
    const conn = await setup(page)
    const chat = await chatWith(page, conn.session_id, 3)
    expect((await (await page.request.get(`/api/chats/${chat.id}`)).json()).chat.unread_count).toBe(3)
    const read = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/api/chats/${chat.id}/read`))
    await openChat(page, chat.id)
    await read
    await expect.poll(async () => (await (await page.request.get(`/api/chats/${chat.id}`)).json()).chat.unread_count).toBe(0)
    if (!isMobile(page)) await expect(page.getByTestId(`chat-list-item-${chat.id}`)).toHaveAttribute('data-unread', '0')
  })
})

test.describe('T75 — tipos de mensagem', () => {
  test('AC-T75-02 renderiza texto, mídias, figurinha, localização, contato, reação, apagada, visualização única e nota', async ({ page }) => {
    test.setTimeout(180_000)
    const conn = await setup(page)
    const phone = newPhone()
    const media = (id: string, mime: string) => ({ session_id: conn.session_id, message_id: id, mime, size: null, sha256: null, key: null, status: 'pending' })
    const ids: Record<string, string> = {}
    ids.text = await inbound(page, conn.session_id, phone, { text: 'texto simples' })
    for (const [kind, type, mime] of [
      ['image', 'imageMessage', 'image/jpeg'],
      ['video', 'videoMessage', 'video/mp4'],
      ['audio', 'audioMessage', 'audio/ogg; codecs=opus'],
      ['document', 'documentMessage', 'application/pdf'],
      ['sticker', 'stickerMessage', 'image/webp'],
    ] as const) {
      const id = `IN-${kind}-${Date.now().toString(36)}`
      await inbound(page, conn.session_id, phone, { id, type, text: undefined, media: media(id, mime) })
      ids[kind] = id
    }
    ids.location = await inbound(page, conn.session_id, phone, { type: 'locationMessage', text: 'Rua X, 10' })
    ids.contact = await inbound(page, conn.session_id, phone, { type: 'contactMessage', text: 'Fulano' })
    const chatId = await chatIdOf(page, phone)

    const m: Record<string, any> = {}
    for (const [k, wa] of Object.entries(ids)) m[k] = await messageByWaId(page, chatId, wa)
    const viewOnce = (await (await page.request.post(`/api/chats/${chatId}/messages`, { data: { type: 'image', media_id: await uploadPng(page), view_once: true }, headers: XRW })).json()).message
    const toDelete = await sendText(page, chatId, 'vou apagar isto')
    await markSent(page, conn.session_id, chatId, toDelete)
    expect((await page.request.post(`/api/chats/${chatId}/messages/${toDelete.id}/delete`, { data: {}, headers: XRW })).status()).toBeLessThan(300)
    const note = (await (await page.request.post(`/api/chats/${chatId}/notes`, { data: { body: 'nota interna do time' }, headers: XRW })).json()).note

    await openChat(page, chatId)
    await expect(page.getByTestId(`chat-message-text-${m.text.id}`)).toContainText('texto simples')
    await expect(page.getByTestId(`chat-message-image-${m.image.id}`)).toBeAttached()
    const img = page.locator(`[data-testid="chat-message-image-${m.image.id}"]`).locator('xpath=self::img|.//img')
    await expect(img).toHaveCount(1)
    await expect(img).toHaveAttribute('src', new RegExp(`/api/chats/${chatId}/messages/${m.image.id}/media`))
    await expect(page.getByTestId(`chat-message-video-${m.video.id}`).locator('xpath=self::video|.//video')).toHaveCount(1)
    await expect(page.getByTestId(`chat-message-audio-${m.audio.id}`).locator('xpath=self::audio|.//audio')).toHaveCount(1)
    await expect(page.getByTestId(`chat-message-document-${m.document.id}`)).toBeVisible()
    await expect(page.getByTestId(`chat-message-sticker-${m.sticker.id}`)).toBeAttached()
    await expect(page.getByTestId(`chat-message-location-${m.location.id}`)).toContainText('Rua X, 10')
    await expect(page.getByTestId(`chat-message-contact-${m.contact.id}`)).toContainText('Fulano')
    await expect(msg(page, toDelete.id)).toHaveAttribute('data-deleted', 'true')
    await expect(page.getByTestId(`chat-message-deleted-${toDelete.id}`)).toBeVisible()
    await expect(page.getByTestId(`chat-message-text-${toDelete.id}`)).toHaveCount(0)
    await expect(msg(page, viewOnce.id)).toHaveAttribute('data-view-once', 'true')
    await expect(page.getByTestId(`chat-message-view-once-${viewOnce.id}`)).toBeVisible()
    const noteEl = page.getByTestId(`chat-note-${note.id}`)
    await expect(noteEl).toHaveAttribute('data-note', 'true')
    await expect(noteEl).toContainText('nota interna do time')
    // nota com estilo distinto de uma mensagem comum
    // estilo visível do balão: 1º fundo não transparente subindo do texto até o elemento da mensagem/nota
    const bubble = (sel: string, text: string) =>
      page.getByTestId(sel).evaluate((root, t) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let node: Node | null
        let el: Element | null = root
        while ((node = walker.nextNode())) if ((node.textContent ?? '').includes(t)) { el = node.parentElement; break }
        for (let cur: Element | null = el; cur; cur = cur === root ? null : cur.parentElement) {
          const s = getComputedStyle(cur)
          const bg = s.backgroundColor
          if (bg && bg !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(bg)) return `${bg}|${s.borderStyle}|${s.borderColor}`
        }
        return 'sem-fundo'
      }, text)
    const noteStyle = await bubble(`chat-note-${note.id}`, 'nota interna do time')
    const msgStyle = await bubble(`chat-message-${m.text.id}`, 'texto simples')
    expect(noteStyle, 'nota precisa de fundo/borda própria').not.toBe('sem-fundo')
    expect(noteStyle).not.toBe(msgStyle)

    // reação (chega pelo SSE)
    expect((await page.request.post(`/api/chats/${chatId}/messages/${m.text.id}/react`, { data: { emoji: '👍' }, headers: XRW })).status()).toBeLessThan(300)
    await expect(page.getByTestId(`chat-message-reactions-${m.text.id}`)).toContainText('👍')
  })
})

test.describe('T75 — status', () => {
  test('AC-T75-03 ticks mudam ao receber message.status sem recarregar', async ({ page }) => {
    const conn = await setup(page)
    const chat = await newChat(page, conn.session_id)
    const sent = await sendText(page, chat.id, 'acompanhe os ticks')
    await openChat(page, chat.id)
    await page.evaluate(() => ((window as any).__t75NoReload = true))
    const tick = page.getByTestId(`chat-message-status-${sent.id}`)
    await expect(tick).toBeVisible()
    for (const status of ['delivered', 'read'] as const) {
      await emit(page, { type: 'message.status', session_id: conn.session_id, message_id: sent.pipeline_message_id, status })
      await expect(tick).toHaveAttribute('data-status', status, { timeout: 15_000 })
      await expect(msg(page, sent.id)).toHaveAttribute('data-status', status)
    }
    expect(await page.evaluate(() => (window as any).__t75NoReload)).toBe(true)
  })

  test('AC-T75-03 mensagem com falha mostra "Tentar novamente" e reenviar sai da falha', async ({ page }) => {
    const conn = await setup(page)
    const chat = await newChat(page, conn.session_id)
    const sent = await sendText(page, chat.id, 'esta vai falhar')
    await openChat(page, chat.id)
    await emit(page, { type: 'message.status', session_id: conn.session_id, message_id: sent.pipeline_message_id, status: 'failed', error: 'rate limited' })
    const retry = page.getByTestId(`chat-message-retry-${sent.id}`)
    await expect(retry).toBeVisible({ timeout: 15_000 })
    await expect(msg(page, sent.id)).toHaveAttribute('data-status', 'failed')
    const req = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/api/chats/${chat.id}/messages/${sent.id}/retry`))
    await retry.click()
    await req
    // a mesma mensagem é reenviada e sai de 'failed'
    await expect.poll(async () => (await messagesOf(page, chat.id)).find((x) => x.id === sent.id)?.status).not.toBe('failed')
    await expect(msg(page, sent.id)).not.toHaveAttribute('data-status', 'failed', { timeout: 15_000 })
    await expect(retry).toHaveCount(0)
  })
})

test.describe('T75 — menu por mensagem', () => {
  test('AC-T75-04 responder mostra a citação; copiar copia o texto', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const conn = await setup(page)
    const phone = newPhone()
    const wa = await inbound(page, conn.session_id, phone, { text: 'qual o horário de vocês?' })
    const chatId = await chatIdOf(page, phone)
    const m = await messageByWaId(page, chatId, wa)
    await openChat(page, chatId)

    await openMenu(page, m.id)
    await expect(page.getByTestId('chat-message-action-delete')).toHaveCount(0) // inbound não apaga
    await expect(page.getByTestId('chat-message-action-download')).toHaveCount(0) // texto não baixa
    await page.getByTestId('chat-message-action-reply').click()
    await expect(page.getByTestId('chat-reply-preview')).toContainText('qual o horário de vocês?')
    await page.getByTestId('chat-reply-cancel').click()
    await expect(page.getByTestId('chat-reply-preview')).toHaveCount(0)

    await openMenu(page, m.id)
    await page.getByTestId('chat-message-action-copy').click()
    await expect(page.getByTestId('chat-copied')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('qual o horário de vocês?')
  })

  test('AC-T75-04 reagir pelo menu envia a reação e ela aparece', async ({ page }) => {
    const conn = await setup(page)
    const phone = newPhone()
    const wa = await inbound(page, conn.session_id, phone, { text: 'gostei!' })
    const chatId = await chatIdOf(page, phone)
    const m = await messageByWaId(page, chatId, wa)
    await openChat(page, chatId)
    // a fileira de emojis fica no topo do próprio menu da mensagem
    await openMenu(page, m.id)
    const option = page.getByTestId('chat-react-option').filter({ visible: true }).first()
    await expect(option).toBeVisible()
    const emoji = await option.getAttribute('data-emoji')
    const req = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/messages/${m.id}/react`))
    await option.click()
    expect(JSON.parse((await req).postData() ?? '{}').emoji).toBe(emoji)
    await expect(page.getByTestId(`chat-message-reactions-${m.id}`)).toContainText(emoji!)
    // a reação persiste ao recarregar
    await page.reload()
    await expect(page.getByTestId(`chat-message-reactions-${m.id}`)).toContainText(emoji!)
  })

  test('AC-T75-04 encaminhar para outro chat cria a mensagem no destino', async ({ page }) => {
    const conn = await setup(page)
    const phone = newPhone()
    const wa = await inbound(page, conn.session_id, phone, { text: 'encaminhe isto' })
    const chatId = await chatIdOf(page, phone)
    const target = await newChat(page, conn.session_id, 'sou o destino')
    const m = await messageByWaId(page, chatId, wa)
    await openChat(page, chatId)
    await openMenu(page, m.id)
    await page.getByTestId('chat-message-action-forward').click()
    await expect(page.getByTestId('chat-forward-modal')).toBeVisible()
    await page.getByTestId(`chat-forward-chat-${target.id}`).click()
    await page.getByTestId('chat-forward-submit').click()
    await expect(page.getByTestId('chat-forward-modal')).toBeHidden()
    await expect.poll(async () => (await messagesOf(page, target.id)).some((x) => x.direction === 'outbound')).toBe(true)
  })

  test('AC-T75-04 apagar para todos (mensagem enviada) e baixar mídia', async ({ page }) => {
    const conn = await setup(page)
    const phone = newPhone()
    const imgId = `IN-img-${Date.now().toString(36)}`
    await inbound(page, conn.session_id, phone, {
      id: imgId,
      type: 'imageMessage',
      text: undefined,
      media: { session_id: conn.session_id, message_id: imgId, mime: 'image/jpeg', size: null, sha256: null, key: null, status: 'pending' },
    })
    const chatId = await chatIdOf(page, phone)
    const img = await messageByWaId(page, chatId, imgId)
    const out = await sendText(page, chatId, 'mensagem errada')
    await markSent(page, conn.session_id, chatId, out)
    await openChat(page, chatId)

    await openMenu(page, out.id)
    await page.getByTestId('chat-message-action-delete').click()
    await expect(page.getByTestId('chat-delete-confirm')).toBeVisible()
    await page.getByTestId('chat-delete-confirm-submit').click()
    await expect(msg(page, out.id)).toHaveAttribute('data-deleted', 'true', { timeout: 15_000 })

    await openMenu(page, img.id)
    const download = page.getByTestId('chat-message-action-download')
    await expect(download).toBeVisible()
    const mediaUrl = new RegExp(`/api/chats/${chatId}/messages/${img.id}/media\\?.*download=1`)
    const got = Promise.race([
      page.waitForEvent('download', { timeout: 15_000 }).then((d) => d.url()),
      page.waitForRequest((r) => mediaUrl.test(r.url()), { timeout: 15_000 }).then((r) => r.url()),
    ])
    await download.click()
    expect(await got).toMatch(mediaUrl)
    // a rota de mídia responde com o conteúdo como anexo
    const res = await page.request.get(`/api/chats/${chatId}/messages/${img.id}/media?download=1`)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-disposition'] ?? '').toMatch(/attachment/)
  })
})

test.describe('T75 — tempo real e auto-rolagem', () => {
  test('AC-T75-05 mensagem via SSE aparece no fim e rola só se o usuário já estava no fim', async ({ page }) => {
    test.setTimeout(240_000)
    const conn = await setup(page)
    const chat = await chatWith(page, conn.session_id, 30)
    await openChat(page, chat.id)
    await expect(renderedMessages(page)).toHaveCount(25)
    await expect.poll(() => atBottom(page)).toBe(true)

    // no fim: rola junto
    const w1 = await inbound(page, conn.session_id, chat.phone, { text: 'nova no fim' })
    const m1 = await messageByWaId(page, chat.id, w1)
    await expect(msg(page, m1.id)).toBeVisible({ timeout: 15_000 })
    expect(await renderedMessages(page).last().getAttribute('data-testid')).toBe(`chat-message-${m1.id}`)
    await expect.poll(() => atBottom(page)).toBe(true)

    // rolado para cima: não rola e mostra o indicador
    await thread(page).evaluate((el) => el.scrollTo(0, Math.max(1, el.scrollHeight / 2 - el.clientHeight)))
    await expect.poll(() => atBottom(page)).toBe(false)
    const before = await thread(page).evaluate((el) => el.scrollTop)
    const w2 = await inbound(page, conn.session_id, chat.phone, { text: 'nova longe do fim' })
    const m2 = await messageByWaId(page, chat.id, w2)
    await expect(msg(page, m2.id)).toBeAttached({ timeout: 15_000 })
    expect(await renderedMessages(page).last().getAttribute('data-testid')).toBe(`chat-message-${m2.id}`)
    await expect(page.getByTestId('chat-thread-new-messages')).toBeVisible()
    expect(await atBottom(page)).toBe(false)
    expect(Math.abs((await thread(page).evaluate((el) => el.scrollTop)) - before)).toBeLessThan(50)

    await page.getByTestId('chat-thread-new-messages').click()
    await expect.poll(() => atBottom(page)).toBe(true)
    await expect(msg(page, m2.id)).toBeInViewport()
  })
})
