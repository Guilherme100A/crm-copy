// AC-T70-01..05 — kanban: lista com indicadores e busca, quadro com arrastar card/coluna, paginação por coluna,
// card e mobile ("Mover para…" e snap horizontal). Contrato de data-testid combinado com o Torno.
import { expect, test, type Page, type Request } from '@playwright/test'
import { isMobile, loginAs, resetSeed } from '../helpers/e2e'
import { createConnection, inbound, newChat, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'patch', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

/** Quadro novo (já vem com colunas padrão) + colunas extras opcionais; devolve id e colunas em ordem. */
async function board(page: Page, name: string, extra: Array<{ name: string; conversion_goal?: boolean }> = []) {
  const body = await api(page, 'post', '/api/crms', { name })
  const id = (body.crm ?? body).id as string
  for (const c of extra) await api(page, 'post', `/api/crms/${id}/columns`, c)
  const cols = ((await api(page, 'get', `/api/crms/${id}/columns`)).items as any[]).sort((a, b) => a.position - b.position)
  return { id, name, columns: cols as Array<{ id: string; name: string; position: number; conversion_goal?: boolean }> }
}

async function card(page: Page, crmId: string, chatId: string, columnId: string, valueCents = 0) {
  const body = await api(page, 'post', `/api/crms/${crmId}/cards`, { chat_id: chatId, column_id: columnId, value_cents: valueCents })
  return (body.card ?? body).id as string
}

const brl0 = (cents: number) => `R$ ${Math.round(cents / 100).toLocaleString('pt-BR')}`.replace(/ /g, ' ')
const brl2 = (cents: number) =>
  `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.replace(/ /g, ' ')
const pct1 = (n: number) => `${n.toFixed(1).replace('.', ',')}%`
/** '55119xxxxxxxx' → '+55 (11) 9xxxx-xxxx' */
const phoneFmt = (digits: string) => `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`

/** Arrasto com o ponteiro (dnd-kit: > 5 px de deslocamento, com passos). */
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

test.describe('T70 — lista de quadros', () => {
  test('AC-T70-01 /crms mostra indicadores (quadros, cards, valor, conversão média) e a grade com mini-funil', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const a = await board(page, `Vendas ${uniq()}`, [{ name: 'Ganho', conversion_goal: true }])
    const b = await board(page, `Suporte ${uniq()}`)
    const won = a.columns.find((c) => c.conversion_goal)!
    const firstA = a.columns[0]!
    const cards: Array<[string, string, string, number]> = [
      [a.id, firstA.id, 'a1', 10_000],
      [a.id, firstA.id, 'a2', 25_050],
      [a.id, won.id, 'a3', 40_000],
      [b.id, b.columns[0]!.id, 'b1', 5_000],
    ]
    for (const [crm, col, , v] of cards) await card(page, crm, (await newChat(page, conn.session_id)).id, col, v)

    await page.goto('/crms')
    const totalCards = 4
    const totalValue = 10_000 + 25_050 + 40_000 + 5_000
    await expect(page.getByTestId('crms-stat-boards')).toHaveText(/\b2\b/)
    await expect(page.getByTestId('crms-stat-cards')).toHaveText(new RegExp(`\\b${totalCards}\\b`))
    await expect(page.getByTestId('crms-stat-value')).toContainText(brl0(totalValue))
    // Σ conversões (1) / Σ cards (4) = 25,0%
    await expect(page.getByTestId('crms-stat-conversion')).toContainText(pct1((1 / totalCards) * 100))

    const itemA = page.getByTestId(`crms-board-${a.id}`)
    await expect(itemA).toBeVisible()
    await expect(page.getByTestId(`crms-board-name-${a.id}`)).toHaveText(a.name)
    await expect(page.getByTestId(`crms-board-columns-${a.id}`)).toContainText(String(a.columns.length))
    await expect(page.getByTestId(`crms-board-cards-${a.id}`)).toContainText('3')
    await expect(page.getByTestId(`crms-board-value-${a.id}`)).toContainText(brl0(75_050))
    await expect(page.getByTestId(`crms-board-converted-${a.id}`)).toContainText('1')
    await expect(page.getByTestId(`crms-board-rate-${a.id}`)).toContainText(pct1((1 / 3) * 100))
    // mini-funil com as etapas em ordem de posição
    const steps = await page
      .getByTestId(`crms-board-funnel-${a.id}`)
      .locator('[data-testid^="crms-board-funnel-step-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('crms-board-funnel-step-', '')))
    expect(steps).toEqual(a.columns.map((c) => c.id))
    // grade ordenada por atualização mais recente
    const order = await page.locator('[data-testid^="crms-board-"][href]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
    expect(order.indexOf(`crms-board-${b.id}`)).toBeLessThan(order.indexOf(`crms-board-${a.id}`))
  })

  test('AC-T70-01 busca local por nome (sem caixa) sem novas requisições', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const a = await board(page, `Funil Atacado ${tag}`)
    const b = await board(page, `Pós-venda ${tag}`)
    await page.goto('/crms')
    await expect(page.getByTestId(`crms-board-${a.id}`)).toBeVisible()
    const calls: Request[] = []
    page.on('request', (r) => new URL(r.url()).pathname.startsWith('/api/') && calls.push(r))
    await page.getByTestId('crms-search').fill('ATACADO')
    await expect(page.getByTestId(`crms-board-${a.id}`)).toBeVisible()
    await expect(page.getByTestId(`crms-board-${b.id}`)).toHaveCount(0)
    await page.getByTestId('crms-search').fill('nada-com-isso')
    await expect(page.getByTestId('crms-search-empty')).toBeVisible()
    await page.getByTestId('crms-search').fill('')
    await expect(page.getByTestId(`crms-board-${b.id}`)).toBeVisible()
    expect(calls.filter((r) => r.url().includes('/api/crms')), 'busca deve ser local').toHaveLength(0)
  })
})

test.describe('T70 — arrastar card', () => {
  async function twoColumnBoard(page: Page) {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const bd = await board(page, `Pipeline ${uniq()}`)
    const [c1, c2] = bd.columns
    const cA = await card(page, bd.id, (await newChat(page, conn.session_id)).id, c1!.id, 10_000)
    const cB = await card(page, bd.id, (await newChat(page, conn.session_id)).id, c1!.id, 5_000)
    return { bd, c1: c1!, c2: c2!, cA, cB }
  }

  test('AC-T70-02 arrastar card entre colunas atualiza contagens e somas na hora', async ({ page }) => {
    const { bd, c1, c2, cA } = await twoColumnBoard(page)
    await page.goto(`/crms/${bd.id}`)
    await expect(page.getByTestId(`crms-column-count-${c1.id}`)).toHaveText(/\b2\b/)
    await expect(page.getByTestId(`crms-column-value-${c1.id}`)).toContainText(brl2(15_000))
    await expect(page.getByTestId(`crms-column-count-${c2.id}`)).toHaveText(/\b0\b/)

    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/api/crms/${bd.id}/cards/${cA}/move`))
    await drag(page, page.getByTestId(`crms-card-${cA}`), page.getByTestId(`crms-column-cards-${c2.id}`))
    const res = await patch
    const body = JSON.parse(res.request().postData() ?? '{}')
    expect(body.new_column_id ?? body.column_id).toBe(c2.id)
    expect(res.status()).toBeLessThan(300)
    await expect(page.getByTestId(`crms-column-cards-${c2.id}`).getByTestId(`crms-card-${cA}`)).toBeVisible()
    await expect(page.getByTestId(`crms-column-count-${c1.id}`)).toHaveText(/\b1\b/)
    await expect(page.getByTestId(`crms-column-count-${c2.id}`)).toHaveText(/\b1\b/)
    await expect(page.getByTestId(`crms-column-value-${c1.id}`)).toContainText(brl2(5_000))
    await expect(page.getByTestId(`crms-column-value-${c2.id}`)).toContainText(brl2(10_000))
    // persistiu
    const cards = await api(page, 'get', `/api/crms/${bd.id}/cards?column_id=${c2.id}`)
    expect(JSON.stringify(cards)).toContain(cA)
  })

  test('AC-T70-02 erro do servidor desfaz o movimento e mostra aviso', async ({ page }) => {
    const { bd, c1, c2, cA } = await twoColumnBoard(page)
    await page.route(`**/api/crms/${bd.id}/cards/*/move`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'falha simulada' } }) }),
    )
    await page.goto(`/crms/${bd.id}`)
    await expect(page.getByTestId(`crms-column-count-${c1.id}`)).toHaveText(/\b2\b/)
    await drag(page, page.getByTestId(`crms-card-${cA}`), page.getByTestId(`crms-column-cards-${c2.id}`))
    await expect(page.getByTestId('crms-move-error')).toBeVisible()
    await expect(page.getByTestId(`crms-column-cards-${c1.id}`).getByTestId(`crms-card-${cA}`)).toBeVisible()
    await expect(page.getByTestId(`crms-column-count-${c1.id}`)).toHaveText(/\b2\b/)
    await expect(page.getByTestId(`crms-column-count-${c2.id}`)).toHaveText(/\b0\b/)
    await expect(page.getByTestId(`crms-column-value-${c1.id}`)).toContainText(brl2(15_000))
  })
})

