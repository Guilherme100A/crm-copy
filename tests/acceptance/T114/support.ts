// Apoio dos E2E da T114 (hub de Vendas/Rastreamento, modais XPag/Notasy/UTMify, editores dos blocos Pagamento e Venda
// aprovada, status da nota no histórico). Contrato de testids: spec/reports/T114-entrega.md. Os fakes do harness
// (FakeXPag/FakeNotasy/FakeUtmify em scripts/e2e/api.ts) aceitam só as credenciais abaixo: nunca há rede real.
import { expect, type Locator, type Page } from '@playwright/test'
import { XRW } from '../helpers/chats-e2e'

export const XPAG_OK = { client_id: 'xpag-e2e', client_secret: 'xpag-e2e-secret' } as const
export const NOTASY_TOKEN = 'notasy-e2e'
export const UTMIFY_TOKEN = 'utmify-e2e'

export const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

export async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, data?: unknown) {
  const res =
    method === 'get' || method === 'delete'
      ? await page.request[method](path, { headers: XRW })
      : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.status() === 204 ? null : res.json()
}

export async function createPaymentKey(page: Page, body: { label: string; client_id?: string; client_secret?: string }) {
  const r = await api(page, 'post', '/api/payment-integrations', {
    payment_integration: { gateway: 'xpag', client_id: XPAG_OK.client_id, client_secret: XPAG_OK.client_secret, ...body },
  })
  return r.integration as { id: string; label: string; secret_hint: string | null }
}

export async function createInvoiceIssuer(page: Page, company_name: string, token: string | null = NOTASY_TOKEN) {
  const r = await api(page, 'post', '/api/invoice-integrations', {
    invoice_integration: { provider: 'notasy', company_name, ...(token ? { integration_token: token } : {}) },
  })
  return r.invoice_integration as { id: string; company_name: string; token_configured: boolean }
}

export async function createUtmify(page: Page, company_name: string, token: string | null = UTMIFY_TOKEN) {
  const r = await api(page, 'post', '/api/utmify-integrations', {
    utmify_integration: { company_name, ...(token ? { integration_token: token } : {}) },
  })
  return r.utmify_integration as { id: string; company_name: string; token_configured: boolean }
}

export async function createProduct(page: Page, name: string) {
  const r = await api(page, 'post', '/api/products', { name, currency: 'BRL', price_min_cents: 1000, price_max_cents: 5000, price_fallback_cents: 2000 })
  return r.product as { id: string; public_id: string; name: string }
}

/** Abre o hub de integrações numa categoria e espera a URL assentar (lição da T53). */
export async function openHub(page: Page, cat: 'ai' | 'sales' | 'tracking') {
  await page.goto(`/settings?tab=integrations&cat=${cat}`)
  await expect(page).toHaveURL(new RegExp(`[?&]cat=${cat}(&|$)`))
  const hub = page.getByTestId('integrations-hub')
  await expect(hub).toBeVisible()
  await expect(hub).toHaveAttribute('data-cat', cat)
  return hub
}

// ---------------------------------------------------------------- fluxos (padrão tests/acceptance/T57/support.ts)

export const bundle = async (page: Page, flowId: string) => (await api(page, 'get', `/api/flows/${flowId}/editor-bundle`)).definition

/** Fluxo com o nó `n1` do `type` (ações `[]` = recém-saído da paleta) ligado ao início. */
export async function flowWithNode(page: Page, type: string, actions: unknown[] = []) {
  const body = await api(page, 'post', '/api/flows', { name: `Fluxo ${uniq()}` })
  const id = (body.flow ?? body).id as string
  const def = await bundle(page, id)
  const start = def.nodes.find((n: any) => n.type === 'start')
  await api(page, 'put', `/api/flows/${id}/definition`, {
    schema: 'crm.flow/v1',
    entry: start.id,
    nodes: [start, { id: 'n1', type, name: `Nó ${type}`, position: { x: 320, y: 0 }, actions }],
    edges: [{ id: 'e1', from: start.id, handle: 'source', to: 'n1' }],
    variables: [],
    refs: {},
  })
  return id
}

export async function openNode(page: Page, flowId: string): Promise<Locator> {
  await page.goto(`/flows/${flowId}/edit`)
  await expect(page.getByTestId('flow-editor')).toBeVisible()
  const node = page.locator('.react-flow__node[data-id="n1"]')
  await expect(node).toBeVisible()
  await node.click()
  const panel = page.getByTestId('flow-node-editor').filter({ visible: true })
  await expect(panel).toBeVisible()
  return panel
}

/** Config da ação `actionType` do nó n1, relida do servidor (autosave). */
export function pollConfig(page: Page, flowId: string, actionType: string) {
  return expect.poll(
    async () => {
      const node = (await bundle(page, flowId)).nodes.find((n: any) => n.id === 'n1')
      return node?.actions?.find((a: any) => a.type === actionType)?.config ?? null
    },
    { timeout: 15_000 },
  )
}

export const optionValues = (select: Locator) =>
  select.locator('option').evaluateAll((els) => (els as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== ''))

export async function expectStatus(panel: Locator, state: 'saved' | 'blocked') {
  await expect(panel.getByTestId('ne-status')).toHaveAttribute('data-state', state)
}

/** Seletor de idioma visível (header ou menu do usuário; padrão da T23). */
export async function chooseLanguage(page: Page, lang: 'pt-BR' | 'en' | 'es') {
  const visible = page.getByTestId('shell-language-select').filter({ visible: true })
  if ((await visible.count()) === 0) await page.getByTestId('shell-user-menu').click()
  await expect(visible.first()).toBeVisible()
  await visible.first().selectOption(lang)
  await expect(page.locator('html')).toHaveAttribute('lang', lang)
  // no mobile o seletor fica no menu do usuário: fecha o menu antes de seguir (ele bloqueia os cliques da página)
  await expect(async () => {
    if ((await page.getByRole('menu').count()) > 0) {
      await page.keyboard.press('Escape')
      // o Escape pode ficar com o <select> focado; o clique fora (overlay do menu) fecha
      if ((await page.getByRole('menu').count()) > 0) await page.mouse.click(5, (page.viewportSize()?.height ?? 800) / 2)
    }
    await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
}
