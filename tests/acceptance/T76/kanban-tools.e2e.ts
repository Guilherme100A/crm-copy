// AC-T76-01..04 — ferramentas do kanban: modais de coluna e de card, filtros (etapa, data, etiquetas, responsável),
// estatísticas do funil acumulado e exportação por job. Contrato de data-testid combinado com o Torno.
import { expect, test, type Page, type Request } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { createConnection, newChat, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const SWATCHES = ['3b82f6', '8b5cf6', 'f59e0b', '10b981', 'ec4899', '06b6d4', 'f97316', '84cc16']

async function api(page: Page, method: 'get' | 'post' | 'patch', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

async function columnsOf(page: Page, crmId: string) {
  return ((await api(page, 'get', `/api/crms/${crmId}/columns`)).items as any[]).sort((a, b) => a.position - b.position)
}

/** Quadro novo; todas as colunas sem conversão, exceto as listadas. */
async function board(page: Page, conversionAt: number[] = []) {
  const body = await api(page, 'post', '/api/crms', { name: `Quadro ${uniq()}` })
  const id = (body.crm ?? body).id as string
  const cols = await columnsOf(page, id)
  for (const [i, c] of cols.entries()) await api(page, 'patch', `/api/crms/${id}/columns/${c.id}`, { conversion_goal: conversionAt.includes(i) })
  return { id, columns: await columnsOf(page, id) }
}

async function card(page: Page, crmId: string, chatId: string, columnId: string, valueCents = 0) {
  const body = await api(page, 'post', `/api/crms/${crmId}/cards`, { chat_id: chatId, column_id: columnId, value_cents: valueCents })
  return (body.card ?? body).id as string
}

const cardIdsIn = (page: Page, colId: string) =>
  page.getByTestId(`crms-column-cards-${colId}`).locator('[data-testid^="crms-card-"][data-column-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('crms-card-', '')))

const localDay = (offsetDays = 0) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86_400_000))
  return p // YYYY-MM-DD
}