test.describe('T70 — colunas', () => {
  test('AC-T70-03 arrastar coluna reordena e persiste', async ({ page }) => {
    await loginAs(page, 'owner')
    const bd = await board(page, `Ordem ${uniq()}`)
    expect(bd.columns.length).toBeGreaterThanOrEqual(3)
    const [first, , third] = bd.columns
    await page.goto(`/crms/${bd.id}`)
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes(`/api/crms/${bd.id}/columns/${first!.id}/move`))
    await drag(page, page.getByTestId(`crms-column-handle-${first!.id}`), page.getByTestId(`crms-column-handle-${third!.id}`))
    const pos = JSON.parse((await patch).postData() ?? '{}').position
    expect(pos).toBeGreaterThan(0)
    await expect(page.getByTestId(`crms-column-${first!.id}`)).toHaveAttribute('data-position', String(pos))
    await page.reload()
    await expect(page.getByTestId(`crms-column-${first!.id}`)).toHaveAttribute('data-position', String(pos))
    const persisted = ((await api(page, 'get', `/api/crms/${bd.id}/columns`)).items as any[]).find((c) => c.id === first!.id)
    expect(persisted.position).toBe(pos)
  })

  test('AC-T70-03 "Carregar mais" por coluna pagina (20 por página)', async ({ page }) => {
    test.setTimeout(240_000)
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const bd = await board(page, `Muitos ${uniq()}`)
    const col = bd.columns[0]!
    for (let i = 0; i < 22; i++) await card(page, bd.id, (await newChat(page, conn.session_id)).id, col.id, 100)
    await page.goto(`/crms/${bd.id}`)
    const list = page.getByTestId(`crms-column-cards-${col.id}`)
    const count = () => list.locator('[data-testid^="crms-card-"][data-column-id]').count()
    await expect.poll(count).toBe(20)
    await expect(page.getByTestId(`crms-column-count-${col.id}`)).toHaveText(/\b22\b/)
    const more = page.getByTestId(`crms-column-load-more-${col.id}`)
    await expect(more).toBeVisible()
    const req = page.waitForRequest((r) => r.url().includes(`/api/crms/${bd.id}/cards`) && new URL(r.url()).searchParams.get('page') === '2')
    await more.click()
    await req
    await expect.poll(count).toBe(22)
    await expect(more).toHaveCount(0)
  })
})

