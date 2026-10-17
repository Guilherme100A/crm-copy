// AC-T90-01..04 — UI de produtos (/settings?tab=products) e fontes de venda (/settings?tab=sale_sources): modal com as
// regras de faixa/fallback do servidor, URL e segredo HMAC (mostrado uma vez) copiáveis, dry-run da amostra, rotação com
// confirmação, log de eventos com filtro e replay, layout sem rolagem horizontal. Contrato em spec/reports/T90-entrega.md.
// Eventos reais: POST público /api/hooks/sales/<token> (pelo proxy da web) processado pelo worker do harness
// (configureInboundSales). Massa pela API como owner; o seed não tem produtos nem fontes.
import { createHmac } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
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

interface Source {
  id: string
  name: string
  token: string
  public_url: string
}

const MAPPING = { external_id: '$.id', status: '$.status', amount: '$.amount', phone: '$.customer.phone' }

async function saleSource(page: Page, extra: Record<string, unknown> = {}): Promise<Source> {
  const body = await api(page, 'post', '/api/sale-sources', { name: `Loja ${uniq()}`, mapping: MAPPING, ...extra })
  return body.sale_source
}

async function product(page: Page, name = `Curso ${uniq()}`) {
  const body = await api(page, 'post', '/api/products', { name, currency: 'BRL', price_min_cents: 1000, price_max_cents: 50000, price_fallback_cents: 9700 })
  return body.product as { id: string; name: string }
}

const hookPath = (urlOrToken: string) => (urlOrToken.includes('/') ? new URL(urlOrToken).pathname : `/api/hooks/sales/${urlOrToken}`)

/** POST público na fonte (corpo cru; assinatura opcional em x-signature). */
async function fire(page: Page, url: string, payload: unknown, secret?: string) {
  const raw = JSON.stringify(payload)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret) headers['x-signature'] = createHmac('sha256', secret).update(raw).digest('hex')
  return page.request.post(hookPath(url), { data: raw, headers })
}

async function eventsOf(page: Page, id: string, status = ''): Promise<any[]> {
  const body = await api(page, 'get', `/api/sale-sources/${id}/events?limit=100${status ? `&status=${status}` : ''}`)
  return body.items ?? []
}

async function settled(page: Page, id: string, n: number) {
  await expect
    .poll(async () => {
      const items = await eventsOf(page, id)
      return items.length >= n && items.every((e) => e.status !== 'pending')
    }, { timeout: 30_000 })
    .toBe(true)
}

/** Abre a aba do hub (desktop: botão; mobile: select pesquisável) e espera o `?tab=` assentar. */
async function openTab(page: Page, tab: 'products' | 'sale_sources', testid: string) {
  await page.goto('/settings')
  await expect(page).toHaveURL(/\/settings/)
  if (isMobile(page)) {
    await page.getByTestId('settings-tab-select').click()
    await page.getByTestId(`settings-tab-option-${tab}`).click()
  } else {
    await page.getByTestId(`settings-tab-${tab}`).click()
  }
  await expect(page).toHaveURL(new RegExp(`[?&]tab=${tab}(&|$)`))
  await expect(page.getByTestId(testid)).toBeVisible()
}

async function openSource(page: Page, id: string) {
  await openTab(page, 'sale_sources', 'page-sale-sources')
  await page.getByTestId(`sale-sources-item-name-${id}`).click()
  await expect(page.getByTestId('sale-sources-detail')).toBeVisible()
}

