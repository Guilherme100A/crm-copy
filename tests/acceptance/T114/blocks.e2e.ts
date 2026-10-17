// AC-T114-03/04 — editores dos blocos Pagamento (`create_payment_charge`: matriz XPag 19 §4.6 — BRL PIX; MXN SPEI/OXXO;
// COP NEQUI/BREB; ARS BANK_TRANSFER —, campos do pagador por método, saídas charge_created/payment_approved/erro no
// canvas) e Venda aprovada (`register_approved_sale`: produto com "+ Criar novo produto…", templates com variáveis,
// emissor de NF e UTMify opcionais, push). Fluxo criado pela API com o nó recém-saído da paleta (`actions: []`); a
// config é relida do servidor depois do autosave. Só desktop. Testids: spec/reports/T114-entrega.md.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import {
  bundle,
  createInvoiceIssuer,
  createPaymentKey,
  createProduct,
  createUtmify,
  expectStatus,
  flowWithNode,
  openNode,
  optionValues,
  pollConfig,
  uniq,
} from './support'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const PAY = 'create_payment_charge'
const SALE = 'register_approved_sale'

/** Campos do pagador visíveis (subconjunto de nome/e-mail/celular/documento/tipo). */
async function payerFields(panel: Locator) {
  const out: string[] = []
  for (const f of ['name', 'email', 'phone', 'document', 'document-type'])
    if ((await panel.getByTestId(`ne-pay-${f}`).count()) > 0) out.push(f)
  return out
}

/** Painel do bloco Pagamento; sem chave escolhida o autosave fica bloqueado (chave obrigatória), então cria uma. */
async function paymentPanel(page: Page, withKey = true) {
  if (withKey) await createPaymentKey(page, { label: `Chave ${uniq()}` })
  const flowId = await flowWithNode(page, 'payment')
  const panel = await openNode(page, flowId)
  await expect(panel.getByTestId('ne-payment')).toBeVisible()
  return { flowId, panel }
}

