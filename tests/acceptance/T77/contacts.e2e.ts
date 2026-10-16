// AC-T77-01..05 — página de contatos (/customers): contagem "N"/"N+", busca com debounce de 500 ms, filtros com chips,
// seleção em massa (Shift+clique, "todos do filtro" com exclusões), barra de ações (excluir, disparo, exportar),
// "Importar do WhatsApp" só com conexão conectada, troca de empresa e cartões no mobile.
// Contrato de data-testid combinado com o Torno; massa pela API (T26/T66, etiquetas, conexões T40).
import { expect, test, type Page, type Request } from '@playwright/test'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed } from '../helpers/e2e'
import { createConnection, newPhone, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
interface Draft { open_create: boolean; mode: string; ids: string[]; except_ids: string[]; filters?: { label_ids?: string[] }; count: number }

/** Rascunho do disparo que a página de contatos passa no state do router. */
async function draftOf(page: Page): Promise<Draft> {
  const draft = await page.evaluate(() => (window.history.state as { massDispatchDraft?: Draft } | null)?.massDispatchDraft ?? null)
  expect(draft, 'history.state.massDispatchDraft ausente').not.toBeNull()
  return draft!
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'delete', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

async function label(page: Page, name = `Etiqueta ${uniq()}`) {
  return (await api(page, 'post', '/api/labels', { name, color: '#22c55e' })).label as { id: string; name: string }
}

async function contact(page: Page, name: string, extra: Record<string, unknown> = {}) {
  return (await api(page, 'post', '/api/contacts', { name, phone: `+${newPhone()}`, ...extra })).contact as { id: string; name: string }
}

async function contacts(page: Page, prefix: string, n: number, extra: Record<string, unknown> = {}) {
  const out: Array<{ id: string; name: string }> = []
  for (let i = 0; i < n; i++) out.push(await contact(page, `${prefix} ${String(i + 1).padStart(2, '0')}`, extra))
  return out
}

const totalOf = (body: Any): number | null => body.page?.total_count ?? body.pagination?.total_count ?? null

async function exists(page: Page, id: string) {
  return (await page.request.get(`/api/contacts/${id}`)).status() === 200
}

const isList = (r: Request) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/contacts'
const searchOf = (r: Request) => new URL(r.url()).searchParams.get('search')
const labelIdsOf = (r: Request) => {
  const p = new URL(r.url()).searchParams
  return [...p.getAll('label_ids'), ...p.getAll('label_ids[]')].flatMap((v) => v.split(',')).filter(Boolean)
}

async function openContacts(page: Page) {
  await page.goto('/customers')
  await expect(page.getByTestId('page-contacts')).toBeVisible()
  await expect(page.getByTestId('contacts-count')).toBeVisible()
}

/** Busca e espera a lista refletir o termo (só as linhas do prefixo). */
async function search(page: Page, term: string, expected: number) {
  const req = page.waitForRequest((r) => isList(r) && searchOf(r) === term)
  await page.getByTestId('contacts-search').fill(term)
  await req
  await expect(rows(page)).toHaveCount(expected)
}

/** Linhas (desktop) ou cartões (mobile) de contato visíveis, na ordem da tela. */
const rows = (page: Page) => page.locator('[data-testid^="contacts-row-"]').filter({ visible: true })
const rowIdOf = async (page: Page, i: number) => (await rows(page).nth(i).getAttribute('data-testid'))!.replace('contacts-row-', '')
const checkbox = (page: Page, id: string) => page.getByTestId(`contacts-select-${id}`).filter({ visible: true })

async function applyLabelFilter(page: Page, labelId: string) {
  await page.getByTestId('contacts-filters-open').click()
  await expect(page.getByTestId('contacts-filters-modal')).toBeVisible()
  await page.getByTestId(`contacts-filter-label-${labelId}`).check()
  const req = page.waitForRequest((r) => isList(r) && labelIdsOf(r).includes(labelId))
  await page.getByTestId('contacts-filters-apply').click()
  await req
  await expect(page.getByTestId('contacts-filters-modal')).toBeHidden()
  await expect(page.getByTestId(`contacts-chip-label-${labelId}`)).toBeVisible()
}

async function openSelectMenu(page: Page) {
  await page.getByTestId('contacts-select-menu-open').filter({ visible: true }).first().click()
  await expect(page.getByTestId('contacts-select-menu')).toBeVisible()
}

async function selectAllFromFilter(page: Page) {
  await openSelectMenu(page)
  await expect(page.getByTestId('contacts-select-all-account')).toHaveCount(0)
  const opt = page.getByTestId('contacts-select-all-filter')
  await expect(opt).toBeVisible()
  const text = (await opt.textContent()) ?? ''
  await opt.click()
  return text
}

/** Seletor de empresa (topo da sidebar no desktop; drawer no mobile), como na T36. */
async function switchCompany(page: Page, companyId: string) {
  if (isMobile(page) && !(await page.getByTestId('company-switcher-trigger').filter({ visible: true }).count())) {
    await page.getByTestId('shell-drawer-open').click()
  }
  const trigger = page.getByTestId('company-switcher-trigger').filter({ visible: true }).first()
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByTestId('company-switcher-popup')).toBeVisible()
  await page.getByTestId(`company-switcher-item-${companyId}`).click()
}

/**
 * Conexão "conectada" na UI. O harness não muda o estado da sessão do FakeWaGateway (o status fica `pending`), então a
 * lista real de GET /api/connections passa adiante com só esta conexão marcada `connected` (combinado com o Torno).
 */
async function markConnected(page: Page, connectionId: string) {
  await page.route(
    (url) => url.pathname === '/api/connections',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const res = await route.fetch()
      const body = await res.json()
      for (const c of body.items ?? []) if (c.id === connectionId) c.status = 'connected'
      await route.fulfill({ response: res, json: body })
    },
  )
}

