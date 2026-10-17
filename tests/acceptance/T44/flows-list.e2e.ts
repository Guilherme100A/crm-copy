// AC-T44-01..05 — lista de fluxos e pastas: cartões/tabela, busca, filtro (?flow_status), árvore + breadcrumb (?folder),
// arrastar (mover para pasta, reordenar, bloqueio de pasta em descendente), exclusão com impacto (force), compartilhar,
// importar vários códigos, estado vazio, member sem edição e mobile (cartões + sheet de pastas).
// Contrato de data-testid e search params: spec/reports/T44-entrega.md (Prumo).
import { expect, test, type Page } from '@playwright/test'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, data?: unknown) {
  const res =
    method === 'get'
      ? await page.request.get(path)
      : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

async function newFolder(page: Page, name: string, parentId?: string) {
  const body = await api(page, 'post', '/api/flow-folders', { name, ...(parentId ? { parent_id: parentId } : {}) })
  return body.folder as { id: string; name: string; parent_id: string | null }
}

async function newFlow(page: Page, name: string, folderId?: string) {
  const body = await api(page, 'post', '/api/flows', { name, ...(folderId ? { folder_id: folderId } : {}) })
  return body.flow as { id: string; name: string; folder_id: string | null; position: number }
}

const getFlow = async (page: Page, id: string) => {
  const body = await api(page, 'get', `/api/flows/${id}`)
  return (body.flow ?? body) as { id: string; folder_id: string | null; position: number }
}
const folderOf = async (page: Page, id: string) =>
  ((await api(page, 'get', '/api/flow-folders')).items as Array<{ id: string; parent_id: string | null }>).find(
    (f) => f.id === id,
  )

/** Ids dos fluxos na ordem em que aparecem na lista. */
const listedIds = (page: Page) =>
  page
    .locator('[data-testid^="flows-item-"][data-position]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('flows-item-', '')))

async function openFlows(page: Page, path = '/flows') {
  await page.goto(path)
  await expect(page.getByTestId('page-flows')).toBeVisible()
}

/** Arrasta pela alça: down, ≥10 px, vai até o alvo em passos, up (contrato do Prumo). */
async function drag(page: Page, handleTestId: string, targetTestId: string, checkOver?: string) {
  const a = (await page.getByTestId(handleTestId).boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 5 })
  const target = page.getByTestId(targetTestId)
  const b = (await target.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 })
  await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 2, { steps: 3 })
  if (checkOver) await expect(target).toHaveAttribute('data-over', checkOver)
  await page.mouse.up()
}

async function openItemMenu(page: Page, id: string) {
  await page.getByTestId(`flows-item-menu-${id}`).click()
}