test.describe('T70 — card', () => {
  test('AC-T70-04 card mostra nome, telefone formatado, etiquetas, prévia, não lidas e valor; clique abre o chat', async ({ page }) => {
    test.setTimeout(180_000)
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id, 'mensagem 0')
    for (let i = 1; i <= 10; i++) await inbound(page, conn.session_id, chat.phone, { text: `mensagem ${i}` })
    const { label } = await api(page, 'post', '/api/labels', { name: `VIP ${uniq()}`, color: '#22c55e' })
    await api(page, 'post', `/api/chats/${chat.id}/labels`, { label_id: label.id })
    const contact = (await api(page, 'get', `/api/chats/${chat.id}`)).chat.contact
    const bd = await board(page, `Card ${uniq()}`)
    const cardId = await card(page, bd.id, chat.id, bd.columns[0]!.id, 123_456)

    await page.goto(`/crms/${bd.id}`)
    await expect(page.getByTestId(`crms-card-name-${cardId}`)).toHaveText(contact.name)
    await expect(page.getByTestId(`crms-card-phone-${cardId}`)).toHaveText(phoneFmt(chat.phone))
    await expect(page.getByTestId(`crms-card-label-${cardId}-${label.id}`)).toContainText(label.name)
    await expect(page.getByTestId(`crms-card-preview-${cardId}`)).toContainText('mensagem 10')
    await expect(page.getByTestId(`crms-card-unread-${cardId}`)).toHaveText('9+')
    await expect(page.getByTestId(`crms-card-value-${cardId}`)).toContainText(brl2(123_456))

    await page.getByTestId(`crms-card-name-${cardId}`).click()
    await expect(page).toHaveURL(new RegExp(`/chats?/${chat.id}`))
  })

  test('AC-T70-04 card sem valor e com poucas não lidas', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id, 'oi')
    await inbound(page, conn.session_id, chat.phone, { text: 'tudo bem?' })
    const bd = await board(page, `Card2 ${uniq()}`)
    const cardId = await card(page, bd.id, chat.id, bd.columns[0]!.id, 0)
    await page.goto(`/crms/${bd.id}`)
    await expect(page.getByTestId(`crms-card-unread-${cardId}`)).toHaveText('2')
    await expect(page.getByTestId(`crms-card-value-${cardId}`)).toHaveCount(0)
  })
})

