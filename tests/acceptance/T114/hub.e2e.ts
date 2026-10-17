// AC-T114-01/02 — hub /settings?tab=integrations: cards XPag e Notasy (Vendas) e UTMify (Rastreamento), sem Zenith (SPEC
// 10.1 nº 13), status Ativo/Inativo pelo segredo/token configurado e busca; modal da chave XPag (mensagens de validação do
// servidor, 422 do servidor no campo, segredo mascarado, "Testar conexão" só na edição pelo FakeXPag do harness, em
// branco na edição mantém o segredo). Só desktop (AC sem layout mobile). Testids: spec/reports/T114-entrega.md.
import { expect, test, type Page } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'
import { api, createInvoiceIssuer, createPaymentKey, createUtmify, NOTASY_TOKEN, openHub, uniq, UTMIFY_TOKEN, XPAG_OK } from './support'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const status = (page: Page, id: string) => page.getByTestId(`integrations-record-status-${id}`)

test.describe('T114 — cards do hub (Vendas e Rastreamento)', () => {
  test('AC-T114-01 Vendas tem XPag e Notasy, Rastreamento tem UTMify; nada de Zenith', async ({ page }) => {
    await loginAs(page, 'owner')
    await openHub(page, 'sales')
    await expect(page.getByTestId('integrations-catalog-xpag')).toBeVisible()
    await expect(page.getByTestId('integrations-catalog-xpag')).toContainText('XPag')
    await expect(page.getByTestId('integrations-catalog-notasy')).toBeVisible()
    await expect(page.getByTestId('integrations-catalog-notasy')).toContainText('Notasy')
    await expect(page.getByTestId('integrations-catalog-utmify')).toHaveCount(0)
    await expect(page.getByTestId('integrations-empty-category')).toHaveCount(0)
    await expect(page.getByTestId('integrations-catalog-zenith')).toHaveCount(0)
    await expect(page.getByTestId('integrations-hub')).not.toContainText(/zenith/i)

    await page.getByTestId('integrations-cat-tracking').click()
    await expect(page).toHaveURL(/[?&]cat=tracking(&|$)/)
    await expect(page.getByTestId('integrations-catalog-utmify')).toBeVisible()
    await expect(page.getByTestId('integrations-catalog-utmify')).toContainText('UTMify')
    await expect(page.getByTestId('integrations-catalog-xpag')).toHaveCount(0)
    await expect(page.getByTestId('integrations-catalog-notasy')).toHaveCount(0)
  })

  test('AC-T114-01 registros com status Ativo/Inativo (segredo/token configurado) e só a dica do segredo', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const key = await createPaymentKey(page, { label: `Loja ${tag}`, client_secret: `segredo-${tag}-7788` })
    const nfOn = await createInvoiceIssuer(page, `Emissor ativo ${tag}`)
    const nfOff = await createInvoiceIssuer(page, `Emissor sem token ${tag}`, null)
    const utmOn = await createUtmify(page, `Rastreio ${tag}`)
    const utmOff = await createUtmify(page, `Rastreio sem token ${tag}`, null)

    await openHub(page, 'sales')
    await expect(page.getByTestId(`integrations-record-${key.id}`)).toContainText(`Loja ${tag}`)
    await expect(page.getByTestId(`integrations-record-${key.id}`)).toContainText('…7788')
    await expect(page.getByTestId(`integrations-record-${key.id}`)).not.toContainText(`segredo-${tag}`)
    await expect(status(page, key.id)).toHaveAttribute('data-status', 'active')
    await expect(status(page, key.id)).toHaveText('Ativo')
    await expect(status(page, nfOn.id)).toHaveAttribute('data-status', 'active')
    await expect(status(page, nfOff.id)).toHaveAttribute('data-status', 'inactive')
    await expect(status(page, nfOff.id)).toHaveText('Inativo')
    await expect(page.getByTestId(`integrations-record-${nfOn.id}`)).not.toContainText(NOTASY_TOKEN)
    // registros de Rastreamento não aparecem em Vendas
    await expect(page.getByTestId(`integrations-record-${utmOn.id}`)).toHaveCount(0)
    expect(await page.content()).not.toContain(`segredo-${tag}-7788`)

    await page.getByTestId('integrations-cat-tracking').click()
    await expect(page).toHaveURL(/[?&]cat=tracking(&|$)/)
    await expect(status(page, utmOn.id)).toHaveAttribute('data-status', 'active')
    await expect(status(page, utmOff.id)).toHaveAttribute('data-status', 'inactive')
    await expect(page.getByTestId(`integrations-record-${key.id}`)).toHaveCount(0)
    expect(await page.content()).not.toContain(UTMIFY_TOKEN)
  })

  test('AC-T114-01 busca acha os cards e registros de Vendas/Rastreamento', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const key = await createPaymentKey(page, { label: `Checkout ${tag}` })
    await openHub(page, 'sales')
    const search = page.getByTestId('integrations-search')

    await search.fill('notasy')
    await expect(page.getByTestId('integrations-catalog-notasy')).toBeVisible()
    await expect(page.getByTestId('integrations-catalog-xpag')).toHaveCount(0)
    await expect(page.getByTestId(`integrations-record-${key.id}`)).toHaveCount(0)

    await search.fill(`checkout ${tag}`)
    await expect(page.getByTestId(`integrations-record-${key.id}`)).toBeVisible()
    await expect(page.getByTestId('integrations-catalog-notasy')).toHaveCount(0)

    await search.fill('xpag')
    await expect(page.getByTestId('integrations-catalog-xpag')).toBeVisible()
    await expect(page.getByTestId('integrations-catalog-notasy')).toHaveCount(0)

    await page.getByTestId('integrations-cat-tracking').click()
    await search.fill('utmify')
    await expect(page.getByTestId('integrations-catalog-utmify')).toBeVisible()

    await search.fill(`zzz${tag}`)
    await expect(page.getByTestId('integrations-empty-search')).toBeVisible()
    await expect(page.getByTestId('integrations-catalog-utmify')).toHaveCount(0)
  })

  test('AC-T114-01 Notasy e UTMify configurados pelo card viram registros ativos (token mascarado)', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    await openHub(page, 'sales')
    await page.getByTestId('integrations-catalog-configure-notasy').click()
    await expect(page.getByTestId('invoice-editor')).toBeVisible()
    await expect(page.getByTestId('invoice-token')).toHaveAttribute('type', 'password')
    await page.getByTestId('invoice-company-name').fill(`Empresa NF ${tag}`)
    await page.getByTestId('invoice-token').fill(NOTASY_TOKEN)
    await page.getByTestId('invoice-save').click()
    await expect(page.getByTestId('invoice-saved')).toBeVisible()
    await expect(page.getByTestId('invoice-editor')).toHaveCount(0)
    const nf = (await api(page, 'get', '/api/invoice-integrations')).invoice_integrations.find((i: any) => i.company_name === `Empresa NF ${tag}`)
    expect(nf, 'emissor criado').toBeTruthy()
    await expect(status(page, nf.id)).toHaveAttribute('data-status', 'active')
    await expect(page.getByTestId(`integrations-record-${nf.id}`)).not.toContainText(NOTASY_TOKEN)

    await page.getByTestId('integrations-cat-tracking').click()
    await page.getByTestId('integrations-catalog-configure-utmify').click()
    await expect(page.getByTestId('utmify-editor')).toBeVisible()
    await page.getByTestId('utmify-company-name').fill(`Rastreio ${tag}`)
    await page.getByTestId('utmify-token').fill(UTMIFY_TOKEN)
    await page.getByTestId('utmify-save').click()
    await expect(page.getByTestId('utmify-saved')).toBeVisible()
    const utm = (await api(page, 'get', '/api/utmify-integrations')).utmify_integrations.find((i: any) => i.company_name === `Rastreio ${tag}`)
    expect(utm, 'integração UTMify criada').toBeTruthy()
    await expect(status(page, utm.id)).toHaveAttribute('data-status', 'active')
  })
})