test.describe('T76 — modais de coluna e card', () => {
  test('AC-T76-01 modal de coluna tem 8 cores + Automático e marcação de conversão (criar)', async ({ page }) => {
    await loginAs(page, 'owner')
    const bd = await board(page)
    await page.goto(`/crms/${bd.id}`)
    await page.getByTestId('crms-tools-add-column').click()
    const modal = page.getByTestId('kt-column-modal')
    await expect(modal).toBeVisible()
    await expect(modal.getByTestId('kt-column-color-auto')).toHaveAttribute('data-color', '')
    for (const hex of SWATCHES) await expect(modal.getByTestId(`kt-column-color-${hex}`)).toHaveAttribute('data-color', `#${hex.toUpperCase()}`)
    await expect(modal.locator('[data-testid^="kt-column-color-"]')).toHaveCount(9)

    await modal.getByTestId('kt-column-name').fill('Fechamento')
    await modal.getByTestId('kt-column-color-ec4899').click()
    await expect(modal.getByTestId('kt-column-color-ec4899')).toHaveAttribute('aria-checked', 'true')
    await modal.getByTestId('kt-column-conversion').check()
    await expect(modal.getByTestId('kt-column-preview')).toContainText('Fechamento')
    const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/crms/${bd.id}/columns`))
    await modal.getByTestId('kt-column-save').click()
    expect(JSON.parse((await post).postData() ?? '{}')).toMatchObject({ name: 'Fechamento', accent_color: '#EC4899', conversion_goal: true })
    await expect(modal).toBeHidden()
    const created = (await columnsOf(page, bd.id)).find((c) => c.name === 'Fechamento')
    expect(created).toMatchObject({ conversion_goal: true })
    await expect(page.getByTestId(`crms-column-${created.id}`)).toBeVisible()
  })

  test('AC-T76-01 editar coluna para "Automático" envia accent_color null; menu alterna conversão', async ({ page }) => {
    await loginAs(page, 'owner')
    const bd = await board(page)
    const col = bd.columns[0]
    await api(page, 'patch', `/api/crms/${bd.id}/columns/${col.id}`, { accent_color: '#10B981' })
    await page.goto(`/crms/${bd.id}`)
    await page.getByTestId(`crms-column-menu-${col.id}`).click()
    await page.getByTestId(`crms-column-menu-edit-${col.id}`).click()
    const modal = page.getByTestId('kt-column-modal')
    await expect(modal.getByTestId('kt-column-color-10b981')).toHaveAttribute('aria-checked', 'true')
    await modal.getByTestId('kt-column-color-auto').click()
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/crms/${bd.id}/columns/${col.id}`))
    await modal.getByTestId('kt-column-save').click()
    expect(JSON.parse((await patch).postData() ?? '{}').accent_color).toBeNull()

    await page.getByTestId(`crms-column-menu-${col.id}`).click()
    const toggle = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/crms/${bd.id}/columns/${col.id}`))
    await page.getByTestId(`crms-column-menu-conversion-${col.id}`).click()
    expect(JSON.parse((await toggle).postData() ?? '{}').conversion_goal).toBe(true)
    await expect.poll(async () => (await columnsOf(page, bd.id)).find((c) => c.id === col.id).conversion_goal).toBe(true)
  })

  test('AC-T76-01 modal de criar card busca chats paginados e cria o card na coluna', async ({ page }) => {
    test.setTimeout(240_000)
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chats: Array<{ id: string; phone: string }> = []
    for (let i = 0; i < 21; i++) chats.push(await newChat(page, conn.session_id))
    const bd = await board(page)
    const col = bd.columns[1]
    await page.goto(`/crms/${bd.id}`)
    await page.getByTestId(`crms-column-add-card-${col.id}`).click()
    const modal = page.getByTestId('kt-card-modal')
    await expect(modal).toBeVisible()
    const items = modal.locator('[data-testid^="kt-card-chat-"]')
    await expect.poll(() => items.count()).toBe(20)
    await expect(modal.getByTestId('kt-card-save')).toBeDisabled()
    await modal.getByTestId('kt-card-load-more').click()
    await expect.poll(() => items.count()).toBe(21)
    await expect(modal.getByTestId('kt-card-load-more')).toHaveCount(0)

    // busca pelo telefone de um chat
    const target = chats[7]!
    await modal.getByTestId('kt-card-search').fill(target.phone.slice(-6))
    await expect(modal.getByTestId(`kt-card-chat-${target.id}`)).toBeVisible()
    await expect.poll(() => items.count()).toBe(1)
    await modal.getByTestId('kt-card-search').fill('zzz-sem-resultado')
    await expect(modal.getByTestId('kt-card-no-results')).toBeVisible()
    await modal.getByTestId('kt-card-search').fill(target.phone.slice(-6))
    await modal.getByTestId(`kt-card-chat-${target.id}`).click()
    await expect(modal.getByTestId(`kt-card-chat-${target.id}`)).toHaveAttribute('aria-pressed', 'true')
    const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/crms/${bd.id}/cards`))
    await modal.getByTestId('kt-card-save').click()
    expect(JSON.parse((await post).postData() ?? '{}')).toMatchObject({ chat_id: target.id, column_id: col.id })
    await expect(modal).toBeHidden()
    await expect.poll(async () => (await cardIdsIn(page, col.id)).length).toBe(1)
  })

  test('AC-T76-01 sem chats disponíveis mostra "Todos os chats já possuem cartões"', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const chat = await newChat(page, conn.session_id)
    const bd = await board(page)
    await card(page, bd.id, chat.id, bd.columns[0].id)
    await page.goto(`/crms/${bd.id}`)
    await page.getByTestId(`crms-column-add-card-${bd.columns[0].id}`).click()
    await expect(page.getByTestId('kt-card-empty')).toHaveText(/Todos os chats já possuem cartões/)
    await expect(page.getByTestId('kt-card-save')).toBeDisabled()
  })
})

