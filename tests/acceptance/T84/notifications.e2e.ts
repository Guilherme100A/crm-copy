// AC-T84-01..05 — central de notificações do shell: badge do sino ("9+"), item e som por `message.created` de entrada,
// supressão do chat aberto, clique → /chats/<id> e expiração de 1 h, preferências persistidas/"Restaurar padrão" e
// evento genérico `notification.created`. Contrato de testids e do sinal de som: spec/reports/T84-entrega.md.
// O `notification.created` é despachado na conexão SSE REAL da página (o harness não roda o fluxo da Venda aprovada).
import { expect, test, type Page } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { chatIdOf, createConnection, inbound, newChat, newPhone, sendText, trackSse, waitSseOpen } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const DEFAULTS = { enabled: true, volume: 50, browserNotifications: true, toastNotifications: true, sounds: true }

const bell = (page: Page) => page.getByTestId('notifications-bell')
const badge = (page: Page) => page.getByTestId('notifications-badge')
const panel = (page: Page) => page.getByTestId('notifications-panel')
const msgItems = (page: Page, chatId?: string) =>
  page.locator(`[data-testid^="notifications-item-"][data-kind="message"]${chatId ? `[data-chat-id="${chatId}"]` : ''}`)
const soundCount = async (page: Page) => Number((await bell(page).getAttribute('data-sound-count')) ?? '0')

async function setup(page: Page) {
  await trackSse(page)
  await loginAs(page, 'owner')
  const conn = await createConnection(page)
  return { sessionId: conn.session_id }
}

/** Abre uma página do app fora de /chats/<id> e espera o sino e o SSE. */
async function openApp(page: Page, path = '/') {
  await page.goto(path)
  await expect(bell(page)).toBeVisible()
  await waitSseOpen(page)
}

async function openPanel(page: Page) {
  if (!(await panel(page).isVisible())) await bell(page).click()
  await expect(panel(page)).toBeVisible()
}

async function closePanel(page: Page) {
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
}

async function openAdvanced(page: Page) {
  await openPanel(page)
  if (!(await page.getByTestId('notifications-prefs-reset').isVisible())) await page.getByTestId('notifications-prefs-advanced').click()
  await expect(page.getByTestId('notifications-prefs-reset')).toBeVisible()
}

const storedSettings = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('notification_settings') ?? 'null'))

/** Despacha `notification.created` na conexão SSE real (o cliente monta o envelope com a empresa da conexão). */
async function emitGeneric(page: Page, id: string, data: { title: string; body: string; url?: string | null }) {
  await page.evaluate(
    ({ id, data }) => {
      const list = ((window as any).__sse ?? []) as EventSource[]
      const es = [...list].reverse().find((s) => s.url.includes('/api/events') && s.readyState === 1)
      if (!es) throw new Error('sem SSE aberto')
      es.dispatchEvent(new MessageEvent('notification.created', { data: JSON.stringify(data), lastEventId: id }))
    },
    { id, data },
  )
}