test.describe('T77 — cabeçalho, busca e filtros', () => {
  test('AC-T77-01 cabeçalho mostra a contagem exata sem filtros', async ({ page }) => {
    await loginAs(page, 'owner')
    await contacts(page, `Conta ${uniq()}`, 3)
    const total = totalOf(await api(page, 'get', '/api/contacts?limit=1'))
    expect(total).not.toBeNull()
    await openContacts(page)
    await expect(page.getByTestId('contacts-count')).toHaveText(new RegExp(`(^|\\D)${total} contatos`))
  })

  test('AC-T77-01 com filtro ativo e total desconhecido o cabeçalho mostra "N+"', async ({ page }) => {
    await loginAs(page, 'owner')
    const lb = await label(page)
    await contacts(page, `Mais ${uniq()}`, 25, { label_ids: [lb.id] })
    await openContacts(page)
    const res = page.waitForResponse((r) => isList(r.request()) && labelIdsOf(r.request()).includes(lb.id))
    await applyLabelFilter(page, lb.id)
    // o servidor devolveu total_count null (skip_total_count enviado com filtro ativo) → "N+"
    expect(totalOf(await (await res).json())).toBeNull()
    await expect(page.getByTestId('contacts-count')).toHaveText(/\d+\+ contatos/)
  })

  test('AC-T77-01 busca espera 500 ms após a última tecla e faz uma só requisição', async ({ page }) => {
    await loginAs(page, 'owner')
    const prefix = `Busca${uniq()}`
    const [alvo] = await contacts(page, prefix, 2)
    await contact(page, `Outro ${uniq()}`)
    await openContacts(page)

    const searches: Array<{ term: string | null; at: number }> = []
    page.on('request', (r) => {
      if (isList(r) && searchOf(r)) searches.push({ term: searchOf(r), at: Date.now() })
    })
    const term = `${prefix} 01`
    await page.getByTestId('contacts-search').pressSequentially(term, { delay: 60 })
    const typedAt = Date.now()
    await expect.poll(() => searches.length, { timeout: 5_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(800)
    // nenhum termo parcial foi buscado; o termo final saiu uma vez, ~500 ms depois da última tecla
    expect(searches.map((s) => s.term)).toEqual([term])
    expect(searches[0]!.at - typedAt).toBeGreaterThanOrEqual(400)
    await expect(rows(page)).toHaveCount(1)
    await expect(page.getByTestId(`contacts-row-${alvo!.id}`).filter({ visible: true })).toBeVisible()

    // limpar a busca volta a lista completa
    const cleared = page.waitForRequest((r) => isList(r) && !searchOf(r))
    await page.getByTestId('contacts-search-clear').click()
    await cleared
    await expect(page.getByTestId('contacts-search')).toHaveValue('')
    await expect.poll(() => rows(page).count()).toBeGreaterThan(1)

    // termo só numérico com menos de 4 dígitos não dispara busca
    searches.length = 0
    await page.getByTestId('contacts-search').pressSequentially('123', { delay: 60 })
    await page.waitForTimeout(1_200)
    expect(searches.map((s) => s.term)).toEqual([])
  })

  test('AC-T77-01 filtros viram chips removíveis e "Limpar filtros" tira todos', async ({ page }) => {
    await loginAs(page, 'owner')
    const prefix = `Chip${uniq()}`
    const lb = await label(page)
    const [comEtiqueta] = await contacts(page, prefix, 1, { label_ids: [lb.id], custom_fields: { plano: 'Ouro Anual' } })
    const [semEtiqueta] = await contacts(page, `${prefix} sem`, 1)
    await openContacts(page)
    await search(page, prefix, 2)

    await applyLabelFilter(page, lb.id)
    await expect(rows(page)).toHaveCount(1)
    await expect(page.getByTestId(`contacts-row-${comEtiqueta!.id}`).filter({ visible: true })).toBeVisible()

    // remover o chip da etiqueta refaz a busca sem o filtro
    const semFiltro = page.waitForRequest((r) => isList(r) && labelIdsOf(r).length === 0 && searchOf(r) === prefix)
    await page.getByTestId(`contacts-chip-label-${lb.id}`).getByTestId('contacts-chip-remove').click()
    await semFiltro
    await expect(page.getByTestId(`contacts-chip-label-${lb.id}`)).toHaveCount(0)
    await expect(rows(page)).toHaveCount(2)
    await expect(page.getByTestId(`contacts-row-${semEtiqueta!.id}`).filter({ visible: true })).toBeVisible()

    // campo personalizado (busca parcial) + etiqueta → dois chips; "Limpar filtros" remove os dois
    await page.getByTestId('contacts-filters-open').click()
    await page.getByTestId('contacts-filter-custom-key').fill('plano')
    await page.getByTestId('contacts-filter-custom-value').fill('ouro')
    await page.getByTestId(`contacts-filter-label-${lb.id}`).check()
    const comCampo = page.waitForRequest((r) => isList(r) && new URL(r.url()).searchParams.get('custom_field_key') === 'plano')
    await page.getByTestId('contacts-filters-apply').click()
    expect(new URL((await comCampo).url()).searchParams.get('custom_field_value')).toBe('ouro')
    await expect(page.getByTestId('contacts-chip-custom-field')).toBeVisible()
    await expect(page.getByTestId(`contacts-chip-label-${lb.id}`)).toBeVisible()
    await expect(rows(page)).toHaveCount(1)

    const limpo = page.waitForRequest((r) => isList(r) && labelIdsOf(r).length === 0 && !new URL(r.url()).searchParams.get('custom_field_key'))
    await page.getByTestId('contacts-filters-clear').click()
    await limpo
    await expect(page.locator('[data-testid^="contacts-chip-"]').filter({ visible: true })).toHaveCount(0)
    await expect(rows(page)).toHaveCount(2)
  })
})

test.describe('T77 — seleção em massa', () => {
  test('AC-T77-02 Shift+clique seleciona o intervalo entre dois contatos', async ({ page }) => {
    await loginAs(page, 'owner')
    const prefix = `Shift${uniq()}`
    await contacts(page, prefix, 5)
    await openContacts(page)
    await search(page, prefix, 5)
    const ids = await Promise.all([0, 1, 2, 3, 4].map((i) => rowIdOf(page, i)))

    await checkbox(page, ids[0]!).click()
    await checkbox(page, ids[3]!).click({ modifiers: ['Shift'] })
    for (const id of ids.slice(0, 4)) await expect(checkbox(page, id)).toBeChecked()
    await expect(checkbox(page, ids[4]!)).not.toBeChecked()
    await expect(page.getByTestId('contacts-bulk-bar')).toBeVisible()
    await expect(page.getByTestId('contacts-bulk-count')).toHaveText(/(^|\D)4 selecionados/)
  })

  test('AC-T77-02 "Todos do filtro" mostra o total do filtro e desconta os excluídos', async ({ page }) => {
    await loginAs(page, 'owner')
    const lb = await label(page)
    await contacts(page, `Todos ${uniq()}`, 25, { label_ids: [lb.id] })
    await contacts(page, `Fora ${uniq()}`, 2)
    await openContacts(page)
    await applyLabelFilter(page, lb.id)

    const option = await selectAllFromFilter(page)
    expect(option).toMatch(/\(25\)/)
    await expect(page.getByTestId('contacts-bulk-count')).toHaveText(/(^|\D)25 selecionados/)

    // desmarcar dois contatos visíveis vira exclusão: 25 − 2
    const a = await rowIdOf(page, 0)
    const b = await rowIdOf(page, 1)
    await expect(checkbox(page, a)).toBeChecked()
    await checkbox(page, a).click()
    await checkbox(page, b).click()
    await expect(checkbox(page, a)).not.toBeChecked()
    await expect(page.getByTestId('contacts-bulk-count')).toHaveText(/(^|\D)23 selecionados/)
    // remarcar um deles devolve à contagem
    await checkbox(page, b).click()
    await expect(page.getByTestId('contacts-bulk-count')).toHaveText(/(^|\D)24 selecionados/)

    await page.getByTestId('contacts-bulk-clear').click()
    await expect(page.getByTestId('contacts-bulk-bar')).toBeHidden()
    await expect(checkbox(page, b)).not.toBeChecked()
  })
})

test.describe('T77 — seleção da conta', () => {
  test('AC-T77-02 sem filtro o menu oferece "Todos da conta" com o total da conta e descontos', async ({ page }) => {
    await loginAs(page, 'owner')
    await contacts(page, `Conta ${uniq()}`, 3)
    const total = totalOf(await api(page, 'get', '/api/contacts?limit=1')) as number
    await openContacts(page)
    await openSelectMenu(page)
    await expect(page.getByTestId('contacts-select-all-filter')).toHaveCount(0)
    await expect(page.getByTestId('contacts-select-all-account')).toContainText(`(${total})`)
    await page.getByTestId('contacts-select-all-account').click()
    await expect(page.getByTestId('contacts-bulk-count')).toHaveText(new RegExp(`(^|\\D)${total} selecionados`))
    await checkbox(page, await rowIdOf(page, 0)).click()
    await expect(page.getByTestId('contacts-bulk-count')).toHaveText(new RegExp(`(^|\\D)${total - 1} selecionados`))
  })
})

test.describe('T77 — barra de ações em massa', () => {
  test('AC-T77-03 "Exportar CSV" sem seleção exporta o filtro atual (modo filtered) com campos personalizados', async ({ page }) => {
    await loginAs(page, 'owner')
    const prefix = `ExpFiltro${uniq()}`
    await contacts(page, prefix, 2)
    await openContacts(page)
    await search(page, prefix, 2)
    await expect(page.getByTestId('contacts-bulk-bar')).toBeHidden()
    await page.getByTestId('contacts-export-csv').filter({ visible: true }).first().click()
    await expect(page.getByTestId('contacts-export-dialog')).toBeVisible()
    await page.getByTestId('contacts-export-custom-fields').check()
    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/contacts/exports')
    await page.getByTestId('contacts-export-confirm').click()
    const req = await post
    const body = req.postDataJSON()
    const payload = body.export ?? body
    expect(payload.mode).toBe('filtered')
    expect(payload.include_custom_fields).toBe(true)
    expect(payload.search ?? payload.filters?.search).toBe(prefix)
    expect((await req.response())?.status()).toBe(201)
  })

  test('AC-T77-03 excluir pede confirmação, mostra o progresso e remove só os selecionados', async ({ page }) => {
    await loginAs(page, 'owner')
    const prefix = `Excluir${uniq()}`
    const created = await contacts(page, prefix, 3)
    await openContacts(page)
    await search(page, prefix, 3)
    const keep = created[2]!
    const del = created.slice(0, 2)
    for (const c of del) await checkbox(page, c.id).click()
    await expect(page.getByTestId('contacts-bulk-count')).toHaveText(/(^|\D)2 selecionados/)

    await page.getByTestId('contacts-bulk-delete').click()
    const dialog = page.getByTestId('contacts-bulk-delete-dialog')
    await expect(dialog).toBeVisible()
    // nada é apagado antes de confirmar
    for (const c of del) expect(await exists(page, c.id)).toBe(true)

    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/contacts/bulk-deletes')
    await page.getByTestId('contacts-bulk-delete-confirm').click()
    const res = await (await post).response()
    expect(res?.status()).toBe(201)
    await expect(page.getByTestId('contacts-bulk-delete-progress').or(page.getByTestId('contacts-bulk-delete-done')).first()).toBeVisible()
    await expect(page.getByTestId('contacts-bulk-delete-done')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('contacts-bulk-delete-close').click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('contacts-bulk-bar')).toBeHidden()

    await expect.poll(async () => (await Promise.all(del.map((c) => exists(page, c.id)))).some(Boolean), { timeout: 30_000 }).toBe(false)
    expect(await exists(page, keep.id)).toBe(true)
    await expect(page.getByTestId(`contacts-row-${keep.id}`).filter({ visible: true })).toBeVisible()
    for (const c of del) await expect(page.getByTestId(`contacts-row-${c.id}`).filter({ visible: true })).toHaveCount(0)
  })

  test('AC-T77-03 exportar envia os ids selecionados (modo ids)', async ({ page }) => {
    await loginAs(page, 'owner')
    const prefix = `Export${uniq()}`
    const created = await contacts(page, prefix, 3)
    await openContacts(page)
    await search(page, prefix, 3)
    const chosen = created.slice(0, 2).map((c) => c.id)
    for (const id of chosen) await checkbox(page, id).click()

    await page.getByTestId('contacts-bulk-export').click()
    await expect(page.getByTestId('contacts-export-dialog')).toBeVisible()
    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/contacts/exports')
    await page.getByTestId('contacts-export-confirm').click()
    const req = await post
    const body = req.postDataJSON()
    const payload = body.export ?? body
    expect(payload.mode).toBe('ids')
    expect([...(payload.ids ?? payload.customer_ids ?? payload.contact_ids)].sort()).toEqual([...chosen].sort())
    expect((await req.response())?.status()).toBe(201)
  })

  test('AC-T77-03 exportar "todos do filtro" envia all_except com os excluídos e o filtro', async ({ page }) => {
    await loginAs(page, 'owner')
    const lb = await label(page)
    await contacts(page, `ExpTodos ${uniq()}`, 4, { label_ids: [lb.id] })
    await openContacts(page)
    await applyLabelFilter(page, lb.id)
    await selectAllFromFilter(page)
    const excluded = await rowIdOf(page, 0)
    await checkbox(page, excluded).click()
    await expect(page.getByTestId('contacts-bulk-count')).toHaveText(/(^|\D)3 selecionados/)

    await page.getByTestId('contacts-bulk-export').click()
    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/contacts/exports')
    await page.getByTestId('contacts-export-confirm').click()
    const body = (await post).postDataJSON()
    const payload = body.export ?? body
    expect(payload.mode).toBe('all_except')
    expect(payload.except_ids).toEqual([excluded])
    expect(JSON.stringify(payload.label_ids ?? payload.filters?.label_ids ?? [])).toContain(lb.id)
  })

  test('AC-T77-03 disparo em massa abre o wizard com os selecionados', async ({ page }) => {
    await loginAs(page, 'owner')
    const prefix = `Disparo${uniq()}`
    const created = await contacts(page, prefix, 3)
    await openContacts(page)
    await search(page, prefix, 3)
    const chosen = created.slice(0, 2).map((c) => c.id)
    for (const id of chosen) await checkbox(page, id).click()

    await page.getByTestId('contacts-bulk-dispatch').click()
    await expect(page).toHaveURL(/\/mass-dispatches(\/|\?|$)/)
    // a seleção segue para o wizard no estado da navegação
    const draft = await draftOf(page)
    expect(draft.open_create).toBe(true)
    expect(draft.mode).toBe('ids')
    expect([...draft.ids].sort()).toEqual([...chosen].sort())
    expect(draft.count).toBe(2)
  })

  test('AC-T77-03 disparo com "todos do filtro" leva all_except, os excluídos, o filtro e a contagem efetiva', async ({ page }) => {
    await loginAs(page, 'owner')
    const lb = await label(page)
    await contacts(page, `DispTodos ${uniq()}`, 4, { label_ids: [lb.id] })
    await openContacts(page)
    await applyLabelFilter(page, lb.id)
    await selectAllFromFilter(page)
    const excluded = await rowIdOf(page, 0)
    await checkbox(page, excluded).click()
    await expect(page.getByTestId('contacts-bulk-count')).toHaveText(/(^|\D)3 selecionados/)

    await page.getByTestId('contacts-bulk-dispatch').click()
    await expect(page).toHaveURL(/\/mass-dispatches(\/|\?|$)/)
    const draft = await draftOf(page)
    expect(draft.mode).toBe('all_except')
    expect(draft.except_ids).toEqual([excluded])
    expect(draft.filters?.label_ids).toContain(lb.id)
    expect(draft.count).toBe(3)
  })
})

test.describe('T77 — WhatsApp e troca de empresa', () => {
  test('AC-T77-04 "Importar do WhatsApp" só aparece com conexão conectada', async ({ page }) => {
    await loginAs(page, 'owner')
    await createConnection(page) // pendente: não conta
    await openContacts(page)
    await expect(page.getByTestId('contacts-count')).toBeVisible()
    await expect(page.getByTestId('contacts-import-whatsapp').filter({ visible: true })).toHaveCount(0)

    const conn = await createConnection(page)
    await markConnected(page, conn.id)
    await page.reload()
    await expect(page.getByTestId('page-contacts')).toBeVisible()
    await expect(page.getByTestId('contacts-import-whatsapp').filter({ visible: true })).toBeVisible()

    // confirmar importa pela conexão conectada
    await page.route('**/api/contacts/import-from-whatsapp', (route) => route.fulfill({ status: 200, json: { imported: 2, updated: 1, skipped: 0, warnings: [] } }))
    await page.getByTestId('contacts-import-whatsapp').filter({ visible: true }).click()
    await expect(page.getByTestId('contacts-import-whatsapp-dialog')).toBeVisible()
    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/contacts/import-from-whatsapp')
    await page.getByTestId('contacts-import-whatsapp-confirm').click()
    expect((await post).postDataJSON().connection_id).toBe(conn.id)
  })

  test('AC-T77-04 trocar de empresa limpa a seleção e os filtros', async ({ page }) => {
    await loginAs(page, 'owner')
    const other = (await api(page, 'post', '/api/companies', { name: `Filial ${uniq()}` })).company as { id: string }
    const lb = await label(page)
    await contacts(page, `Troca ${uniq()}`, 3, { label_ids: [lb.id] })
    await openContacts(page)
    await applyLabelFilter(page, lb.id)
    await checkbox(page, await rowIdOf(page, 0)).click()
    await expect(page.getByTestId('contacts-bulk-bar')).toBeVisible()

    const reload = page.waitForRequest((r) => isList(r) && r.headers()['x-company-id'] === other.id)
    await switchCompany(page, other.id)
    const req = await reload
    expect(labelIdsOf(req)).toEqual([])
    await expect(page.getByTestId('contacts-bulk-bar')).toBeHidden()
    await expect(page.locator('[data-testid^="contacts-chip-"]').filter({ visible: true })).toHaveCount(0)
    await expect(page.getByTestId('contacts-search')).toHaveValue('')
    await expect(rows(page)).toHaveCount(0)
  })
})

test.describe('T77 — layout', () => {
  test('AC-T77-05 no mobile a tabela vira cartões e a seleção continua funcionando', async ({ page }) => {
    await loginAs(page, 'owner')
    const prefix = `Cartao${uniq()}`
    const created = await contacts(page, prefix, 3)
    await openContacts(page)
    await search(page, prefix, 3)
    if (isMobile(page)) {
      await expect(page.getByTestId('contacts-cards')).toBeVisible()
      await expect(page.getByTestId('contacts-table')).toBeHidden()
      await expectNoHorizontalScroll(page)
    } else {
      await expect(page.getByTestId('contacts-table')).toBeVisible()
    }
    await checkbox(page, created[0]!.id).click()
    await checkbox(page, created[1]!.id).click()
    await expect(checkbox(page, created[0]!.id)).toBeChecked()
    await expect(page.getByTestId('contacts-bulk-bar')).toBeVisible()
    await expect(page.getByTestId('contacts-bulk-count')).toHaveText(/(^|\D)2 selecionados/)
    await expect(page.getByTestId('contacts-bulk-delete')).toBeVisible()
    await expect(page.getByTestId('contacts-bulk-dispatch')).toBeVisible()
    await expect(page.getByTestId('contacts-bulk-export')).toBeVisible()
    if (isMobile(page)) await expectNoHorizontalScroll(page)
  })
})
