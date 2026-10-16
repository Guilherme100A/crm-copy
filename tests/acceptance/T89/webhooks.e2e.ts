// AC-T89-01..04 — UI de webhooks de entrada: lista/busca/consumo e formulário com URL copiável, escuta de exemplo
// (SSE webhook.sample_received, expiração por relógio), árvore JSON e mapeamento com literais, histórico.
// Contrato de data-testid combinado com o Torno; massa pela API (T72/T81) e POST público /api/hooks/in/:token.
import { expect, test, type Page, type Request } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { trackSse, waitSseOpen, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'patch', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

interface Hook {
  id: string
  name: string
  url: string
  path: string
}

async function webhook(page: Page, name = `Hook ${uniq()}`, extra: Record<string, unknown> = {}): Promise<Hook> {
  const body = await api(page, 'post', '/api/inbound-webhooks', { name, active: true, ...extra })
  const w = body.webhook ?? body
  const url = w.public_receive_url as string
  return { id: w.id, name, url, path: new URL(url).pathname }
}

/** POST público no webhook (pelo proxy da web) e espera o processamento sair de pending. */
async function fire(page: Page, h: Hook, payload: unknown) {
  const res = await page.request.post(h.path, { data: payload })
  expect(res.status(), await res.text()).toBe(202)
}

async function requestsOf(page: Page, id: string): Promise<any[]> {
  const body = await api(page, 'get', `/api/inbound-webhooks/${id}/requests?page=1&limit=50`)
  return body.items ?? []
}

async function settled(page: Page, id: string, n: number) {
  await expect
    .poll(async () => {
      const items = await requestsOf(page, id)
      return items.length >= n && items.every((r) => r.processing_status && r.processing_status !== 'pending')
    }, { timeout: 30_000 })
    .toBe(true)
}

const seg = (path: string) => [{ kind: 'path', value: path }]

test.describe('T89 — lista e formulário', () => {
  test('AC-T89-01 lista mostra disparos no mês e busca local por nome', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const a = await webhook(page, `Loja Hotmart ${tag}`)
    const b = await webhook(page, `Formulário Site ${tag}`)
    for (let i = 0; i < 3; i++) await fire(page, a, { pedido: `P-${i}` })
    await settled(page, a.id, 3)

    await page.goto('/settings/inbound-webhooks')
    await expect(page.getByTestId('page-inbound-webhooks')).toBeVisible()
    await expect(page.getByTestId(`webhooks-item-month-${a.id}`)).toHaveText(/\b3\b/)
    await expect(page.getByTestId(`webhooks-item-month-${b.id}`)).toHaveText(/\b0\b/)
    await expect(page.getByTestId(`webhooks-item-status-${a.id}`)).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('webhooks-usage')).toContainText('Consumo')

    const calls: Request[] = []
    page.on('request', (r) => new URL(r.url()).pathname.startsWith('/api/inbound-webhooks') && calls.push(r))
    await page.getByTestId('webhooks-search').fill('hotmart')
    await expect(page.getByTestId(`webhooks-item-${a.id}`)).toBeVisible()
    await expect(page.getByTestId(`webhooks-item-${b.id}`)).toHaveCount(0)
    expect(calls, 'busca deve ser local').toHaveLength(0)
  })

  test('AC-T89-01 criar e editar com URL copiável', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await loginAs(page, 'owner')
    await page.goto('/settings/inbound-webhooks')
    await page.getByTestId('webhooks-new').click()
    await expect(page).toHaveURL(/\/settings\/inbound-webhooks\/new/)
    const name = `Novo ${uniq()}`
    await page.getByTestId('webhook-form-name').fill(name)
    await page.getByTestId('webhook-form-active').check()
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/inbound-webhooks')
    await page.getByTestId('webhook-form-save').click()
    const created = (await (await post).json()).webhook
    await expect(page).toHaveURL(new RegExp(`/settings/inbound-webhooks/${created.id}/edit`))

    const url = page.getByTestId('webhook-url')
    await expect(url).toHaveValue(/\/api\/hooks\/in\/[A-Za-z0-9_-]{20,}$/)
    expect(await url.getAttribute('readonly')).not.toBeNull()
    const value = await url.inputValue()
    await page.getByTestId('webhook-url-copy').click()
    await expect(page.getByTestId('webhook-url-copied')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value)

    await page.getByTestId('webhook-form-name').fill(`${name} editado`)
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/inbound-webhooks/${created.id}`))
    await page.getByTestId('webhook-form-save').click()
    expect(JSON.parse((await patch).postData() ?? '{}').name).toBe(`${name} editado`)
    await page.goto('/settings/inbound-webhooks')
    await expect(page.getByTestId(`webhooks-item-name-${created.id}`)).toHaveText(`${name} editado`)

    // excluir com confirmação
    await page.getByTestId(`webhooks-item-delete-${created.id}`).click()
    await expect(page.getByTestId('webhooks-confirm')).toBeVisible()
    await page.getByTestId('webhooks-confirm-ok').click()
    await expect(page.getByTestId(`webhooks-item-${created.id}`)).toHaveCount(0)
  })
})

test.describe('T89 — escutar exemplo', () => {
  test('AC-T89-02 escutar fica em listening e mostra o corpo recebido pelo SSE', async ({ page }) => {
    await loginAs(page, 'owner')
    const h = await webhook(page)
    await trackSse(page)
    await page.goto(`/settings/inbound-webhooks/${h.id}/edit`)
    await waitSseOpen(page)
    const panel = page.getByTestId('webhook-sample')
    await expect(panel).toHaveAttribute('data-state', 'idle')
    const listen = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/inbound-webhooks/${h.id}/sample-listen`))
    await page.getByTestId('webhook-listen').click()
    await listen
    await expect(panel).toHaveAttribute('data-state', 'listening')
    await expect(page.getByTestId('webhook-listen-countdown')).toHaveText(/^(90|89|88|87)s$/)

    await fire(page, h, { cliente: { nome: 'Rita Alves', fone: '11988887777' }, valor: 197 })
    await expect(panel).toHaveAttribute('data-state', 'received', { timeout: 20_000 })
    const body = page.getByTestId('webhook-sample-body')
    await expect(body).toContainText('Rita Alves')
    await expect(body).toContainText('"valor": 197')
  })

  test('AC-T89-02 a escuta expira em 90 s com mensagem', async ({ page }) => {
    await loginAs(page, 'owner')
    const h = await webhook(page)
    await page.clock.install()
    await page.goto(`/settings/inbound-webhooks/${h.id}/edit`)
    await page.getByTestId('webhook-listen').click()
    const panel = page.getByTestId('webhook-sample')
    await expect(panel).toHaveAttribute('data-state', 'listening')
    await page.clock.fastForward(60_000)
    await expect(panel).toHaveAttribute('data-state', 'listening')
    await expect(page.getByTestId('webhook-listen-countdown')).toHaveText(/^(30|29|28|31)s$/)
    await page.clock.fastForward(31_000)
    await expect(panel).toHaveAttribute('data-state', 'expired')
    await expect(page.getByTestId('webhook-sample-expired')).toBeVisible()
  })

  test('AC-T89-02 cancelar a escuta volta para idle', async ({ page }) => {
    await loginAs(page, 'owner')
    const h = await webhook(page)
    await page.goto(`/settings/inbound-webhooks/${h.id}/edit`)
    await page.getByTestId('webhook-listen').click()
    await expect(page.getByTestId('webhook-sample')).toHaveAttribute('data-state', 'listening')
    const del = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().endsWith(`/api/inbound-webhooks/${h.id}/sample-listen`))
    await page.getByTestId('webhook-listen-cancel').click()
    await del
    await expect(page.getByTestId('webhook-sample')).toHaveAttribute('data-state', 'idle')
  })
})