test.describe('T90 — produtos', () => {
  test('AC-T90-01 tabela e modal: criar com "12,50", editar e excluir com confirmação', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'products', 'page-products')
    await expect(page.getByTestId('products-empty')).toContainText('Nenhum produto cadastrado.')

    await page.getByTestId('products-new').click()
    await expect(page.getByTestId('products-editor')).toBeVisible()
    const name = `Mentoria ${uniq()}`
    await page.getByTestId('products-name').fill(name)
    await expect(page.getByTestId('products-currency')).toHaveValue('BRL')
    await page.getByTestId('products-min').fill('12,50')
    await page.getByTestId('products-max').fill('1.299,90')
    await page.getByTestId('products-fallback').fill('97')
    // ajuda da regra de preço: fora da faixa usa o fallback, dentro usa o valor
    await expect(page.getByTestId('products-price-help')).toBeVisible()
    await page.getByTestId('products-simulate').fill('5')
    await expect(page.getByTestId('products-simulate-result')).toHaveAttribute('data-cents', '9700')
    await page.getByTestId('products-simulate').fill('100')
    await expect(page.getByTestId('products-simulate-result')).toHaveAttribute('data-cents', '10000')

    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/products')
    await page.getByTestId('products-save').click()
    const body = JSON.parse((await post).postData() ?? '{}')
    const sent = body.product ?? body
    expect(sent).toMatchObject({ name, currency: 'BRL', price_min_cents: 1250, price_max_cents: 129990, price_fallback_cents: 9700 })
    await expect(page.getByTestId('products-editor')).toHaveCount(0)

    const { items } = await api(page, 'get', `/api/products?search=${encodeURIComponent(name)}`)
    const p = items[0]
    expect(p).toMatchObject({ name, price_min_cents: 1250, price_max_cents: 129990, price_fallback_cents: 9700 })
    await expect(page.getByTestId('products-table')).toBeVisible()
    await expect(page.getByTestId(`products-item-name-${p.id}`)).toHaveText(name)
    await expect(page.getByTestId(`products-item-currency-${p.id}`)).toContainText('BRL')
    await expect(page.getByTestId(`products-item-min-${p.id}`)).toContainText('12,50')
    await expect(page.getByTestId(`products-item-max-${p.id}`)).toContainText('1.299,90')
    await expect(page.getByTestId(`products-item-fallback-${p.id}`)).toContainText('97,00')

    // editar
    await page.getByTestId(`products-item-edit-${p.id}`).click()
    await expect(page.getByTestId('products-min')).toHaveValue('12,50')
    await page.getByTestId('products-fallback').fill('49,90')
    const patch = page.waitForResponse((r) => ['PATCH', 'PUT'].includes(r.request().method()) && r.url().endsWith(`/api/products/${p.id}`))
    await page.getByTestId('products-save').click()
    expect((await patch).status()).toBe(200)
    await expect(page.getByTestId(`products-item-fallback-${p.id}`)).toContainText('49,90')

    // busca no servidor
    const other = await product(page, `Outro ${uniq()}`)
    await page.reload()
    await expect(page.getByTestId(`products-item-${other.id}`)).toBeVisible()
    await page.getByTestId('products-search').fill(name.slice(0, 12))
    await expect(page.getByTestId(`products-item-${other.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`products-item-${p.id}`)).toBeVisible()
    await page.getByTestId('products-search').fill('zzz-nada')
    await expect(page.getByTestId('products-empty')).toContainText('Nenhum produto encontrado.')
    await page.getByTestId('products-search').fill('')

    // excluir: cancelar mantém, confirmar remove
    await page.getByTestId(`products-item-delete-${p.id}`).click()
    await expect(page.getByTestId('products-confirm')).toBeVisible()
    await page.getByTestId('products-confirm-cancel').click()
    await expect(page.getByTestId(`products-item-${p.id}`)).toBeVisible()
    await page.getByTestId(`products-item-delete-${p.id}`).click()
    await page.getByTestId('products-confirm-ok').click()
    await expect(page.getByTestId(`products-item-${p.id}`)).toHaveCount(0)
    expect((await api(page, 'get', `/api/products?search=${encodeURIComponent(name)}`)).items).toHaveLength(0)
  })

  test('AC-T90-01 validações de faixa e fallback iguais às do servidor (bloqueia o envio)', async ({ page }) => {
    await loginAs(page, 'owner')
    // mensagens do servidor para os mesmos valores inválidos
    const res = await page.request.post('/api/products', {
      headers: XRW,
      data: { name: 'X', currency: 'BRL', price_min_cents: 5000, price_max_cents: 1000, price_fallback_cents: 0 },
    })
    expect(res.status()).toBe(422)
    const fields: { path: string; message: string }[] = (await res.json()).error?.details?.fields ?? (await res.json()).details?.fields
    const server = Object.fromEntries(fields.map((f) => [f.path, f.message]))
    expect(server.price_max_cents).toBe('O preço máximo deve ser maior ou igual ao mínimo')
    expect(server.price_fallback_cents).toBe('O valor padrão deve ser maior que zero')

    await openTab(page, 'products', 'page-products')
    const posts: string[] = []
    page.on('request', (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/products' && posts.push(r.url()))
    await page.getByTestId('products-new').click()
    await page.getByTestId('products-name').fill('X')
    await page.getByTestId('products-min').fill('50,00')
    await page.getByTestId('products-max').fill('10,00')
    await page.getByTestId('products-fallback').fill('0')
    await page.getByTestId('products-save').click()
    await expect(page.getByTestId('products-max-error')).toHaveText(server.price_max_cents)
    await expect(page.getByTestId('products-fallback-error')).toHaveText(server.price_fallback_cents)
    if (server.name) await expect(page.getByTestId('products-name-error')).toHaveText(server.name)
    await expect(page.getByTestId('products-editor')).toBeVisible()

    // valor mal formatado
    await page.getByTestId('products-min').fill('abc')
    await page.getByTestId('products-save').click()
    await expect(page.getByTestId('products-min-error')).toHaveText('Informe um valor válido (ex.: 12,50)')
    expect(posts, 'a validação do cliente deve bloquear o envio').toHaveLength(0)

    // máx = mín é aceito; fallback fora da faixa também (regra do servidor)
    await page.getByTestId('products-name').fill(`Igual ${uniq()}`)
    await page.getByTestId('products-min').fill('10,00')
    await page.getByTestId('products-max').fill('10,00')
    await page.getByTestId('products-fallback').fill('0,01')
    await expect(page.getByTestId('products-max-error')).toHaveCount(0)
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/products')
    await page.getByTestId('products-save').click()
    expect((await created).status()).toBe(201)
    await expect(page.getByTestId('products-editor')).toHaveCount(0)
  })

  test('AC-T90-01 erro 422 do servidor aparece no campo correspondente', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'products', 'page-products')
    await page.route('**/api/products', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 422,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos', details: { fields: [{ path: 'price_fallback_cents', message: 'O valor padrão deve ser maior que zero' }] } } }),
          })
        : route.fallback(),
    )
    await page.getByTestId('products-new').click()
    await page.getByTestId('products-name').fill(`Srv ${uniq()}`)
    await page.getByTestId('products-min').fill('1')
    await page.getByTestId('products-max').fill('2')
    await page.getByTestId('products-fallback').fill('1')
    await page.getByTestId('products-save').click()
    await expect(page.getByTestId('products-fallback-error')).toHaveText('O valor padrão deve ser maior que zero')
    await expect(page.getByTestId('products-editor')).toBeVisible()
  })
})

test.describe('T90 — fonte de venda', () => {
  test('AC-T90-02 criar com segredo: URL e segredo copiáveis, segredo mostrado uma vez e aceito no recebimento', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await loginAs(page, 'owner')
    await openTab(page, 'sale_sources', 'page-sale-sources')
    await expect(page.getByTestId('sale-sources-empty')).toBeVisible()
    await page.getByTestId('sale-sources-new').click()
    await expect(page.getByTestId('sale-sources-editor')).toBeVisible()
    await expect(page.getByTestId('sale-sources-create-hmac')).toBeChecked()
    const name = `Checkout ${uniq()}`
    await page.getByTestId('sale-sources-create-name').fill(name)
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sale-sources')
    await page.getByTestId('sale-sources-save').click()
    const created: Source & { hmac_configured: boolean } = (await (await post).json()).sale_source
    expect(created.hmac_configured).toBe(true)

    await expect(page.getByTestId('sale-sources-detail')).toBeVisible()
    await expect(page.getByTestId('sale-sources-detail-name')).toHaveText(name)
    const url = page.getByTestId('sale-sources-url')
    await expect(url).toHaveValue(created.public_url)
    expect(created.public_url).toMatch(/\/api\/hooks\/sales\/[A-Za-z0-9_-]{16,}$/)
    expect(await url.getAttribute('readonly')).not.toBeNull()
    await page.getByTestId('sale-sources-url-copy').click()
    await expect(page.getByTestId('sale-sources-url-copied').first()).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(created.public_url)

    await expect(page.getByTestId('sale-sources-secret-status')).toHaveAttribute('data-configured', 'true')
    await expect(page.getByTestId('sale-sources-secret-reveal')).toBeVisible()
    const secret = await page.getByTestId('sale-sources-secret').inputValue()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    await page.getByTestId('sale-sources-secret-copy').click()
    await expect(page.getByTestId('sale-sources-secret-copied').first()).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret)
    // o segredo nunca volta da API
    expect(JSON.stringify(await api(page, 'get', `/api/sale-sources/${created.id}`))).not.toContain(secret)

    // a assinatura da amostra mostrada na UI é o HMAC-SHA256 do corpo com o segredo
    const sample = '{"id":"ord-sig","status":"paid","amount":"10,00","customer":{"phone":"+5511999990009"}}'
    await page.getByTestId('sale-sources-sample').fill(sample)
    await expect(page.getByTestId('sale-sources-secret-signature')).toHaveText(createHmac('sha256', secret).update(sample).digest('hex'))

    // o segredo copiado é o que a fonte exige no recebimento
    expect((await fire(page, created.public_url, { id: 'x1', status: 'paid', amount: '1', customer: { phone: '+5511999990001' } })).status()).toBe(401)
    expect((await fire(page, created.public_url, { id: 'x2', status: 'paid', amount: '1', customer: { phone: '+5511999990001' } }, secret)).status()).toBe(202)

    // ao sair do detalhe o segredo some: só "configurado"
    await page.getByTestId('sale-sources-back').click()
    await expect(page.getByTestId(`sale-sources-item-hmac-${created.id}`)).toHaveAttribute('data-configured', 'true')
    await page.getByTestId(`sale-sources-item-name-${created.id}`).click()
    await expect(page.getByTestId('sale-sources-secret-status')).toHaveAttribute('data-configured', 'true')
    await expect(page.getByTestId('sale-sources-secret-reveal')).toHaveCount(0)
  })

  test('AC-T90-02 colar uma amostra mostra o SaleEvent resultante (dry-run, com produto e faltantes)', async ({ page }) => {
    await loginAs(page, 'owner')
    const prod = await product(page)
    const s = await saleSource(page)
    await openSource(page, s.id)

    // JSON inválido
    await page.getByTestId('sale-sources-sample').fill('{"id": ')
    await page.getByTestId('sale-sources-test').click()
    await expect(page.getByTestId('sale-sources-sample-error')).toBeVisible()

    // amostra válida: escolhe product_id pela árvore (folha → JSONPath)
    const sample = { id: 'ord-77', status: 'paid', amount: '199,90', customer: { phone: '+5511999990077' }, item: { pid: prod.id } }
    await page.getByTestId('sale-sources-sample').fill(JSON.stringify(sample))
    await expect(page.getByTestId('sale-sources-sample-error')).toHaveCount(0)
    await expect(page.getByTestId('sale-sources-json-tree')).toBeVisible()
    await page.getByTestId('sale-sources-sample-target').selectOption('product_id')
    await page.getByTestId('sale-sources-json-node-$.item.pid').click()
    await expect(page.getByTestId('sale-sources-map-product_id')).toHaveValue('$.item.pid')

    const dry = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/sale-sources/${s.id}/test`))
    await page.getByTestId('sale-sources-test').click()
    expect(JSON.parse((await dry).postData() ?? '{}').mapping?.product_id, 'testa o rascunho, não o salvo').toBe('$.item.pid')
    const result = page.getByTestId('sale-sources-test-result')
    await expect(result).toHaveAttribute('data-ok', 'true')
    await expect(page.getByTestId('sale-sources-test-event-external_id')).toHaveText('ord-77')
    await expect(page.getByTestId('sale-sources-test-event-status')).toHaveAttribute('data-status', 'approved')
    await expect(page.getByTestId('sale-sources-test-event-amount')).toHaveAttribute('data-cents', '19990')
    await expect(page.getByTestId('sale-sources-test-event-phone')).toContainText('5511999990077')
    await expect(page.getByTestId('sale-sources-test-event-product')).toContainText(prod.name)
    const event = JSON.parse((await page.getByTestId('sale-sources-test-event').textContent()) ?? '{}')
    expect(event).toMatchObject({ external_id: 'ord-77', status: 'approved', amount_cents: 19990, product_id: prod.id })
    // dry-run não grava nada
    expect(await eventsOf(page, s.id)).toHaveLength(0)
    expect((await api(page, 'get', `/api/sale-sources/${s.id}`)).sale_source.mapping.product_id).toBeUndefined()

    // amostra sem telefone: falha com o campo faltante
    await page.getByTestId('sale-sources-sample').fill(JSON.stringify({ id: 'ord-78', status: 'paid', amount: '10' }))
    await page.getByTestId('sale-sources-test').click()
    await expect(result).toHaveAttribute('data-ok', 'false')
    await expect(page.getByTestId('sale-sources-test-missing-phone')).toBeVisible()
  })

  test('AC-T90-02 rotacionar token pede confirmação; a URL antiga deixa de valer', async ({ page }) => {
    await loginAs(page, 'owner')
    const s = await saleSource(page)
    await openSource(page, s.id)
    const url = page.getByTestId('sale-sources-url')
    await expect(url).toHaveValue(s.public_url)
    await expect(page.getByTestId('sale-sources-secret-status')).toHaveAttribute('data-configured', 'false')

    const rotations: string[] = []
    page.on('request', (r) => r.method() === 'POST' && r.url().endsWith(`/api/sale-sources/${s.id}/rotate-token`) && rotations.push(r.url()))
    await page.getByTestId('sale-sources-rotate').click()
    await expect(page.getByTestId('sale-sources-rotate-confirm')).toBeVisible()
    await page.getByTestId('sale-sources-rotate-confirm-cancel').click()
    await expect(page.getByTestId('sale-sources-rotate-confirm')).toHaveCount(0)
    expect(rotations, 'cancelar não rotaciona').toHaveLength(0)
    await expect(url).toHaveValue(s.public_url)

    await page.getByTestId('sale-sources-rotate').click()
    await expect(page.getByTestId('sale-sources-rotate-secret')).toBeChecked()
    await page.getByTestId('sale-sources-rotate-confirm-ok').click()
    await expect(page.getByTestId('sale-sources-rotated').first()).toBeVisible()
    expect(rotations).toHaveLength(1)
    await expect(url).not.toHaveValue(s.public_url)
    const fresh = await url.inputValue()
    const now = (await api(page, 'get', `/api/sale-sources/${s.id}`)).sale_source
    expect(fresh).toBe(now.public_url)
    expect(now.hmac_configured).toBe(true)
    await expect(page.getByTestId('sale-sources-secret-status')).toHaveAttribute('data-configured', 'true')
    const secret = await page.getByTestId('sale-sources-secret').inputValue()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)

    const payload = { id: 'rot-1', status: 'paid', amount: '1', customer: { phone: '+5511999990002' } }
    expect((await fire(page, s.public_url, payload, secret)).status(), 'URL antiga').toBe(404)
    expect((await fire(page, fresh, payload, secret)).status()).toBe(202)
  })
})

