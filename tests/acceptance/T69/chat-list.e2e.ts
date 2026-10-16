// AC-T69-01..04 — lista de chats: abas e filtros na URL, atualização por SSE, rolagem infinita/vazio e mobile.
import { expect, test, type Page } from '@playwright/test'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed } from '../helpers/e2e'
import { assign, createConnection, emitInbound, listIds, markRead, newChat, resolve } from './chat-data'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const params = (page: Page) => new URL(page.url()).searchParams

/** Registra os EventSource da página para o teste esperar o SSE conectado antes de emitir eventos. */
async function trackSse(page: Page) {
  await page.addInitScript(() => {
    const w = window as any
    w.__sse = [] as EventSource[]
    const Orig = w.EventSource
    w.EventSource = class extends Orig {
      constructor(url: string, init?: any) {
        super(url, init)
        w.__sse.push(this)
      }
    }
  })
}

/** Espera haver um SSE de /api/events aberto (readyState 1): eventos emitidos antes disso não teriam como chegar. */
async function waitSseOpen(page: Page) {
  await expect
    .poll(() => page.evaluate(() => ((window as any).__sse ?? []).some((es: EventSource) => es.url.includes('/api/events') && es.readyState === 1)), {
      timeout: 20_000,
    })
    .toBe(true)
}

async function setup(page: Page) {
  const login = await loginAs(page, 'owner')
  const conn = await createConnection(page)
  return { userId: login.user.id as string, sessionId: conn.session_id, connectionId: conn.id }
}