test.describe('T76 — filtros', () => {
  async function filled(page: Page) {
    const login = await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const bd = await board(page)
    const [c1, c2] = bd.columns
    const a = await newChat(page, conn.session_id)
    const b = await newChat(page, conn.session_id)
    const c = await newChat(page, conn.session_id)
    const ca = await card(page, bd.id, a.id, c1.id, 1_000)
    const cb = await card(page, bd.id, b.id, c1.id, 2_000)
    const cc = await card(page, bd.id, c.id, c2.id, 3_000)
    return { userId: login.user.id as string, bd, c1, c2, a, b, c, ca, cb, cc }
  }

  test('AC-T76-02 filtro de etapa carrega só aquela coluna (uma request) e vai para a URL', async ({ page }) => {
    const s = await filled(page)
    await page.goto(`/crms/${s.bd.id}`)
    await expect(page.getByTestId(`crms-column-${s.c1.id}`)).toBeVisible()
    await page.getByTestId('crms-tools-filters').click()
    await expect(page.getByTestId('kt-filters')).toBeVisible()
    await page.getByTestId('kt-filter-column').selectOption(s.c2.id)
    const cardReqs: Request[] = []
    page.on('request', (r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/crms/${s.bd.id}/cards` && cardReqs.push(r))
    await page.getByTestId('kt-filter-apply').click()
    await expect(page.getByTestId(`crms-column-${s.c1.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`crms-column-${s.c2.id}`)).toBeVisible()
    await expect.poll(() => cardIdsIn(page, s.c2.id)).toEqual([s.cc])
    await page.waitForTimeout(800)
    expect(cardReqs.length).toBe(1)
    expect(new URL(cardReqs[0]!.url()).searchParams.get('column_id')).toBe(s.c2.id)
    expect(new URL(page.url()).searchParams.get('column_id')).toBe(s.c2.id)
    for (const other of s.bd.columns.filter((c: any) => c.id !== s.c2.id)) await expect(page.getByTestId(`crms-column-${other.id}`)).toHaveCount(0)

    await page.reload()
    await expect(page.getByTestId(`crms-column-${s.c1.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`crms-column-${s.c2.id}`)).toBeVisible()
    await page.getByTestId('crms-tools-filters').click()
    await page.getByTestId('kt-filter-clear').click()
    await expect(page.getByTestId(`crms-column-${s.c1.id}`)).toBeVisible()
  })

  test('AC-T76-02 filtro de etiquetas aplica na hora e vai para a URL', async ({ page }) => {
    const s = await filled(page)
    const { label } = await api(page, 'post', '/api/labels', { name: `Quente ${uniq()}`, color: '#ef4444' })
    await api(page, 'post', `/api/chats/${s.b.id}/labels`, { label_id: label.id })
    await page.goto(`/crms/${s.bd.id}`)
    await page.getByTestId('crms-tools-filters').click()
    const chip = page.getByTestId(`kt-filter-label-${label.id}`)
    await chip.click()
    await expect(chip).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => cardIdsIn(page, s.c1.id)).toEqual([s.cb])
    await expect.poll(() => cardIdsIn(page, s.c2.id)).toEqual([])
    expect(new URL(page.url()).searchParams.get('label_ids')).toContain(label.id)
    await expect(page.getByTestId(`crms-column-count-${s.c1.id}`)).toHaveText(/\b1\b/)
  })

  test('AC-T76-02 filtro "atualizado em" e responsável', async ({ page }) => {
    const s = await filled(page)
    await api(page, 'post', `/api/chats/${s.a.id}/assign`, { user_id: s.userId })
    await page.goto(`/crms/${s.bd.id}`)
    await page.getByTestId('crms-tools-filters').click()

    // período sem atualizações (amanhã) → colunas vazias
    await page.getByTestId('kt-filter-from').fill(localDay(1))
    await page.getByTestId('kt-filter-to').fill(localDay(1))
    await page.getByTestId('kt-filter-apply').click()
    await expect(page.getByTestId(`crms-column-count-${s.c1.id}`)).toHaveText(/\b0\b/)
    expect(new URL(page.url()).searchParams.get('updated_from')).toBe(localDay(1))
    // hoje → todos voltam
    await page.getByTestId('kt-filter-from').fill(localDay(0))
    await page.getByTestId('kt-filter-to').fill(localDay(0))
    await page.getByTestId('kt-filter-apply').click()
    await expect(page.getByTestId(`crms-column-count-${s.c1.id}`)).toHaveText(/\b2\b/)

    // responsável: só o chat atribuído a mim
    await page.getByTestId('kt-filter-clear').click()
    await page.getByTestId('kt-filter-assigned').selectOption('me')
    const req = page.waitForRequest((r) => r.url().includes(`/api/crms/${s.bd.id}/cards`) && new URL(r.url()).searchParams.get('assigned_to') === 'me')
    await page.getByTestId('kt-filter-apply').click()
    await req
    await expect.poll(() => cardIdsIn(page, s.c1.id)).toEqual([s.ca])
    await expect.poll(() => cardIdsIn(page, s.c2.id)).toEqual([])
  })
})

test.describe('T76 — estatísticas', () => {
  test('AC-T76-03 painel de estatísticas mostra o funil acumulado e pode ser ocultado', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const bd = await board(page, [2])
    expect(bd.columns.length).toBeGreaterThanOrEqual(3)
    const [c1, c2, c3] = bd.columns
    // c1: 2 cards, c2: 1, c3 (conversão): 1 com R$ 1.000,00
    await card(page, bd.id, (await newChat(page, conn.session_id)).id, c1.id, 500)
    await card(page, bd.id, (await newChat(page, conn.session_id)).id, c1.id, 700)
    await card(page, bd.id, (await newChat(page, conn.session_id)).id, c2.id, 900)
    await card(page, bd.id, (await newChat(page, conn.session_id)).id, c3.id, 100_000)
    await page.goto(`/crms/${bd.id}`)

    const toggle = page.getByTestId('crms-tools-stats')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('kt-stats')).toHaveCount(0)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const stats = page.getByTestId('kt-stats')
    await expect(stats).toBeVisible()

    // acumulado: c1 = 4 (2+1+1), c2 = 2, c3 = 1
    await expect(stats.getByTestId(`kt-stats-stage-count-${c1.id}`)).toHaveText('4')
    await expect(stats.getByTestId(`kt-stats-stage-count-${c2.id}`)).toHaveText('2')
    await expect(stats.getByTestId(`kt-stats-stage-count-${c3.id}`)).toHaveText('1')
    await expect(stats.getByTestId(`kt-stats-stage-rate-${c1.id}`)).toHaveText('—')
    await expect(stats.getByTestId(`kt-stats-stage-rate-${c2.id}`)).toHaveText('50,0%')
    await expect(stats.getByTestId(`kt-stats-stage-rate-${c3.id}`)).toHaveText('50,0%')
    await expect(stats.getByTestId(`kt-stats-stage-percent-${c1.id}`)).toHaveText('100,0%')
    await expect(stats.getByTestId(`kt-stats-stage-percent-${c3.id}`)).toHaveText('25,0%')
    await expect(stats.getByTestId('kt-stats-total-leads')).toHaveText('4')
    await expect(stats.getByTestId('kt-stats-overall-rate')).toHaveText('25,00%')
    await expect(stats.getByTestId('kt-stats-purchases')).toHaveText('1')
    await expect(stats.getByTestId('kt-stats-revenue')).toHaveText('R$ 1.000,00')
    // etapas na ordem de posição
    const order = await stats.locator('[data-testid^="kt-stats-stage-"]:not([data-testid*="-count-"]):not([data-testid*="-rate-"]):not([data-testid*="-percent-"])').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')!.replace('kt-stats-stage-', '')),
    )
    expect(order.slice(0, 3)).toEqual([c1.id, c2.id, c3.id])

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('kt-stats')).toHaveCount(0)
  })
})

test.describe('T76 — exportação', () => {
  test('AC-T76-04 exportar gera o job com os filtros, mostra o progresso e oferece o download', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page)
    const bd = await board(page)
    const [c1, c2] = bd.columns
    const { label } = await api(page, 'post', '/api/labels', { name: `Exportar ${uniq()}`, color: '#22c55e' })
    const a = await newChat(page, conn.session_id)
    const b = await newChat(page, conn.session_id)
    await api(page, 'post', `/api/chats/${a.id}/labels`, { label_id: label.id })
    await api(page, 'post', `/api/chats/${b.id}/labels`, { label_id: label.id })
    await card(page, bd.id, a.id, c1.id, 150_050)
    await card(page, bd.id, b.id, c2.id, 0)
    await card(page, bd.id, (await newChat(page, conn.session_id)).id, c1.id, 999) // sem etiqueta: fora do filtro
    // na URL, label_ids é lista no formato do TanStack Router (JSON), como em /chats
    await page.goto(`/crms/${bd.id}?label_ids=${encodeURIComponent(JSON.stringify([label.id]))}`)
    await expect.poll(async () => (await cardIdsIn(page, c1.id)).length).toBe(1)

    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/jobs')
    await page.getByTestId('crms-tools-export').click()
    const body = JSON.parse((await post).postData() ?? '{}')
    expect(body.kind).toBe('kanban_cards')
    expect(body.filters.crm_id).toBe(bd.id)
    expect(body.filters.label_ids).toEqual([label.id])

    await expect(page.getByTestId('kt-export')).toBeVisible()
    await expect(page.getByTestId('kt-export-progress')).toBeVisible()
    const link = page.getByTestId('kt-export-download')
    await expect(link).toBeVisible({ timeout: 30_000 })
    const href = (await link.getAttribute('href'))!
    expect(href).toMatch(/^\/api\/jobs\/[^/]+\/file$/)
    await expect(link).toHaveAttribute('download', /.*/)

    const csv = await (await page.request.get(href)).text()
    const lines = csv.trim().split(/\r?\n/)
    expect(lines[0]).toBe('Nome,Telefone,Etapa,Valor,Moeda,Etiquetas,Atualizado em')
    expect(lines).toHaveLength(3) // cabeçalho + 2 cards com a etiqueta
    expect(csv).toContain('1500.50')
    expect(csv).toContain(label.name)
  })
})