test.describe('T90 — log de eventos', () => {
  test('AC-T90-03 log com filtro de status e reprocessar (relê o mapeamento atual)', async ({ page }) => {
    await loginAs(page, 'owner')
    const s = await saleSource(page)
    expect((await fire(page, s.public_url, { id: 'ord-1', status: 'paid', amount: '199,90', customer: { phone: '+5511999990001' } })).status()).toBe(202)
    expect((await fire(page, s.public_url, { id: 'ord-2', status: 'paid', amount: '50', telefone: '+5511999990003' })).status()).toBe(202)
    await settled(page, s.id, 2)
    const [ok] = await eventsOf(page, s.id, 'processed')
    const [bad] = await eventsOf(page, s.id, 'failed')
    expect(ok?.id && bad?.id, 'um processed e um failed reais').toBeTruthy()
    expect(bad.error).toContain('$.customer.phone')

    await openSource(page, s.id)
    const log = page.getByTestId('sale-events')
    await log.scrollIntoViewIfNeeded()
    await expect(page.getByTestId(`sale-events-item-${ok.id}`)).toHaveAttribute('data-status', 'processed')
    await expect(page.getByTestId(`sale-events-item-${bad.id}`)).toHaveAttribute('data-status', 'failed')
    await expect(page.getByTestId(`sale-events-item-error-${bad.id}`)).toContainText('customer.phone')
    await expect(page.getByTestId('sale-events-total')).toContainText('2')

    // detalhe do item
    await page.getByTestId(`sale-events-item-toggle-${bad.id}`).click()
    await expect(page.getByTestId(`sale-events-item-detail-${bad.id}`)).toBeVisible()
    await expect(page.getByTestId(`sale-events-item-body-${bad.id}`)).toContainText('ord-2')

    // filtro de status (no servidor, sem ?status= na URL)
    const urlBefore = page.url()
    const filtered = page.waitForRequest((r) => r.url().includes(`/api/sale-sources/${s.id}/events`) && r.url().includes('status=failed'))
    await page.getByTestId('sale-events-filter').selectOption('failed')
    await filtered
    await expect(page.getByTestId(`sale-events-item-${bad.id}`)).toBeVisible()
    await expect(page.getByTestId(`sale-events-item-${ok.id}`)).toHaveCount(0)
    await page.getByTestId('sale-events-filter').selectOption('processed')
    await expect(page.getByTestId(`sale-events-item-${ok.id}`)).toBeVisible()
    await expect(page.getByTestId(`sale-events-item-${bad.id}`)).toHaveCount(0)
    await page.getByTestId('sale-events-filter').selectOption('pending')
    await expect(page.getByTestId('sale-events-empty')).toContainText('Nenhum evento com este status.')
    expect(page.url()).toBe(urlBefore)
    await page.getByTestId('sale-events-filter').selectOption('')
    await expect(page.getByTestId(`sale-events-item-${ok.id}`)).toBeVisible()

    // reprocessar sem mudar o mapeamento: volta a failed com 2 tentativas
    const replay = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/sale-sources/${s.id}/events/${bad.id}/replay`))
    await page.getByTestId(`sale-events-item-replay-${bad.id}`).click()
    expect((await replay).status()).toBe(202)
    await expect(page.getByTestId('sale-events-replayed').first()).toBeVisible()
    await expect.poll(async () => (await eventsOf(page, s.id)).find((e) => e.id === bad.id)?.attempts, { timeout: 30_000 }).toBe(2)
    await expect(page.getByTestId(`sale-events-item-${bad.id}`)).toHaveAttribute('data-status', 'failed', { timeout: 20_000 })

    // corrige o telefone no mapeamento, salva e reprocessa: vira processed (a lista se atualiza sozinha)
    await page.getByTestId('sale-sources-map-phone').fill('$.telefone')
    const saved = page.waitForResponse((r) => ['PATCH', 'PUT'].includes(r.request().method()) && r.url().endsWith(`/api/sale-sources/${s.id}`))
    await page.getByTestId('sale-sources-save').click()
    expect((await saved).status()).toBe(200)
    await page.getByTestId(`sale-events-item-replay-${bad.id}`).click()
    await expect(page.getByTestId(`sale-events-item-${bad.id}`)).toHaveAttribute('data-status', 'processed', { timeout: 30_000 })
    const after = (await eventsOf(page, s.id)).find((e) => e.id === bad.id)
    expect(after).toMatchObject({ status: 'processed', attempts: 3 })
    expect(after.sale_id).toBeTruthy()
  })

  test('AC-T90-03 log vazio e member não reprocessa', async ({ page }) => {
    await loginAs(page, 'owner')
    const s = await saleSource(page)
    await openSource(page, s.id)
    await expect(page.getByTestId('sale-events-empty')).toContainText('Nenhum evento recebido.')
    await fire(page, s.public_url, { id: 'm-1', status: 'paid', amount: '1' })
    await settled(page, s.id, 1)
    const [ev] = await eventsOf(page, s.id)

    await page.context().clearCookies()
    await loginAs(page, 'member')
    await openSource(page, s.id)
    await expect(page.getByTestId(`sale-events-item-${ev.id}`)).toHaveAttribute('data-status', 'failed')
    await expect(page.getByTestId(`sale-events-item-replay-${ev.id}`)).toHaveCount(0)
    await expect(page.getByTestId('sale-sources-rotate')).toHaveCount(0)
  })
})

test.describe('T90 — layout', () => {
  test('AC-T90-04 mobile sem rolagem horizontal: produtos, fontes, detalhe e log', async ({ page }) => {
    await loginAs(page, 'owner')
    const long = `Produto com um nome bem comprido para testar quebra ${uniq()}`
    const prod = await product(page, long)
    const s = await saleSource(page, { name: `Fonte com nome comprido para o layout ${uniq()}` })
    await fire(page, s.public_url, { id: 'lay-1', status: 'paid', amount: '1', customer: { phone: '+5511999990004' }, extra: 'x'.repeat(300) })
    await fire(page, s.public_url, { id: 'lay-2', status: 'paid', amount: '1' })
    await settled(page, s.id, 2)

    await openTab(page, 'products', 'page-products')
    await expect(page.getByTestId(`products-item-${prod.id}`)).toBeVisible()
    if (isMobile(page)) {
      await expect(page.getByTestId('products-cards')).toBeVisible()
      await expect(page.getByTestId(`products-item-edit-${prod.id}`)).toBeVisible()
    }
    await expectNoHorizontalScroll(page)
    await page.getByTestId(`products-item-edit-${prod.id}`).click()
    await expect(page.getByTestId('products-editor')).toBeVisible()
    await page.getByTestId('products-simulate').fill('5')
    await expectNoHorizontalScroll(page)
    await page.getByTestId('products-cancel').click()

    await openTab(page, 'sale_sources', 'page-sale-sources')
    await expect(page.getByTestId(`sale-sources-item-${s.id}`)).toBeVisible()
    if (isMobile(page)) await expect(page.getByTestId('sale-sources-cards')).toBeVisible()
    await expectNoHorizontalScroll(page)

    await page.getByTestId(`sale-sources-item-edit-${s.id}`).click()
    await expect(page.getByTestId('sale-sources-detail')).toBeVisible()
    await page.getByTestId('sale-sources-secret-generate').click()
    await expect(page.getByTestId('sale-sources-secret-reveal')).toBeVisible()
    await page.getByTestId('sale-sources-sample').fill(JSON.stringify({ id: 'lay', status: 'paid', amount: '1', customer: { phone: '+5511999990004', email: 'cliente.com.email.bem.comprido@exemplo-dominio-longo.test' } }))
    await page.getByTestId('sale-sources-test').click()
    await expect(page.getByTestId('sale-sources-test-result')).toHaveAttribute('data-ok', 'true')
    await expectNoHorizontalScroll(page)

    const [ev] = await eventsOf(page, s.id, 'processed')
    await page.getByTestId(`sale-events-item-toggle-${ev.id}`).click()
    await expect(page.getByTestId(`sale-events-item-body-${ev.id}`)).toBeVisible()
    await page.getByTestId(`sale-events-item-body-${ev.id}`).scrollIntoViewIfNeeded()
    await expectNoHorizontalScroll(page)
  })
})