test.describe('central de notificações (T84)', () => {
  test('AC-T84-01 message.created de entrada incrementa o badge, cria item e toca o som; acima de 9 mostra "9+"', async ({ page }) => {
    const { sessionId } = await setup(page)
    await openApp(page)
    await expect(badge(page)).toHaveCount(0)
    expect(await soundCount(page)).toBe(0)

    const phone = newPhone()
    await inbound(page, sessionId, phone, { text: 'quero saber o preço', push_name: 'Maria Teste' })
    const chatId = await chatIdOf(page, phone)

    await expect(badge(page)).toHaveText('1')
    await expect(badge(page)).toHaveAttribute('data-count', '1')
    await expect.poll(() => soundCount(page)).toBe(1)
    await expect(bell(page)).toHaveAttribute('data-last-sound-volume', '50')

    await openPanel(page)
    const item = msgItems(page, chatId)
    await expect(item).toHaveCount(1)
    await expect(item).toHaveAttribute('data-read', 'false')
    const id = (await item.getAttribute('data-testid'))!.replace('notifications-item-', '')
    await expect(page.getByTestId(`notifications-item-body-${id}`)).toContainText('quero saber o preço')
    await expect(page.getByTestId(`notifications-item-title-${id}`)).not.toBeEmpty()
    await closePanel(page)
    // fechar a central marca como lido
    await expect(badge(page)).toHaveCount(0)

    // Mensagem de SAÍDA não notifica.
    await sendText(page, chatId, 'resposta do atendente')
    await page.waitForTimeout(2_000)
    await expect(badge(page)).toHaveCount(0)
    expect(await soundCount(page)).toBe(1)

    // 10 entradas → "9+" (data-count com o número real).
    for (let i = 0; i < 10; i++) await inbound(page, sessionId, phone, { text: `msg ${i}` })
    await expect(badge(page)).toHaveAttribute('data-count', '10')
    await expect(badge(page)).toHaveText('9+')
    await expect.poll(() => soundCount(page)).toBe(11)
    await openPanel(page)
    await expect(msgItems(page, chatId)).toHaveCount(11)
  })

  test('AC-T84-02 mensagem do chat aberto não notifica (outro chat notifica)', async ({ page }) => {
    const { sessionId } = await setup(page)
    const a = await newChat(page, sessionId, 'primeira de A')
    const b = await newChat(page, sessionId, 'primeira de B')

    await openApp(page, `/chats/${a.id}`)
    await expect(page).toHaveURL(new RegExp(`/chats/${a.id}$`))
    const before = await soundCount(page)

    await inbound(page, sessionId, a.phone, { text: 'nova no chat aberto' })
    await inbound(page, sessionId, b.phone, { text: 'nova em outro chat' })

    // B notifica (prova que o SSE entregou); A, aberto, não.
    await expect(badge(page)).toHaveAttribute('data-count', '1')
    await expect.poll(() => soundCount(page)).toBe(before + 1)
    await openPanel(page)
    await expect(msgItems(page, b.id)).toHaveCount(1)
    await expect(msgItems(page, a.id)).toHaveCount(0)
  })

  test('AC-T84-03 clicar no item abre /chats/<id> e marca como lido', async ({ page }) => {
    const { sessionId } = await setup(page)
    await openApp(page)
    const phone = newPhone()
    await inbound(page, sessionId, phone, { text: 'abre meu chat' })
    const chatId = await chatIdOf(page, phone)

    await expect(badge(page)).toHaveText('1')
    await openPanel(page)
    await msgItems(page, chatId).click()
    await expect(page).toHaveURL(new RegExp(`/chats/${chatId}$`))
    await expect(badge(page)).toHaveCount(0)
    await openPanel(page)
    await expect(msgItems(page, chatId)).toHaveAttribute('data-read', 'true')
  })

  test('AC-T84-03 itens com mais de 1 h somem da central', async ({ page }) => {
    const { sessionId } = await setup(page)
    await page.clock.install()
    await openApp(page)
    const phone = newPhone()
    await inbound(page, sessionId, phone, { text: 'vai expirar' })
    const chatId = await chatIdOf(page, phone)
    await expect(badge(page)).toHaveText('1')

    // Ainda dentro da hora: continua.
    await page.clock.fastForward('50:00')
    await openPanel(page)
    await expect(msgItems(page, chatId)).toHaveCount(1)
    await closePanel(page)

    await page.clock.fastForward('11:00')
    await expect(badge(page)).toHaveCount(0)
    await openPanel(page)
    await expect(msgItems(page, chatId)).toHaveCount(0)
    await expect(page.getByTestId('notifications-empty')).toHaveText('Nenhuma notificação')
  })

  test('AC-T84-04 preferências persistem após recarregar e "Restaurar padrão" volta aos valores de 14#10', async ({ page }) => {
    await setup(page)
    await openApp(page)
    await openAdvanced(page)
    for (const k of ['enabled', 'toast', 'sounds', 'browser']) await expect(page.getByTestId(`notifications-prefs-${k}`)).toBeChecked()
    await expect(page.getByTestId('notifications-prefs-volume')).toHaveValue('50')

    await page.getByTestId('notifications-prefs-volume').fill('30')
    await expect(page.getByTestId('notifications-prefs-volume-value')).toHaveText('30%')
    await page.getByTestId('notifications-prefs-browser').uncheck()
    await page.getByTestId('notifications-prefs-toast').uncheck()
    await page.getByTestId('notifications-prefs-sounds').uncheck()
    await page.getByTestId('notifications-prefs-enabled').uncheck()
    expect(await storedSettings(page)).toEqual({ enabled: false, volume: 30, browserNotifications: false, toastNotifications: false, sounds: false })

    await page.reload()
    await expect(bell(page)).toBeVisible()
    await openAdvanced(page)
    for (const k of ['enabled', 'toast', 'sounds', 'browser']) await expect(page.getByTestId(`notifications-prefs-${k}`)).not.toBeChecked()
    await expect(page.getByTestId('notifications-prefs-volume')).toHaveValue('30')

    await page.getByTestId('notifications-prefs-reset').click()
    for (const k of ['enabled', 'toast', 'sounds', 'browser']) await expect(page.getByTestId(`notifications-prefs-${k}`)).toBeChecked()
    await expect(page.getByTestId('notifications-prefs-volume')).toHaveValue('50')
    await expect(page.getByTestId('notifications-prefs-volume-value')).toHaveText('50%')
    expect(await storedSettings(page)).toEqual(DEFAULTS)
    await page.reload()
    await expect(bell(page)).toBeVisible()
    expect(await storedSettings(page)).toEqual(DEFAULTS)
  })

  test('AC-T84-04 volume 0 e sons desligados não tocam som; ativo desligado não notifica', async ({ page }) => {
    const { sessionId } = await setup(page)
    await openApp(page)
    const phone = newPhone()

    // volume 0: item entra, som não toca
    await openPanel(page)
    await page.getByTestId('notifications-prefs-volume').fill('0')
    await expect(page.getByTestId('notifications-prefs-volume-value')).toHaveText('0%')
    await closePanel(page)
    await inbound(page, sessionId, phone, { text: 'sem som 1' })
    const chatId = await chatIdOf(page, phone)
    await expect(badge(page)).toHaveAttribute('data-count', '1')
    await page.waitForTimeout(1_000)
    expect(await soundCount(page)).toBe(0)

    // volume de volta, sons desligados: item entra, som não toca
    await openAdvanced(page)
    await page.getByTestId('notifications-prefs-volume').fill('80')
    await page.getByTestId('notifications-prefs-sounds').uncheck()
    await closePanel(page)
    await inbound(page, sessionId, phone, { text: 'sem som 2' })
    await expect(badge(page)).toHaveAttribute('data-count', '1') // o fechamento anterior marcou o 1º como lido
    await page.waitForTimeout(1_000)
    expect(await soundCount(page)).toBe(0)

    // sons ligados: toca com o volume escolhido
    await openAdvanced(page)
    await page.getByTestId('notifications-prefs-sounds').check()
    await closePanel(page)
    await inbound(page, sessionId, phone, { text: 'com som' })
    await expect.poll(() => soundCount(page)).toBe(1)
    await expect(bell(page)).toHaveAttribute('data-last-sound-volume', '80')

    // ativo desligado: nada (sem item, sem som)
    await openAdvanced(page)
    await page.getByTestId('notifications-prefs-enabled').uncheck()
    await closePanel(page)
    await inbound(page, sessionId, phone, { text: 'central desligada' })
    await page.waitForTimeout(2_500)
    await expect(badge(page)).toHaveCount(0)
    expect(await soundCount(page)).toBe(1)
    await openPanel(page)
    await expect(msgItems(page, chatId)).toHaveCount(3)
  })

  test('AC-T84-05 notification.created vira toast e item genérico na central', async ({ page }) => {
    await setup(page)
    await openApp(page)
    await emitGeneric(page, 'e2e-1', { title: 'Venda aprovada', body: 'R$ 97,00', url: null })

    const toast = page.getByTestId('notifications-toast')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('Venda aprovada')
    await expect(toast).toContainText('R$ 97,00')
    await expect(badge(page)).toHaveText('1')
    await expect.poll(() => soundCount(page)).toBe(1)

    await openPanel(page)
    const item = page.getByTestId('notifications-item-n-e2e-1')
    await expect(item).toHaveAttribute('data-kind', 'generic')
    await expect(page.getByTestId('notifications-item-title-n-e2e-1')).toHaveText('Venda aprovada')
    await expect(page.getByTestId('notifications-item-body-n-e2e-1')).toHaveText('R$ 97,00')
    await closePanel(page)
    // o toast some (3 s)
    await expect(toast).toHaveCount(0, { timeout: 8_000 })
  })

  test('AC-T84-05 notification.created respeita as preferências (toast, volume, ativo)', async ({ page }) => {
    await setup(page)
    await openApp(page)
    const toast = page.getByTestId('notifications-toast')

    // toast desligado + volume 0: item entra, sem toast e sem som
    await openAdvanced(page)
    await page.getByTestId('notifications-prefs-toast').uncheck()
    await page.getByTestId('notifications-prefs-volume').fill('0')
    await closePanel(page)
    await emitGeneric(page, 'e2e-2', { title: 'Sem toast', body: 'corpo 2' })
    await expect(badge(page)).toHaveText('1')
    await page.waitForTimeout(1_000)
    await expect(toast).toHaveCount(0)
    expect(await soundCount(page)).toBe(0)
    await openPanel(page)
    await expect(page.getByTestId('notifications-item-n-e2e-2')).toHaveAttribute('data-kind', 'generic')

    // ativo desligado: nem item nem toast
    await openAdvanced(page)
    await page.getByTestId('notifications-prefs-toast').check()
    await page.getByTestId('notifications-prefs-enabled').uncheck()
    await closePanel(page)
    await emitGeneric(page, 'e2e-3', { title: 'Desligado', body: 'corpo 3' })
    await page.waitForTimeout(1_500)
    await expect(toast).toHaveCount(0)
    await expect(badge(page)).toHaveCount(0)
    await openPanel(page)
    await expect(page.getByTestId('notifications-item-n-e2e-3')).toHaveCount(0)
  })
})