test.describe('T114 — bloco Pagamento', () => {
  test('AC-T114-03 só gateways, moedas e métodos da matriz XPag; trocar a moeda leva a um método válido', async ({ page }) => {
    await loginAs(page, 'owner')
    const { flowId, panel } = await paymentPanel(page)
    const box = panel.getByTestId('ne-payment')

    expect(await optionValues(panel.getByTestId('ne-pay-gateway'))).toEqual(['xpag'])
    expect(await optionValues(panel.getByTestId('ne-pay-currency'))).toEqual(['BRL', 'MXN', 'COP', 'ARS'])
    await expect(box).toHaveAttribute('data-currency', 'BRL')
    expect(await optionValues(panel.getByTestId('ne-pay-method'))).toEqual(['PIX'])

    const expected: Record<string, string[]> = { MXN: ['SPEI', 'OXXO'], COP: ['NEQUI', 'BREB'], ARS: ['BANK_TRANSFER'], BRL: ['PIX'] }
    for (const [cur, methods] of Object.entries(expected)) {
      await panel.getByTestId('ne-pay-currency').selectOption(cur)
      await expect(box).toHaveAttribute('data-currency', cur)
      await expect(box).toHaveAttribute('data-method', methods[0]!)
      expect(await optionValues(panel.getByTestId('ne-pay-method')), cur).toEqual(methods)
    }

    await panel.getByTestId('ne-pay-currency').selectOption('MXN')
    await panel.getByTestId('ne-pay-method').selectOption('OXXO')
    await panel.getByTestId('ne-pay-amount').fill('250')
    await pollConfig(page, flowId, PAY).toMatchObject({ gateway: 'xpag', currency: 'MXN', method: 'OXXO', amount: '250' })
  })

  test('AC-T114-03 campos do pagador e "chave sem valor" mudam com o método', async ({ page }) => {
    await loginAs(page, 'owner')
    const { flowId, panel } = await paymentPanel(page)
    const cur = panel.getByTestId('ne-pay-currency')

    // BRL PIX: nome e documento; chave sem valor disponível
    expect(await payerFields(panel)).toEqual(['name', 'document'])
    await expect(panel.getByTestId('ne-pay-name')).toHaveValue('{full_name}')
    await expect(panel.getByTestId('ne-pay-open-amount')).toBeVisible()
    await panel.getByTestId('ne-pay-open-amount').check()
    await expect(panel.getByTestId('ne-pay-open-notice')).toBeVisible()
    await expect(panel.getByTestId('ne-pay-amount')).toHaveCount(0)
    await pollConfig(page, flowId, PAY).toMatchObject({ currency: 'BRL', method: 'PIX', open_amount: true })
    await panel.getByTestId('ne-pay-open-amount').uncheck()
    await expect(panel.getByTestId('ne-pay-amount')).toBeVisible()

    // MXN OXXO: nome e e-mail; valor obrigatório (sem chave sem valor)
    await cur.selectOption('MXN')
    expect(await payerFields(panel)).toEqual(['name', 'document'])
    await panel.getByTestId('ne-pay-method').selectOption('OXXO')
    expect(await payerFields(panel)).toEqual(['name', 'email'])
    await expect(panel.getByTestId('ne-pay-open-amount')).toHaveCount(0)
    await expect(panel.getByTestId('ne-pay-open-unavailable')).toBeVisible()
    await panel.getByTestId('ne-pay-email').fill('{email}')

    // COP: só o celular (com a variável padrão), sem chave sem valor
    await cur.selectOption('COP')
    expect(await payerFields(panel)).toEqual(['phone'])
    await expect(panel.getByTestId('ne-pay-phone')).toHaveValue('{phone_number}')
    await expect(panel.getByTestId('ne-pay-open-unavailable')).toBeVisible()
    await panel.getByTestId('ne-pay-amount').fill('20000')
    await pollConfig(page, flowId, PAY).toMatchObject({ currency: 'COP', method: 'NEQUI', phone: '{phone_number}', amount: '20000' })
    const cop = (await bundle(page, flowId)).nodes.find((n: any) => n.id === 'n1').actions.find((a: any) => a.type === PAY).config
    expect(cop, 'campos que sumiram são apagados').not.toHaveProperty('email')
    expect(cop).not.toHaveProperty('name')

    // ARS: nome, documento e tipo (CUIT/CUIL/DNI); chave sem valor "em breve"
    await cur.selectOption('ARS')
    expect(await payerFields(panel)).toEqual(['name', 'document', 'document-type'])
    expect(await optionValues(panel.getByTestId('ne-pay-document-type'))).toEqual(['CUIT', 'CUIL', 'DNI'])
    await expect(panel.getByTestId('ne-pay-open-unavailable')).toContainText(/em breve/i)
    await panel.getByTestId('ne-pay-document-type').selectOption('DNI')
    await pollConfig(page, flowId, PAY).toMatchObject({ currency: 'ARS', method: 'BANK_TRANSFER', document_type: 'DNI', name: '{full_name}' })
  })

  test('AC-T114-03 limites da XPag bloqueiam o autosave (OXXO abaixo de MX$10)', async ({ page }) => {
    await loginAs(page, 'owner')
    const { flowId, panel } = await paymentPanel(page)
    await panel.getByTestId('ne-pay-currency').selectOption('MXN')
    await panel.getByTestId('ne-pay-method').selectOption('OXXO')
    await panel.getByTestId('ne-pay-amount').fill('300')
    await pollConfig(page, flowId, PAY).toMatchObject({ method: 'OXXO', amount: '300' })
    await panel.getByTestId('ne-pay-amount').fill('5')
    await expect(panel.getByTestId('ne-error-amount')).toContainText('MX$10')
    await expectStatus(panel, 'blocked')
    await page.waitForTimeout(1500)
    await pollConfig(page, flowId, PAY).toMatchObject({ amount: '300' })
    await panel.getByTestId('ne-pay-amount').fill('50')
    await expectStatus(panel, 'saved')
    await pollConfig(page, flowId, PAY).toMatchObject({ amount: '50' })
  })

  test('AC-T114-03 chaves do gateway: única vem escolhida; sem chave, aviso', async ({ page }) => {
    await loginAs(page, 'owner')
    let { panel } = await paymentPanel(page, false)
    await expect(panel.getByTestId('ne-pay-keys-empty')).toBeVisible()
    await expectStatus(panel, 'blocked')

    const key = await createPaymentKey(page, { label: `Única ${uniq()}` })
    const again = await paymentPanel(page, false)
    panel = again.panel
    await expect(panel.getByTestId('ne-pay-keys-empty')).toHaveCount(0)
    await expect(panel.getByTestId('ne-pay-key')).toHaveValue(key.id)
    await pollConfig(page, again.flowId, PAY).toMatchObject({ gateway: 'xpag', payment_integration_id: key.id })
  })

  test('AC-T114-03 o canvas mostra as saídas charge_created, payment_approved e erro', async ({ page }) => {
    await loginAs(page, 'owner')
    await paymentPanel(page)
    const node = page.locator('.react-flow__node[data-id="n1"]')
    const handle = (h: string) => node.locator(`.react-flow__handle.source[data-handleid="${h}"]`)
    await expect(handle('output:charge_created')).toHaveCount(1)
    await expect(handle('output:payment_approved')).toHaveCount(1)
    await expect(handle('failure')).toHaveCount(1)
    await expect(node.locator('.react-flow__handle.source')).toHaveCount(3)
    await expect(node).toContainText('charge_created')
    await expect(node).toContainText('payment_approved')
    // resumo das saídas no editor com os rótulos traduzidos
    const outs = page.getByTestId('ne-outputs').filter({ visible: true })
    await expect(outs.getByTestId('ne-output-output:charge_created')).toBeVisible()
    await expect(outs.getByTestId('ne-output-output:payment_approved')).toBeVisible()
    await expect(outs.getByTestId('ne-output-failure')).toBeVisible()
  })
})