test.describe('T70 — mobile e "Mover para…"', () => {
  test('AC-T70-05 "Mover para…" move o card para outra coluna (coluna atual desabilitada)', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const bd = await board(page, `Mover ${uniq()}`)
    const [c1, c2] = bd.columns
    const cardId = await card(page, bd.id, (await newChat(page, conn.session_id)).id, c1!.id, 2_000)
    await page.goto(`/crms/${bd.id}`)
    await page.getByTestId(`crms-card-move-${cardId}`).click()
    await expect(page.getByTestId(`crms-card-move-menu-${cardId}`)).toBeVisible()
    await expect(page.getByTestId(`crms-card-move-option-${cardId}-${c1!.id}`)).toBeDisabled()
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes(`/cards/${cardId}/move`))
    await page.getByTestId(`crms-card-move-option-${cardId}-${c2!.id}`).click()
    const body = JSON.parse((await patch).postData() ?? '{}')
    expect(body.new_column_id ?? body.column_id).toBe(c2!.id)
    await expect(page.getByTestId(`crms-column-cards-${c2!.id}`).getByTestId(`crms-card-${cardId}`)).toBeAttached()
    await expect(page.getByTestId(`crms-column-count-${c2!.id}`)).toHaveText(/\b1\b/)
  })

  test('AC-T70-05 no mobile as colunas rolam com snap horizontal dentro do quadro, sem rolagem horizontal da página', async ({ page }) => {
    await loginAs(page, 'owner')
    const bd = await board(page, `Snap ${uniq()}`)
    await page.goto(`/crms/${bd.id}`)
    const scroller = page.getByTestId('crms-board-scroll')
    await expect(scroller).toBeVisible()
    const doc = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }))
    expect(doc.s, 'página não pode rolar na horizontal').toBeLessThanOrEqual(doc.c)
    if (isMobile(page)) {
      expect(await scroller.evaluate((el) => getComputedStyle(el).scrollSnapType)).toMatch(/x\s+mandatory/)
      const first = page.getByTestId(`crms-column-${bd.columns[0]!.id}`)
      expect(await first.evaluate((el) => getComputedStyle(el).scrollSnapAlign)).toMatch(/start/)
      // o quadro rola por dentro e encaixa na próxima coluna
      const { scrollWidth, clientWidth } = await scroller.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      expect(scrollWidth).toBeGreaterThan(clientWidth)
      await scroller.evaluate((el) => el.scrollBy({ left: el.clientWidth * 0.6, behavior: 'instant' as ScrollBehavior }))
      await page.waitForTimeout(400)
      const second = page.getByTestId(`crms-column-${bd.columns[1]!.id}`)
      const [sx, cx] = await Promise.all([scroller.evaluate((el) => el.getBoundingClientRect().left), second.evaluate((el) => el.getBoundingClientRect().left)])
      expect(Math.abs(cx - sx)).toBeLessThan(24)
    }
  })
})