test.describe('T69 — abas e filtros', () => {
  test('AC-T69-01 abas por status com contadores; trocar de aba reflete na URL', async ({ page }) => {
    const { userId, sessionId } = await setup(page)
    const w1 = await newChat(page, sessionId)
    const w2 = await newChat(page, sessionId)
    const at = await newChat(page, sessionId)
    const rs = await newChat(page, sessionId)
    await assign(page, at.id, userId)
    await assign(page, rs.id, userId)
    await resolve(page, rs.id)

    await page.goto('/chats')
    await expect(page.getByTestId('chat-tab-waiting')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('chat-tab-count-waiting')).toHaveText('2')
    await expect(page.getByTestId('chat-tab-count-attending')).toHaveText('1')
    await expect(page.getByTestId('chat-tab-count-resolved')).toHaveText('1')
    await expect.poll(() => listIds(page)).toEqual(expect.arrayContaining([w1.id, w2.id]))
    expect(await listIds(page)).not.toContain(at.id)

    await page.getByTestId('chat-tab-attending').click()
    await expect(page).toHaveURL(/status=attending/)
    await expect.poll(() => listIds(page)).toEqual([at.id])
    await page.getByTestId('chat-tab-resolved').click()
    await expect.poll(() => listIds(page)).toEqual([rs.id])
    await page.reload()
    await expect(page.getByTestId('chat-tab-resolved')).toHaveAttribute('data-active', 'true')
    await expect.poll(() => listIds(page)).toEqual([rs.id])
  })

  test('AC-T69-01 filtro rápido "Não lidas" filtra, vai para a URL e se mantém ao recarregar; "Tudo" volta', async ({ page }) => {
    const { sessionId } = await setup(page)
    const unread = await newChat(page, sessionId)
    const read = await newChat(page, sessionId)
    await markRead(page, read.id)

    await page.goto('/chats')
    await expect.poll(() => listIds(page)).toEqual(expect.arrayContaining([unread.id, read.id]))
    await page.getByTestId('chat-quick-unread').click()
    await expect(page).toHaveURL(/quick=unread/)
    await expect(page.getByTestId('chat-quick-unread')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => listIds(page)).toEqual([unread.id])

    const req = page.waitForRequest((r) => r.url().includes('/api/chats?') && new URL(r.url()).searchParams.get('read_status') === 'unread')
    await page.reload()
    await req
    await expect(page.getByTestId('chat-quick-unread')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => listIds(page)).toEqual([unread.id])

    await page.getByTestId('chat-quick-all').click()
    expect(params(page).get('quick')).toBeNull()
    await expect.poll(() => listIds(page)).toEqual(expect.arrayContaining([unread.id, read.id]))
  })

  test('AC-T69-01 filtro rápido "Não respondidas" vai para a URL e para a requisição', async ({ page }) => {
    await setup(page)
    await page.goto('/chats')
    const req = page.waitForRequest((r) => r.url().includes('/api/chats?') && new URL(r.url()).searchParams.get('response_status') === 'unanswered')
    await page.getByTestId('chat-quick-unanswered').click()
    await req
    await expect(page).toHaveURL(/quick=unanswered/)
    await expect(page.getByTestId('chat-quick-unanswered')).toHaveAttribute('aria-pressed', 'true')
  })

  test('AC-T69-01 filtros avançados (modal) vão para a URL e se mantêm ao recarregar', async ({ page }) => {
    const { connectionId, sessionId } = await setup(page)
    await newChat(page, sessionId)
    await page.goto('/chats')
    await page.getByTestId('chat-filters-open').click()
    const modal = page.getByTestId('chat-filters-modal')
    await expect(modal).toBeVisible()
    await page.getByTestId('chat-filter-created-from').fill('2026-01-01')
    await page.getByTestId('chat-filter-created-to').fill('2026-12-31')
    await page.getByTestId(`chat-filter-connection-${connectionId}`).check()
    await page.getByTestId('chat-filter-assigned').selectOption('none')
    await page.getByTestId('chat-filters-apply').click()
    await expect(modal).toBeHidden()

    await expect.poll(() => params(page).get('created_from')).toBe('2026-01-01')
    expect(params(page).get('created_to')).toBe('2026-12-31')
    expect(params(page).get('assigned_to')).toBe('none')
    expect(params(page).get('connection_ids') ?? '').toContain(connectionId)
    await expect(page.getByTestId('chat-filters-count')).toBeVisible()

    const req = page.waitForRequest((r) => {
      if (!r.url().includes('/api/chats?')) return false
      const q = new URL(r.url()).searchParams
      return q.get('assigned_to') === 'none' && q.getAll('connection_ids').join(',').includes(connectionId) && Boolean(q.get('created_from')) && Boolean(q.get('created_to'))
    })
    await page.reload()
    await req
    await page.getByTestId('chat-filters-open').click()
    await expect(page.getByTestId('chat-filter-created-from')).toHaveValue('2026-01-01')
    await expect(page.getByTestId('chat-filter-created-to')).toHaveValue('2026-12-31')
    await expect(page.getByTestId(`chat-filter-connection-${connectionId}`)).toBeChecked()
    await expect(page.getByTestId('chat-filter-assigned')).toHaveValue('none')
  })

  test('AC-T69-01 período com só uma data mostra erro e não aplica', async ({ page }) => {
    await setup(page)
    await page.goto('/chats')
    await page.getByTestId('chat-filters-open').click()
    await page.getByTestId('chat-filter-created-from').fill('2026-01-01')
    await page.getByTestId('chat-filters-apply').click()
    await expect(page.getByTestId('chat-filters-error')).toBeVisible()
    expect(params(page).get('created_from')).toBeNull()
  })
})

test.describe('T69 — tempo real', () => {
  test('AC-T69-02 mensagem nova via SSE move o chat para o topo e atualiza não lidas sem recarregar', async ({ page }) => {
    const { sessionId } = await setup(page)
    const older = await newChat(page, sessionId, 'primeira')
    await newChat(page, sessionId, 'segunda')
    const newest = await newChat(page, sessionId, 'terceira')
    await trackSse(page)
    await page.goto('/chats')
    await expect.poll(async () => (await listIds(page))[0]).toBe(newest.id)
    await expect(page.getByTestId(`chat-list-item-${older.id}`)).toHaveAttribute('data-unread', '1')
    await waitSseOpen(page)

    // marcador para provar que a página não recarregou
    await page.evaluate(() => ((window as any).__t69NoReload = true))
    await emitInbound(page, sessionId, older.phone, 'voltei com mais uma dúvida')
    await expect.poll(async () => (await listIds(page))[0], { timeout: 20_000 }).toBe(older.id)
    await expect(page.getByTestId(`chat-list-item-${older.id}`)).toHaveAttribute('data-unread', '2')
    await expect(page.getByTestId(`chat-list-item-unread-${older.id}`)).toHaveText('2')
    await expect(page.getByTestId(`chat-list-item-preview-${older.id}`)).toContainText('voltei com mais uma dúvida')
    expect(await page.evaluate(() => (window as any).__t69NoReload)).toBe(true)
  })

  test('AC-T69-02 chat novo chega pelo SSE e aparece no topo com contador atualizado', async ({ page }) => {
    const { sessionId } = await setup(page)
    await newChat(page, sessionId)
    await trackSse(page)
    await page.goto('/chats')
    await expect(page.getByTestId('chat-tab-count-waiting')).toHaveText('1')
    await waitSseOpen(page)
    await page.evaluate(() => ((window as any).__t69NoReload = true))
    const fresh = await newChat(page, sessionId, 'sou novo aqui')
    await expect.poll(async () => (await listIds(page))[0], { timeout: 20_000 }).toBe(fresh.id)
    await expect(page.getByTestId('chat-tab-count-waiting')).toHaveText('2')
    expect(await page.evaluate(() => (window as any).__t69NoReload)).toBe(true)
  })
})