test.describe('T44 — lista, busca, filtro e pastas', () => {
  test('AC-T44-01 /flows lista em cartões e em tabela (?view=table persiste ao recarregar), com paginação 20 por página', async ({
    page,
  }) => {
    await loginAs(page, 'owner')
    const ids: string[] = []
    for (let i = 1; i <= 21; i++) ids.push((await newFlow(page, `Fluxo ${String(i).padStart(2, '0')} ${uniq()}`)).id)

    await openFlows(page)
    await expect(page.getByTestId('flows-cards')).toBeVisible()
    await expect(page.getByTestId('flows-table')).toHaveCount(0)
    await expect(page.getByTestId('flows-view-cards')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId(`flows-item-${ids[0]}`)).toBeVisible()
    await expect(page.getByTestId(`flows-item-status-${ids[0]}`)).toHaveAttribute('data-status', 'draft')
    await expect(page.getByTestId(`flows-item-blocks-${ids[0]}`)).toHaveAttribute('data-count', /\d+/)
    await expect(page.getByTestId(`flows-item-updated-${ids[0]}`)).toHaveText(/Hoje, \d{2}:\d{2}/)
    await expect(page.getByTestId(`flows-item-name-${ids[0]}`)).toHaveAttribute('href', `/flows/${ids[0]}/edit`)

    await page.getByTestId('flows-view-table').click()
    await expect(page).toHaveURL(/[?&]view=table/)
    await expect(page.getByTestId('flows-table')).toBeVisible()
    await expect(page.getByTestId('flows-cards')).toHaveCount(0)
    await expect(page.getByTestId('flows-view-table')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('flows-page-range')).toHaveText('1–20 de 21')
    await expect(page.getByTestId('flows-table').locator('[data-testid^="flows-item-"][data-position]')).toHaveCount(20)
    await page.getByTestId('flows-page-next').click()
    await expect(page.getByTestId('flows-page-range')).toHaveText('21–21 de 21')
    await expect(page.getByTestId('flows-table').locator('[data-testid^="flows-item-"][data-position]')).toHaveCount(1)

    await page.reload()
    await expect(page.getByTestId('flows-table')).toBeVisible()
    await expect(page.getByTestId('flows-view-table')).toHaveAttribute('aria-pressed', 'true')

    await page.getByTestId('flows-view-cards').click()
    await expect(page).not.toHaveURL(/view=table/)
    await expect(page.getByTestId('flows-cards')).toBeVisible()
  })

  test('AC-T44-01 busca em todas as pastas sem acento/maiúsculas e filtro de status (?flow_status=) persiste ao recarregar', async ({
    page,
  }) => {
    await loginAs(page, 'owner')
    const pasta = await newFolder(page, `Pasta Vendas ${uniq()}`)
    const agil = await newFlow(page, `Atendimento Ágil ${uniq()}`, pasta.id)
    const outro = await newFlow(page, `Cobrança ${uniq()}`)
    const arq = await newFlow(page, `Antigo ${uniq()}`)
    await api(page, 'post', `/api/flows/${arq.id}/archive`)

    await openFlows(page)
    await expect(page.getByTestId(`flows-item-${outro.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-item-${agil.id}`)).toHaveCount(0) // está na pasta, não na raiz

    // busca: sem acento e em minúsculas, acha o fluxo dentro da pasta e mostra o nome da pasta
    await page.getByTestId('flows-search').fill('atendimento agil')
    await expect(page).toHaveURL(/[?&]q=atendimento/)
    await expect(page.getByTestId(`flows-item-${agil.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-item-${agil.id}`)).toContainText(pasta.name)
    await expect(page.getByTestId(`flows-item-${outro.id}`)).toHaveCount(0)
    await expect(page.getByTestId('flows-filters-clear')).toBeVisible()
    await page.getByTestId('flows-filters-clear').click()
    await expect(page).not.toHaveURL(/[?&]q=/)
    await expect(page.getByTestId(`flows-item-${outro.id}`)).toBeVisible()

    // filtro de status
    await page.getByTestId('flows-status-filter').selectOption('archived')
    await expect(page).toHaveURL(/[?&]flow_status=archived/)
    await expect(page.getByTestId(`flows-item-${arq.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-item-status-${arq.id}`)).toHaveAttribute('data-status', 'archived')
    await expect(page.getByTestId(`flows-item-${outro.id}`)).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('flows-status-filter')).toHaveValue('archived')
    await expect(page.getByTestId(`flows-item-${arq.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-item-${outro.id}`)).toHaveCount(0)

    await page.getByTestId('flows-status-filter').selectOption('active')
    await expect(page).toHaveURL(/[?&]flow_status=active/)
    await expect(page.getByTestId('flows-empty')).toContainText('Nenhum fluxo corresponde aos filtros')
    await expect(page.getByTestId('flows-empty-create')).toHaveCount(0)

    await page.getByTestId('flows-status-filter').selectOption('folders')
    await expect(page).toHaveURL(/[?&]flow_status=folders/)
    await expect(page.getByTestId(`flows-folder-card-${pasta.id}`)).toBeVisible()
    await expect(page.locator('[data-testid^="flows-item-"][data-position]')).toHaveCount(0)

    await page.getByTestId('flows-status-filter').selectOption('all')
    await expect(page).not.toHaveURL(/flow_status=/)
    await expect(page.getByTestId(`flows-item-${outro.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-item-${arq.id}`)).toBeVisible()
  })

  test('AC-T44-01 árvore de pastas e breadcrumb navegam por ?folder=, que sobrevive ao recarregar e ao Voltar', async ({
    page,
  }) => {
    await loginAs(page, 'owner')
    const a = await newFolder(page, `Pasta A ${uniq()}`)
    const b = await newFolder(page, `Pasta B ${uniq()}`, a.id)
    const naRaiz = await newFlow(page, `Raiz ${uniq()}`)
    const emA = await newFlow(page, `Em A ${uniq()}`, a.id)
    const emB = await newFlow(page, `Em B ${uniq()}`, b.id)

    await openFlows(page)
    const tree = page.getByTestId('flows-tree')
    await expect(tree).toBeVisible()
    await expect(page.getByTestId('flows-folder-root')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId(`flows-item-${naRaiz.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-folder-card-${a.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-folder-count-${a.id}`)).toHaveAttribute('data-flows', '1')
    await expect(page.getByTestId(`flows-folder-count-${a.id}`)).toHaveAttribute('data-folders', '1')

    // árvore → pasta A
    await page.getByTestId(`flows-folder-${a.id}`).click()
    await expect(page).toHaveURL(new RegExp(`[?&]folder=${a.id}`))
    await expect(page.getByTestId(`flows-folder-${a.id}`)).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId(`flows-item-${emA.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-item-${naRaiz.id}`)).toHaveCount(0)
    await expect(page.getByTestId('flows-breadcrumb')).toContainText(a.name)

    // card da subpasta B
    await page.getByTestId(`flows-folder-open-${b.id}`).click()
    await expect(page).toHaveURL(new RegExp(`[?&]folder=${b.id}`))
    await expect(page.getByTestId(`flows-item-${emB.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-item-${emA.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`flows-breadcrumb-${a.id}`)).toBeVisible()
    await expect(page.getByTestId('flows-breadcrumb')).toContainText(b.name)
    await expect(page.getByTestId(`flows-folder-${b.id}`)).toHaveAttribute('aria-current', 'page')

    await page.reload()
    await expect(page.getByTestId(`flows-item-${emB.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-folder-${b.id}`)).toHaveAttribute('aria-current', 'page')

    // Voltar do navegador (trocar de pasta faz push)
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`[?&]folder=${a.id}`))
    await expect(page.getByTestId(`flows-item-${emA.id}`)).toBeVisible()

    // breadcrumb → raiz
    await page.getByTestId(`flows-folder-open-${b.id}`).click()
    await expect(page).toHaveURL(new RegExp(`[?&]folder=${b.id}`))
    await page.getByTestId(`flows-breadcrumb-${a.id}`).click()
    await expect(page).toHaveURL(new RegExp(`[?&]folder=${a.id}`))
    await page.getByTestId('flows-breadcrumb-root').click()
    await expect(page).not.toHaveURL(new RegExp(a.id))
    await expect(page.getByTestId(`flows-item-${naRaiz.id}`)).toBeVisible()

    // pasta inexistente na URL
    await openFlows(page, '/flows?folder=00000000-0000-4000-8000-000000000000')
    await expect(page.getByTestId('flows-folder-missing')).toBeVisible()
  })
})

test.describe('T44 — arrastar', () => {
  test('AC-T44-02 arrastar um fluxo para uma pasta da árvore persiste após recarregar', async ({ page }) => {
    await loginAs(page, 'owner')
    const pasta = await newFolder(page, `Destino ${uniq()}`)
    const f = await newFlow(page, `Mover ${uniq()}`)
    await openFlows(page)
    await expect(page.getByTestId(`flows-item-${f.id}`)).toHaveAttribute('data-folder-id', 'root')

    await drag(page, `flows-item-handle-${f.id}`, `flows-folder-${pasta.id}`, 'true')
    await expect(page.getByTestId(`flows-item-${f.id}`)).toHaveCount(0)
    await expect.poll(async () => (await getFlow(page, f.id)).folder_id).toBe(pasta.id)

    await page.reload()
    await expect(page.getByTestId('page-flows')).toBeVisible()
    await expect(page.getByTestId(`flows-folder-count-${pasta.id}`)).toHaveAttribute('data-flows', '1')
    await expect(page.getByTestId(`flows-item-${f.id}`)).toHaveCount(0)
    await page.getByTestId(`flows-folder-${pasta.id}`).click()
    await expect(page).toHaveURL(new RegExp(`[?&]folder=${pasta.id}`))
    await expect(page.getByTestId(`flows-item-${f.id}`)).toHaveAttribute('data-folder-id', pasta.id)
  })

  test('AC-T44-02 arrastar um fluxo sobre outro reordena (fica antes do alvo) e a ordem persiste após recarregar', async ({
    page,
  }) => {
    await loginAs(page, 'owner')
    const f1 = await newFlow(page, `Um ${uniq()}`)
    const f2 = await newFlow(page, `Dois ${uniq()}`)
    const f3 = await newFlow(page, `Tres ${uniq()}`)
    await openFlows(page)
    await expect.poll(() => listedIds(page)).toEqual([f1.id, f2.id, f3.id])

    // arrastar o terceiro sobre o primeiro
    const a = (await page.getByTestId(`flows-item-handle-${f3.id}`).boundingBox())!
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 5 })
    const b = (await page.getByTestId(`flows-item-${f1.id}`).boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 })
    await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 2, { steps: 3 })
    await expect(page.getByTestId(`flows-item-${f1.id}`)).toHaveAttribute('data-over', 'true')
    await expect(page.getByTestId('flows-drop-hint')).toContainText('Solte aqui para reordenar')
    await page.mouse.up()

    await expect.poll(() => listedIds(page)).toEqual([f3.id, f1.id, f2.id])
    await expect
      .poll(async () => {
        const [p1, p2, p3] = await Promise.all([f1, f2, f3].map(async (f) => (await getFlow(page, f.id)).position))
        return p3 < p1 && p1 < p2
      })
      .toBe(true)

    await page.reload()
    await expect(page.getByTestId(`flows-item-${f3.id}`)).toBeVisible()
    await expect.poll(() => listedIds(page)).toEqual([f3.id, f1.id, f2.id])

    // zona de fim: o primeiro (f3) vai para o fim
    const h = (await page.getByTestId(`flows-item-handle-${f3.id}`).boundingBox())!
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
    await page.mouse.down()
    await page.mouse.move(h.x + h.width / 2 + 12, h.y + h.height / 2 + 12, { steps: 5 })
    const end = page.getByTestId('flows-drop-end')
    await expect(end).toBeVisible()
    const e = (await end.boundingBox())!
    await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2, { steps: 20 })
    await page.mouse.move(e.x + e.width / 2 + 2, e.y + e.height / 2 + 2, { steps: 3 })
    await page.mouse.up()
    await expect.poll(() => listedIds(page)).toEqual([f1.id, f2.id, f3.id])
    await page.reload()
    await expect(page.getByTestId(`flows-item-${f3.id}`)).toBeVisible()
    await expect.poll(() => listedIds(page)).toEqual([f1.id, f2.id, f3.id])
  })

  test('AC-T44-02 arrastar pasta para dentro de uma descendente é bloqueado; para outra pasta, move', async ({ page }) => {
    await loginAs(page, 'owner')
    const a = await newFolder(page, `Avo ${uniq()}`)
    const b = await newFolder(page, `Filha ${uniq()}`, a.id)
    const c = await newFolder(page, `Neta ${uniq()}`, b.id)
    const x = await newFolder(page, `Outra ${uniq()}`)
    await openFlows(page)
    await expect(page.getByTestId(`flows-folder-card-${a.id}`)).toBeVisible()
    // expande a árvore até a neta (navegar até ela abre o caminho)
    await openFlows(page, `/flows?folder=${b.id}`)
    await expect(page.getByTestId(`flows-folder-${c.id}`)).toBeVisible()
    await page.getByTestId('flows-breadcrumb-root').click()
    await expect(page).not.toHaveURL(/folder=/)
    await expect(page.getByTestId(`flows-folder-card-${a.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-folder-${c.id}`), 'a neta precisa estar visível na árvore').toBeVisible()

    const requests: string[] = []
    page.on('request', (r) => {
      if (r.method() !== 'GET' && r.url().includes('/api/flow-folders')) requests.push(`${r.method()} ${r.url()}`)
    })
    await drag(page, `flows-folder-handle-${a.id}`, `flows-folder-${c.id}`, 'blocked')
    await expect(page.getByTestId('flows-dnd-blocked')).toBeVisible()
    await expect(page.getByTestId('flows-dnd-blocked')).toContainText('subpasta')
    expect(requests, 'o bloqueio é no cliente: a API não é chamada').toEqual([])
    expect((await folderOf(page, a.id))?.parent_id).toBeNull()

    await page.reload()
    await expect(page.getByTestId(`flows-folder-card-${a.id}`)).toBeVisible()
    expect((await folderOf(page, a.id))?.parent_id).toBeNull()

    // caso válido: A para dentro de X
    await drag(page, `flows-folder-handle-${a.id}`, `flows-folder-card-${x.id}`, 'true')
    await expect.poll(async () => (await folderOf(page, a.id))?.parent_id).toBe(x.id)
    await page.reload()
    await expect(page.getByTestId(`flows-folder-card-${x.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-folder-card-${a.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`flows-folder-count-${x.id}`)).toHaveAttribute('data-folders', '1')
  })
})

test.describe('T44 — excluir, compartilhar e importar', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  test('AC-T44-03 excluir mostra o impacto (runs, configs, referências), Cancelar mantém e confirmar com force desvincula e exclui', async ({
    page,
  }) => {
    await loginAs(page, 'owner')
    const alvo = await newFlow(page, `Alvo ${uniq()}`)
    const chamador = await newFlow(page, `Chamador ${uniq()}`)
    await api(page, 'post', `/api/flows/${chamador.id}/nodes`, {
      id: 'j',
      type: 'connection_flow',
      position: { x: 0, y: 0 },
      actions: [{ type: 'execute_flow', config: { target_flow_id: alvo.id } }],
    })
    const conn = (await api(page, 'post', '/api/connections', { name: `Conexão ${uniq()}` })).connection
    await api(page, 'put', `/api/connection-flow-configs/${conn.id}`, { welcome_flow_id: alvo.id })

    await openFlows(page)
    await openItemMenu(page, alvo.id)
    await page.getByTestId(`flows-item-delete-${alvo.id}`).click()
    const dlg = page.getByTestId('flows-delete')
    await expect(dlg).toBeVisible()
    await expect(dlg.getByTestId('flows-delete-impact')).toBeVisible()
    await expect(dlg.getByTestId('flows-delete-impact-active-runs')).toHaveAttribute('data-count', '0')
    await expect(dlg.getByTestId('flows-delete-impact-total-runs')).toHaveAttribute('data-count', '0')
    await expect(dlg.getByTestId('flows-delete-impact-configs')).toHaveAttribute('data-count', '1')
    const cfg = dlg.locator('[data-testid^="flows-delete-impact-config-"]')
    await expect(cfg).toHaveCount(1)
    await expect(cfg).toHaveAttribute('data-kind', 'connection_flow_config')
    await expect(cfg).toContainText(conn.name)
    await expect(dlg.getByTestId('flows-delete-impact-refs')).toHaveAttribute('data-count', '1')
    await expect(dlg.getByTestId(`flows-delete-impact-ref-${chamador.id}`)).toContainText(chamador.name)
    await expect(dlg.getByTestId('flows-delete-force-warning')).toBeVisible()
    await expect(dlg.getByTestId('flows-delete-confirm')).toHaveAttribute('data-force', 'true')

    // Cancelar não exclui
    await dlg.getByTestId('flows-delete-cancel').click()
    await expect(dlg).toBeHidden()
    expect((await page.request.get(`/api/flows/${alvo.id}`)).status()).toBe(200)

    await openItemMenu(page, alvo.id)
    await page.getByTestId(`flows-item-delete-${alvo.id}`).click()
    await expect(dlg.getByTestId('flows-delete-impact-configs')).toHaveAttribute('data-count', '1')
    await dlg.getByTestId('flows-delete-confirm').click()
    await expect(dlg).toBeHidden()
    await expect(page.getByTestId(`flows-item-${alvo.id}`)).toHaveCount(0)
    expect((await page.request.get(`/api/flows/${alvo.id}`)).status()).toBe(404)
    const cfgNow = await api(page, 'get', `/api/connection-flow-configs/${conn.id}`)
    expect(JSON.stringify(cfgNow)).not.toContain(alvo.id)
    await page.reload()
    await expect(page.getByTestId(`flows-item-${chamador.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-item-${alvo.id}`)).toHaveCount(0)
  })

  test('AC-T44-03 excluir fluxo sem referências exige confirmação (sem force)', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page, `Simples ${uniq()}`)
    const fica = await newFlow(page, `Fica ${uniq()}`)
    await openFlows(page)
    await openItemMenu(page, f.id)
    await page.getByTestId(`flows-item-delete-${f.id}`).click()
    const dlg = page.getByTestId('flows-delete')
    await expect(dlg.getByTestId('flows-delete-impact')).toBeVisible()
    await expect(dlg.getByTestId('flows-delete-impact-configs')).toHaveAttribute('data-count', '0')
    await expect(dlg.getByTestId('flows-delete-impact-refs')).toHaveAttribute('data-count', '0')
    await expect(dlg.getByTestId('flows-delete-force-warning')).toHaveCount(0)
    await expect(page.getByTestId(`flows-item-${f.id}`)).toBeVisible() // nada some antes de confirmar
    await expect(dlg.getByTestId('flows-delete-confirm')).toHaveAttribute('data-force', 'false')
    await dlg.getByTestId('flows-delete-confirm').click()
    await expect(page.getByTestId(`flows-item-${f.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`flows-item-${fica.id}`)).toBeVisible()
    expect((await page.request.get(`/api/flows/${f.id}`)).status()).toBe(404)
  })

  test('AC-T44-03 compartilhar mostra o código copiável', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await newFlow(page, `Compartilhado ${uniq()}`)
    await openFlows(page)
    await openItemMenu(page, f.id)
    await page.getByTestId(`flows-item-share-${f.id}`).click()
    const dlg = page.getByTestId('flows-share')
    await expect(dlg).toBeVisible()
    const codeEl = dlg.getByTestId('flows-share-code')
    await expect(codeEl).toHaveText(/^\s*[A-HJ-NP-Z2-9]{10}\s*$/)
    const code = (await codeEl.textContent())!.trim()
    expect((await api(page, 'get', `/api/flows/${f.id}/share-code`)).code).toBe(code)
    await dlg.getByTestId('flows-share-copy').click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code)
    await dlg.getByTestId('flows-share-close').click()
    await expect(dlg).toBeHidden()
  })

  test('AC-T44-03 importar aceita vários códigos (vírgula, ponto e vírgula, quebra de linha; dedup) e mostra erro por código', async ({
    page,
  }) => {
    await loginAs(page, 'owner')
    const f1 = await newFlow(page, `Origem Um ${uniq()}`)
    const f2 = await newFlow(page, `Origem Dois ${uniq()}`)
    const c1 = (await api(page, 'get', `/api/flows/${f1.id}/share-code`)).code as string
    const c2 = (await api(page, 'get', `/api/flows/${f2.id}/share-code`)).code as string
    const invalid = c1 === 'ZZZZZZZZZ2' ? 'YYYYYYYYY3' : 'ZZZZZZZZZ2'
    const before = ((await api(page, 'get', '/api/flows')).items as unknown[]).length

    await openFlows(page)
    await page.getByTestId('flows-import').click()
    const dlg = page.getByTestId('flows-import-dialog')
    await expect(dlg).toBeVisible()
    await dlg.getByTestId('flows-import-codes').fill(`${c1}, ${c2};\n${invalid}\n${c1.toLowerCase()}`)
    await expect(dlg.getByTestId('flows-import-count')).toContainText('3')
    await dlg.getByTestId('flows-import-submit').click()
    await expect(dlg.getByTestId('flows-import-result')).toBeVisible()
    await expect(dlg.getByTestId(`flows-import-ok-${c1}`)).toBeVisible()
    await expect(dlg.getByTestId(`flows-import-ok-${c2}`)).toBeVisible()
    await expect(dlg.getByTestId(`flows-import-fail-${invalid}`)).toBeVisible()
    await dlg.getByTestId('flows-import-cancel').click()
    await expect(dlg).toBeHidden()

    await expect.poll(async () => ((await api(page, 'get', '/api/flows')).items as unknown[]).length).toBe(before + 2)
    await expect(page.locator('[data-testid^="flows-item-"][data-position]')).toHaveCount(before + 2)
  })
})

test.describe('T44 — vazio e permissões', () => {
  test('AC-T44-04 estado vazio mostra "Criar primeiro fluxo", que cria o fluxo e abre o editor', async ({ page }) => {
    await loginAs(page, 'owner')
    await openFlows(page)
    const empty = page.getByTestId('flows-empty')
    await expect(empty).toBeVisible()
    await expect(empty).toContainText('Nenhum fluxo encontrado')
    const create = page.getByTestId('flows-empty-create')
    await expect(create).toHaveText(/Criar primeiro fluxo/)
    await create.click()
    await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}\/edit/)
    const id = /\/flows\/([0-9a-f-]{36})\/edit/.exec(page.url())![1]
    const flow = await getFlow(page, id)
    expect(flow.folder_id).toBeNull()
    await openFlows(page)
    await expect(page.getByTestId(`flows-item-${id}`)).toBeVisible()
    await expect(page.getByTestId('flows-empty')).toHaveCount(0)
  })

  test('AC-T44-04 member (sem flows.edit) não vê ações de edição: criar, importar, pasta, alça, editar/excluir', async ({
    page,
  }) => {
    await loginAs(page, 'owner')
    const pasta = await newFolder(page, `Pasta ${uniq()}`)
    const f = await newFlow(page, `Leitura ${uniq()}`)
    await loginAs(page, 'member')

    await openFlows(page)
    await expect(page.getByTestId(`flows-item-${f.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-folder-card-${pasta.id}`)).toBeVisible()
    for (const id of ['flows-new', 'flows-import', 'flows-new-folder', `flows-item-handle-${f.id}`, `flows-folder-handle-${pasta.id}`])
      await expect(page.getByTestId(id), id).toHaveCount(0)
    await expect(page.getByTestId(`flows-item-name-${f.id}`)).toHaveAttribute('href', `/flows/${f.id}`)
    if (await page.getByTestId(`flows-folder-menu-${pasta.id}`).count()) {
      await page.getByTestId(`flows-folder-menu-${pasta.id}`).click()
      await expect(page.getByTestId(`flows-folder-edit-${pasta.id}`)).toHaveCount(0)
      await expect(page.getByTestId(`flows-folder-delete-${pasta.id}`)).toHaveCount(0)
      await page.keyboard.press('Escape')
    }

    await openItemMenu(page, f.id)
    await expect(page.getByTestId(`flows-item-open-${f.id}`)).toBeVisible()
    await expect(page.getByTestId(`flows-item-share-${f.id}`)).toBeVisible()
    for (const a of ['edit', 'rename', 'duplicate', 'activate', 'pause', 'archive', 'move', 'remove-folder', 'delete'])
      await expect(page.getByTestId(`flows-item-${a}-${f.id}`), a).toHaveCount(0)
    await page.keyboard.press('Escape')

    // a vista em tabela também não oferece edição
    await page.getByTestId('flows-view-table').click()
    await expect(page).toHaveURL(/view=table/)
    await expect(page.getByTestId('flows-table')).toBeVisible()
    await expect(page.getByTestId(`flows-item-handle-${f.id}`)).toHaveCount(0)

    // vazio sem flows.edit: sem "Criar primeiro fluxo"
    await openFlows(page, `/flows?folder=${pasta.id}`)
    await expect(page.getByTestId('flows-empty')).toBeVisible()
    await expect(page.getByTestId('flows-empty-create')).toHaveCount(0)
  })
})

test.describe('T44 — layout', () => {
  test('AC-T44-05 no mobile a lista vira cartões e a árvore fica num sheet, sem rolagem horizontal', async ({ page }) => {
    await loginAs(page, 'owner')
    const a = await newFolder(page, `Pasta com um nome bem comprido para testar a largura ${uniq()}`)
    const f = await newFlow(page, `Fluxo com um nome também bastante comprido para quebrar ${uniq()}`)
    const emA = await newFlow(page, `Em A ${uniq()}`, a.id)

    await openFlows(page, '/flows?view=table')
    await expect(page.getByTestId(`flows-item-${f.id}`)).toBeVisible()

    if (!isMobile(page)) {
      // desktop: tabela respeitada, árvore lateral visível e sem sheet
      await expect(page.getByTestId('flows-table')).toBeVisible()
      await expect(page.getByTestId('flows-tree')).toBeVisible()
      await expect(page.getByTestId('flows-tree-open')).toHaveCount(0)
      await expectNoHorizontalScroll(page)
      return
    }

    await expect(page.getByTestId('flows-cards')).toBeVisible()
    await expect(page.getByTestId('flows-table')).toHaveCount(0)
    await expect(page.getByTestId('flows-view-table')).toHaveCount(0)
    await expect(page.getByTestId('flows-view-cards')).toHaveCount(0)
    await expect(page.getByTestId('flows-tree')).toHaveCount(0)
    await expectNoHorizontalScroll(page)

    await page.getByTestId('flows-tree-open').click()
    const sheet = page.getByTestId('flows-tree-sheet')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByTestId('flows-tree')).toBeVisible()
    await expectNoHorizontalScroll(page)
    await sheet.getByTestId(`flows-folder-${a.id}`).click()
    await expect(sheet).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`[?&]folder=${a.id}`))
    await expect(page.getByTestId(`flows-item-${emA.id}`)).toBeVisible()
    await expect(page.getByTestId('flows-cards')).toBeVisible()
    await expectNoHorizontalScroll(page)

    await page.getByTestId('flows-tree-open').click()
    await expect(sheet).toBeVisible()
    await sheet.getByTestId('flows-tree-close').click()
    await expect(sheet).toBeHidden()
  })
})