// =================================================================================================== AC-T114-02
async function openNewKey(page: Page) {
  await openHub(page, 'sales')
  await page.getByTestId('integrations-catalog-configure-xpag').click()
  const modal = page.getByTestId('payment-key-editor')
  await expect(modal).toBeVisible()
  await expect(modal).toHaveAttribute('data-mode', 'create')
  return modal
}

async function openEditKey(page: Page, id: string) {
  await openHub(page, 'sales')
  await page.getByTestId(`integrations-record-edit-${id}`).click()
  const modal = page.getByTestId('payment-key-editor')
  await expect(modal).toBeVisible()
  await expect(modal).toHaveAttribute('data-mode', 'edit')
  await expect(page.getByTestId('payment-key-client-id')).toBeVisible()
  return modal
}

/** Mensagens que o servidor devolve no 422 de criação (para comparar com as do modal). */
async function serverMessages(page: Page) {
  const res = await page.request.post('/api/payment-integrations', { data: { payment_integration: { gateway: 'xpag', label: 'a', client_id: '', client_secret: '' } }, headers: XRW })
  expect(res.status()).toBe(422)
  const fields = ((await res.json()).error?.details?.fields ?? (await res.json()).details?.fields) as { path: string; message: string }[]
  return Object.fromEntries(fields.map((f) => [f.path, f.message]))
}