// =================================================================================================== AC-T114-04
/** Painel do bloco Venda aprovada; o produto é obrigatório para o autosave, então `pick` já escolhe um. */
async function salePanel(page: Page, pick = true) {
  const product = pick ? await createProduct(page, `Produto ${uniq()}`) : null
  const flowId = await flowWithNode(page, 'approved_sale')
  const panel = await openNode(page, flowId)
  await expect(panel.getByTestId('ne-approved-sale')).toBeVisible()
  if (product) await panel.getByTestId('ne-sale-product').selectOption(product.public_id)
  return { flowId, panel }
}

test.describe('T114 — bloco Venda aprovada', () => {
  test('AC-T114-04 produto da lista e "+ Criar novo produto…" cria e já seleciona', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const p1 = await createProduct(page, `Curso ${tag}`)
    const { flowId, panel } = await salePanel(page, false)
    const product = panel.getByTestId('ne-sale-product')
    await expect(panel.getByTestId(`ne-sale-product-option-${p1.public_id}`)).toHaveCount(1)
    await expect(panel.getByTestId('ne-sale-product-new')).toHaveText(/Criar novo produto/)

    await product.selectOption(p1.public_id)
    await pollConfig(page, flowId, SALE).toMatchObject({ product_public_id: p1.public_id })

    await product.selectOption('__new__')
    const dialog = page.getByTestId('products-editor')
    await expect(dialog).toBeVisible()
    await page.getByTestId('products-name').fill(`Mentoria ${tag}`)
    await page.getByTestId('products-min').fill('10')
    await page.getByTestId('products-max').fill('50')
    await page.getByTestId('products-fallback').fill('20')
    await page.getByTestId('products-save').click()
    await expect(dialog).toHaveCount(0)
    const created = (await (await page.request.get('/api/products')).json()).items.find((p: any) => p.name === `Mentoria ${tag}`)
    expect(created, 'produto criado pelo modal').toBeTruthy()
    await expect(product).toHaveValue(created.public_id)
    await pollConfig(page, flowId, SALE).toMatchObject({ product_public_id: created.public_id })
  })

  test('AC-T114-04 valor, moeda e cliente por template com variáveis', async ({ page }) => {
    await loginAs(page, 'owner')
    const { flowId, panel } = await salePanel(page)
    await expect(panel.getByTestId('ne-sale-amount')).toHaveValue('{comprovante.valor}')
    await expect(panel.getByTestId('ne-sale-currency')).toHaveValue('{comprovante.currency}')
    await expect(panel.getByTestId('ne-sale-customer')).toHaveValue('{comprovante.nome_pagador}')

    await panel.getByTestId('ne-sale-customer').fill('Cliente ')
    // seletor de variável do campo cliente (insere no cursor)
    const field = panel.getByTestId('ne-sale-customer').locator('xpath=..')
    await field.getByTestId('ne-var-picker').click()
    const list = page.getByTestId('ne-var-list').filter({ visible: true })
    await expect(list).toBeVisible()
    await list.getByTestId('ne-var-full_name').first().click()
    await expect(panel.getByTestId('ne-sale-customer')).toHaveValue('Cliente {full_name}')
    await panel.getByTestId('ne-sale-amount').fill('{venda.total}')
    await pollConfig(page, flowId, SALE).toMatchObject({
      amount_template: '{venda.total}',
      currency_template: '{comprovante.currency}',
      customer_name_template: 'Cliente {full_name}',
    })
  })

  test('AC-T114-04 emissor de NF e UTMify opcionais ("Não emitir…"/"Não enviar…" gravam null)', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const nf = await createInvoiceIssuer(page, `Emissor ${tag}`)
    const utm = await createUtmify(page, `Rastreio ${tag}`)
    const utmOff = await createUtmify(page, `Sem token ${tag}`, null)
    const { flowId, panel } = await salePanel(page)
    const issuer = panel.getByTestId('ne-sale-issuer')
    const utmify = panel.getByTestId('ne-sale-utmify')

    await expect(issuer).toHaveValue('')
    await expect(issuer.locator('option[value=""]')).toHaveText('Não emitir nota automaticamente')
    await expect(utmify).toHaveValue('')
    await expect(utmify.locator('option[value=""]')).toHaveText('Não enviar para UTMify')
    await expect(panel.getByTestId(`ne-sale-issuer-option-${nf.id}`)).toHaveCount(1)
    await expect(panel.getByTestId(`ne-sale-utmify-option-${utm.id}`)).toHaveCount(1)
    // só as integrações UTMify configuradas (?configured=1)
    await expect(panel.getByTestId(`ne-sale-utmify-option-${utmOff.id}`)).toHaveCount(0)

    await issuer.selectOption(nf.id)
    await utmify.selectOption(utm.id)
    await pollConfig(page, flowId, SALE).toMatchObject({ note_issuer_id: nf.id, utmify_integration_id: utm.id })

    await issuer.selectOption('')
    await utmify.selectOption('')
    await pollConfig(page, flowId, SALE).toMatchObject({ note_issuer_id: null, utmify_integration_id: null })
  })

  test('AC-T114-04 título e corpo do push com os botões de variável', async ({ page }) => {
    await loginAs(page, 'owner')
    const { flowId, panel } = await salePanel(page)
    await panel.getByTestId('ne-sale-push-title').fill('Venda aprovada!')
    await panel.getByTestId('ne-sale-push-body').fill('Produto:')
    await panel.getByTestId('ne-sale-push-var-produto.nome').click()
    await panel.getByTestId('ne-sale-push-var-venda.valor').click()
    await panel.getByTestId('ne-sale-push-var-venda.moeda').click()
    await panel.getByTestId('ne-sale-push-var-venda.cliente').click()
    await expect(panel.getByTestId('ne-sale-push-body')).toHaveValue('Produto: {produto.nome} {venda.valor} {venda.moeda} {venda.cliente}')
    await pollConfig(page, flowId, SALE).toMatchObject({
      push_title_template: 'Venda aprovada!',
      push_body_template: 'Produto: {produto.nome} {venda.valor} {venda.moeda} {venda.cliente}',
    })
  })
})
