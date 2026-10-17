// AC-T114-05 — /welcome, histórico de vendas (T87) com as colunas "Nota fiscal"/"UTMify" do slot da T114: status da nota,
// "Reemitir nota" → POST /api/sales/:id/reemit-invoice (202) → toast "Emissão reenfileirada" e status "Enviando emissão…"
// (a fila `invoices` não roda no worker do harness, então a venda fica em pending), escolha do emissor quando há vários,
// textos em pt-BR/en/es e sem rolagem horizontal. Roda no desktop E no mobile (o AC cita layout mobile).
// Vendas e emissores pela API (o seed não tem); Notasy é o FakeNotasy do harness.
import { expect, test, type Page } from '@playwright/test'
import { expectNoHorizontalScroll, loginAs, resetSeed } from '../helpers/e2e'
import { api, chooseLanguage, createInvoiceIssuer, uniq } from './support'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

async function sale(page: Page, name: string) {
  const body = await api(page, 'post', '/api/sales', { amount_cents: 4_990, currency: 'BRL', sold_at: new Date().toISOString(), status: 'approved', customer_name: name })
  return body.sale as { id: string }
}

async function openHistory(page: Page) {
  await page.goto('/welcome')
  await expect(page.getByTestId('page-welcome')).toBeVisible()
  await expect(page.getByTestId('dashboard-history')).toBeVisible()
}

const isReemit = (id: string) => (r: { method(): string; url(): string }) =>
  r.method() === 'POST' && new URL(r.url()).pathname === `/api/sales/${id}/reemit-invoice`

test.describe('T114 — status da nota no histórico de vendas', () => {
  test('AC-T114-05 venda mostra o status da nota e "Reemitir nota" reenfileira com "Emissão reenfileirada"', async ({ page }) => {
    await loginAs(page, 'owner')
    await createInvoiceIssuer(page, `Emissor ${uniq()}`)
    const s = await sale(page, 'Cliente NF')
    await openHistory(page)

    const table = page.getByTestId('dashboard-history-table')
    await expect(table.locator('thead')).toContainText('Nota fiscal')
    await expect(table.locator('thead')).toContainText('UTMify')
    const status = page.getByTestId(`sale-invoice-status-${s.id}`)
    await expect(page.getByTestId(`dashboard-history-item-nf-${s.id}`)).toBeVisible()
    await expect(status).toHaveAttribute('data-status', 'none')
    await expect(status).toHaveText('Sem emissor')
    await expect(page.getByTestId(`sale-utmify-status-${s.id}`)).toBeVisible()
    const btn = page.getByTestId(`sale-invoice-reemit-${s.id}`)
    await expect(btn).toHaveText('Reemitir nota')
    await expectNoHorizontalScroll(page)

    const res = page.waitForResponse((r) => isReemit(s.id)(r.request()))
    await btn.click()
    expect((await res).status()).toBe(202)
    const toast = page.getByTestId('sale-invoice-reemitted')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('Emissão reenfileirada')
    await expect(toast).toContainText('Aguarde alguns segundos e atualize a lista.')
    await expect(status).toHaveAttribute('data-status', 'pending')
    await expect(status).toHaveText('Enviando emissão…')
    await expect(btn).toHaveCount(0)
    await expectNoHorizontalScroll(page)

    // o servidor confirma a reemissão; após recarregar segue em pending e sem botão (pending → 409)
    const inv = (await api(page, 'get', `/api/sales/${s.id}/invoice`)).invoice
    expect(inv.invoice_emit_status).toBe('pending')
    await page.reload()
    await expect(page.getByTestId(`sale-invoice-status-${s.id}`)).toHaveAttribute('data-status', 'pending')
    await expect(page.getByTestId(`sale-invoice-reemit-${s.id}`)).toHaveCount(0)
  })

  test('AC-T114-05 com vários emissores, "Reemitir nota" pede o emissor e envia o escolhido', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    await createInvoiceIssuer(page, `Emissor A ${tag}`)
    const b = await createInvoiceIssuer(page, `Emissor B ${tag}`)
    const s = await sale(page, 'Cliente dois emissores')
    await openHistory(page)

    await page.getByTestId(`sale-invoice-reemit-${s.id}`).click()
    const dialog = page.getByTestId('sale-invoice-reemit-dialog')
    await expect(dialog).toBeVisible()
    await page.getByTestId('sale-invoice-reemit-issuer').selectOption(b.id)
    const req = page.waitForRequest(isReemit(s.id))
    await page.getByTestId('sale-invoice-reemit-confirm').click()
    expect((await req).postDataJSON()).toMatchObject({ invoice_integration_id: b.id })
    await expect(page.getByTestId('sale-invoice-reemitted')).toBeVisible()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId(`sale-invoice-status-${s.id}`)).toHaveAttribute('data-status', 'pending')
    expect((await api(page, 'get', `/api/sales/${s.id}/invoice`)).invoice.invoice_integration_id).toBe(b.id)
    await expectNoHorizontalScroll(page)
  })

  test('AC-T114-05 textos em en e es (coluna, status, botão e toast) sem rolagem horizontal', async ({ page }) => {
    await loginAs(page, 'owner')
    await createInvoiceIssuer(page, `Emissor ${uniq()}`)
    const s = await sale(page, 'Cliente idiomas')
    await openHistory(page)
    const head = page.getByTestId('dashboard-history-table').locator('thead')
    const status = page.getByTestId(`sale-invoice-status-${s.id}`)
    const btn = page.getByTestId(`sale-invoice-reemit-${s.id}`)

    await chooseLanguage(page, 'en')
    await expect(head).toContainText('Invoice')
    await expect(status).toHaveText('No issuer')
    await expect(btn).toHaveText('Reissue invoice')
    await expectNoHorizontalScroll(page)

    await chooseLanguage(page, 'es')
    await expect(head).toContainText('Factura')
    await expect(status).toHaveText('Sin emisor')
    await expect(btn).toHaveText('Reemitir factura')
    await expectNoHorizontalScroll(page)
    await btn.click()
    await expect(page.getByTestId('sale-invoice-reemitted')).toContainText('Emisión reencolada')
    await expect(status).toHaveText('Enviando emisión…')
    await expectNoHorizontalScroll(page)

    await chooseLanguage(page, 'en')
    await expect(status).toHaveText('Sending issuance…')
    await expectNoHorizontalScroll(page)
  })
})