test.describe('T114 — modal da chave XPag', () => {
  test('AC-T114-02 criação: validações com as mensagens do servidor, gateway fixo, sem "Testar conexão"', async ({ page }) => {
    await loginAs(page, 'owner')
    const msgs = await serverMessages(page)
    expect(msgs.label).toBe('Informe um nome com pelo menos 2 caracteres.')

    await openNewKey(page)
    await expect(page.getByTestId('payment-key-gateway')).toBeDisabled()
    await expect(page.getByTestId('payment-key-gateway')).toHaveValue('xpag')
    await expect(page.getByTestId('payment-key-test')).toHaveCount(0)
    await expect(page.getByTestId('payment-key-webhook-url')).toHaveCount(0)

    const posts: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/payment-integrations') posts.push(r.postData() ?? '')
    })
    await page.getByTestId('payment-key-label').fill('a')
    await page.getByTestId('payment-key-save').click()
    await expect(page.getByTestId('payment-key-label-error')).toHaveText(msgs.label!)
    await expect(page.getByTestId('payment-key-client-id-error')).toHaveText(msgs.client_id!)
    await expect(page.getByTestId('payment-key-client-secret-error')).toHaveText(msgs.client_secret!)
    expect(posts, 'nada vai ao servidor com erro local').toHaveLength(0)
    await expect(page.getByTestId('payment-key-editor')).toBeVisible()
  })

  test('AC-T114-02 erro 422 do servidor aparece no campo indicado em details.fields', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.route('**/api/payment-integrations', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      return route.fulfill({
        status: 422,
        json: { error: { code: 'validation_error', message: 'Dados inválidos', details: { fields: [{ path: 'client_id', message: 'Client ID recusado pelo servidor' }] } } },
      })
    })
    await openNewKey(page)
    await page.getByTestId('payment-key-label').fill('Loja principal')
    await page.getByTestId('payment-key-client-id').fill('qualquer')
    await page.getByTestId('payment-key-client-secret').fill('qualquer-segredo')
    await page.getByTestId('payment-key-save').click()
    await expect(page.getByTestId('payment-key-client-id-error')).toHaveText('Client ID recusado pelo servidor')
    await expect(page.getByTestId('payment-key-editor')).toBeVisible()
  })

  test('AC-T114-02 segredo mascarado (mostrar/ocultar), salvo só como dica; Testar conexão na edição pelo FakeXPag', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const wrong = `errado-${tag}-4321`
    await openNewKey(page)
    const secret = page.getByTestId('payment-key-client-secret')
    await expect(secret).toHaveAttribute('type', 'password')
    await page.getByTestId('payment-key-label').fill(`Loja ${tag}`)
    await page.getByTestId('payment-key-client-id').fill(XPAG_OK.client_id)
    await secret.fill(wrong)
    await page.getByTestId('payment-key-client-secret-toggle').click()
    await expect(secret).toHaveAttribute('type', 'text')
    await expect(secret).toHaveValue(wrong)
    await page.getByTestId('payment-key-client-secret-toggle').click()
    await expect(secret).toHaveAttribute('type', 'password')

    const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/payment-integrations')
    await page.getByTestId('payment-key-save').click()
    const res = await created
    expect(res.status()).toBe(201)
    const id = (await res.json()).integration.id as string
    await expect(page.getByTestId('payments-saved')).toBeVisible()
    await expect(page.getByTestId('payment-key-editor')).toHaveCount(0)
    await expect(page.getByTestId(`integrations-record-${id}`)).toContainText('…4321')
    expect(await page.content()).not.toContain(wrong)

    // edição: Client ID preenchido, segredo vazio com a dica, URL do webhook só leitura
    await openEditKey(page, id)
    await expect(page.getByTestId('payment-key-client-id')).toHaveValue(XPAG_OK.client_id)
    await expect(page.getByTestId('payment-key-client-secret')).toHaveValue('')
    await expect(page.getByTestId('payment-key-client-secret')).toHaveAttribute('type', 'password')
    await expect(page.getByTestId('payment-key-client-secret')).toHaveAttribute('placeholder', '…4321')
    await expect(page.getByTestId('payment-key-webhook-url')).toHaveAttribute('readonly', '')
    await expect(page.getByTestId('payment-key-webhook-url')).toHaveValue(/^https?:\/\//)
    expect(await page.content()).not.toContain(wrong)

    // credencial errada → falha (FakeXPag recusa)
    await page.getByTestId('payment-key-test').click()
    await expect(page.getByTestId('payment-key-test-result')).toHaveAttribute('data-ok', 'false')
    await expect(page.getByTestId('payment-key-test-result')).toContainText(/Falha na conexão/)
    await expect(page.getByTestId('payments-test-fail')).toBeVisible()

    // troca o segredo e testa de novo → sucesso
    await page.getByTestId('payment-key-client-secret').fill(XPAG_OK.client_secret)
    await page.getByTestId('payment-key-save').click()
    await expect(page.getByTestId('payments-saved').first()).toBeVisible()
    await expect(page.getByTestId(`integrations-record-${id}`)).toContainText('…cret')
    await openEditKey(page, id)
    await page.getByTestId('payment-key-test').click()
    await expect(page.getByTestId('payment-key-test-result')).toHaveAttribute('data-ok', 'true')
    await expect(page.getByTestId('payment-key-test-result')).toContainText(/sucesso/i)
    await expect(page.getByTestId('payments-test-ok')).toBeVisible()
    expect(await page.content()).not.toContain(XPAG_OK.client_secret)
  })

  test('AC-T114-02 na edição, segredo em branco mantém o atual (PATCH sem client_secret)', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const key = await createPaymentKey(page, { label: `Antiga ${tag}` })
    await openEditKey(page, key.id)
    await page.getByTestId('payment-key-label').fill(`Renomeada ${tag}`)
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/payment-integrations/${key.id}`)
    await page.getByTestId('payment-key-save').click()
    const sent = (await patch).postDataJSON()
    const body = sent.payment_integration ?? sent
    expect(body.label).toBe(`Renomeada ${tag}`)
    expect(body).not.toHaveProperty('client_secret')
    await expect(page.getByTestId(`integrations-record-title-${key.id}`)).toHaveText(`Renomeada ${tag}`)
    await expect(status(page, key.id)).toHaveAttribute('data-status', 'active')

    // o segredo continua o válido: o teste de conexão passa
    const test = await api(page, 'post', `/api/payment-integrations/${key.id}/test-connection`, {})
    expect(test.ok, JSON.stringify(test)).toBe(true)
  })
})