test.describe('T69 — rolagem e vazio', () => {
  test('AC-T69-03 rolagem infinita carrega a próxima página', async ({ page }) => {
    test.setTimeout(180_000)
    const { sessionId } = await setup(page)
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push((await newChat(page, sessionId, `mensagem ${i}`)).id)
    await page.goto('/chats')
    await expect.poll(async () => (await listIds(page)).length).toBe(15)

    const list = page.getByTestId('chat-list')
    await list.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    // a sentinela some quando a última página chega: só rola até ela se ainda existir
    const sentinel = page.getByTestId('chat-list-sentinel')
    if (await sentinel.count()) await sentinel.scrollIntoViewIfNeeded().catch(() => {})
    await expect.poll(async () => (await listIds(page)).length, { timeout: 20_000 }).toBe(20)
    const shown = await listIds(page)
    expect(new Set(shown).size).toBe(20)
    expect([...shown].sort()).toEqual([...ids].sort())
  })

  test('AC-T69-03 estado vazio por aba', async ({ page }) => {
    const { sessionId } = await setup(page)
    await newChat(page, sessionId)
    await page.goto('/chats?status=attending')
    await expect(page.getByTestId('chat-list-empty')).toBeVisible()
    await expect(page.getByTestId('chat-list-empty')).toHaveAttribute('data-status', 'attending')
    await page.getByTestId('chat-tab-resolved').click()
    await expect(page.getByTestId('chat-list-empty')).toHaveAttribute('data-status', 'resolved')
    await page.getByTestId('chat-tab-waiting').click()
    await expect(page.getByTestId('chat-list-empty')).toHaveCount(0)
    expect((await listIds(page)).length).toBe(1)
  })
})

test.describe('T69 — mobile e desktop', () => {
  test('AC-T69-04 no mobile só a lista aparece; tocar abre a conversa em tela cheia com voltar (no desktop, 3 painéis)', async ({ page }) => {
    const { sessionId } = await setup(page)
    const a = await newChat(page, sessionId)
    await page.goto('/chats?quick=unread')
    await expect(page.getByTestId(`chat-list-item-${a.id}`)).toBeVisible()

    if (isMobile(page)) {
      await expect(page.getByTestId('chat-conversation-panel')).toBeHidden()
      await expectNoHorizontalScroll(page)
      await page.getByTestId(`chat-list-item-${a.id}`).tap()
      await expect(page).toHaveURL(new RegExp(`/chats/${a.id}`))
      expect(params(page).get('quick')).toBe('unread')
      await expect(page.getByTestId('chat-conversation')).toBeVisible()
      await expect(page.getByTestId('chat-conversation')).toHaveAttribute('data-chat-id', a.id)
      await expect(page.getByTestId('chat-list')).toBeHidden()
      await expectNoHorizontalScroll(page)
      await page.getByTestId('chat-back').tap()
      await expect(page).toHaveURL(/\/chats(\?|$)/)
      expect(params(page).get('quick')).toBe('unread')
      await expect(page.getByTestId('chat-list')).toBeVisible()
    } else {
      await expect(page.getByTestId('chat-conversation-empty')).toBeVisible()
      await page.getByTestId(`chat-list-item-${a.id}`).click()
      await expect(page).toHaveURL(new RegExp(`/chats/${a.id}`))
      await expect(page.getByTestId('chat-conversation')).toHaveAttribute('data-chat-id', a.id)
      await expect(page.getByTestId('chat-list')).toBeVisible()
      await expect(page.getByTestId('chat-back')).toBeHidden()
    }
  })
})