test.describe('T89 — árvore e mapeamento', () => {
  const SAMPLE = { contact: { name: 'Ana Lima', phone: '11999998888' }, items: [{ sku: 'A1' }] }

  test('AC-T89-03 clicar num campo da árvore mapeia ao destino; literais concatenam; salvar envia o config', async ({ page }) => {
    await loginAs(page, 'owner')
    const h = await webhook(page)
    await fire(page, h, SAMPLE)
    await settled(page, h.id, 1)
    await page.goto(`/settings/inbound-webhooks/${h.id}/edit`)
    await expect(page.getByTestId('webhook-sample-body')).toContainText('Ana Lima')

    // telefone = '+55' + contact.phone
    await page.getByTestId('webhook-map-target-phone').click()
    await expect(page.getByTestId('webhook-map-target-phone')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('webhook-map-literal-phone').fill('+55')
    await page.getByTestId('webhook-map-literal-add-phone').click()
    await page.getByTestId('webhook-json-node-contact.phone').click()
    await expect(page.getByTestId('webhook-map-segment-phone-0')).toHaveAttribute('data-kind', 'literal')
    await expect(page.getByTestId('webhook-map-segment-phone-1')).toHaveAttribute('data-kind', 'path')
    await expect(page.getByTestId('webhook-map-preview-phone')).toHaveText('+5511999998888')
    await expect(page.getByTestId('webhook-map-warning-phone')).toHaveCount(0)

    // nome = contact.name
    await page.getByTestId('webhook-map-target-full_name').click()
    await page.getByTestId('webhook-json-node-contact.name').click()
    await expect(page.getByTestId('webhook-map-preview-full_name')).toHaveText('Ana Lima')

    // campo personalizado sku = items.0.sku
    await page.getByTestId('webhook-map-custom-key').fill('sku')
    await page.getByTestId('webhook-map-custom-add').click()
    await page.getByTestId('webhook-map-target-custom:sku').click()
    await page.getByTestId('webhook-json-node-items.0.sku').click()
    await expect(page.getByTestId('webhook-map-preview-custom:sku')).toHaveText('A1')

    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/inbound-webhooks/${h.id}`))
    await page.getByTestId('webhook-config-save').click()
    const cfg = JSON.parse((await patch).postData() ?? '{}').config
    expect(cfg.field_paths.phone).toEqual([
      { kind: 'literal', value: '+55' },
      { kind: 'path', value: 'contact.phone' },
    ])
    expect(cfg.field_paths.full_name).toEqual(seg('contact.name'))
    expect(cfg.custom_field_mappings).toEqual(expect.arrayContaining([{ field_key: 'sku', segments: seg('items.0.sku') }]))
    await expect(page.getByTestId('webhook-config-saved')).toBeVisible()

    // remover segmento atualiza a prévia
    await page.getByTestId('webhook-map-target-phone').click()
    await page.getByTestId('webhook-map-segment-remove-phone-0').click()
    await expect(page.getByTestId('webhook-map-preview-phone')).toHaveText('11999998888')
  })

  test('AC-T89-03 aviso quando o campo de identidade tem literal sem caminho garantido', async ({ page }) => {
    await loginAs(page, 'owner')
    const h = await webhook(page)
    await fire(page, h, SAMPLE)
    await settled(page, h.id, 1)
    await page.goto(`/settings/inbound-webhooks/${h.id}/edit`)
    await page.getByTestId('webhook-map-target-phone').click()
    await page.getByTestId('webhook-map-literal-phone').fill('+55')
    await page.getByTestId('webhook-map-literal-add-phone').click()
    await expect(page.getByTestId('webhook-map-warning-phone')).toBeVisible()
    await page.getByTestId('webhook-json-node-contact.phone').click()
    await expect(page.getByTestId('webhook-map-warning-phone')).toHaveCount(0)
  })
})

test.describe('T89 — histórico', () => {
  test('AC-T89-04 aba Histórico com estatísticas, filtro de status e JSON formatado de cada request', async ({ page }) => {
    await loginAs(page, 'owner')
    const h = await webhook(page)
    await api(page, 'patch', `/api/inbound-webhooks/${h.id}`, {
      config: { field_paths: { full_name: seg('nome'), phone: seg('fone') }, custom_field_mappings: [] },
    })
    const ok = { nome: 'Bruno Dias', fone: '+5511977776666', pedido: 'X-1' }
    await fire(page, h, ok) // processed
    await fire(page, h, { nome: 'Sem Telefone' }) // failed (missing_required_fields)
    await fire(page, h, ok) // skipped (duplicate_payload)
    await settled(page, h.id, 3)
    const items = await requestsOf(page, h.id)
    const byStatus = (s: string) => items.filter((r) => r.processing_status === s)
    expect(items.map((r) => r.processing_status).sort()).toEqual(['failed', 'processed', 'skipped'])

    await page.goto(`/settings/inbound-webhooks/${h.id}/edit?tab=history`)
    await expect(page.getByTestId('webhook-tab-history')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('webhook-stats-total')).toContainText('3')
    await expect(page.getByTestId('webhook-stats-processed')).toContainText('1')
    await expect(page.getByTestId('webhook-stats-failed')).toContainText('1')
    await expect(page.getByTestId('webhook-stats-skipped')).toContainText('1')

    const failed = byStatus('failed')[0]
    await page.getByTestId('webhook-history-filter').selectOption('failed')
    await expect(page.locator('[data-testid^="webhook-request-"][data-status]')).toHaveCount(1)
    await expect(page.getByTestId(`webhook-request-${failed.id}`)).toHaveAttribute('data-status', 'failed')
    await expect(page.getByTestId(`webhook-request-reason-${failed.id}`)).not.toBeEmpty()
    await page.getByTestId('webhook-history-filter').selectOption('')
    await expect(page.locator('[data-testid^="webhook-request-"][data-status]')).toHaveCount(3)

    const processed = byStatus('processed')[0]
    await page.getByTestId(`webhook-request-toggle-${processed.id}`).click()
    const body = page.getByTestId(`webhook-request-body-${processed.id}`)
    await expect(body).toBeVisible()
    // JSON formatado (indentado, uma chave por linha)
    const text = await body.innerText()
    expect(text).toMatch(/\n\s+"nome": "Bruno Dias"/)
    await expect(page.getByTestId(`webhook-request-steps-${processed.id}`)).toBeVisible()
  })
})
