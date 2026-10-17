// AC-T97-01..03 — captura de ?ref/?via no cadastro e item "Programa de afiliados" (Playwright, desktop, harness T17).
// Contrato do Prumo (spec/reports/T97-entrega.md): testids affiliate-entry / affiliate-modal / affiliate-modal-text /
// affiliate-modal-continue (o <a>) / affiliate-modal-cancel; a URL vem de GET /api/app-config (alternada com page.route);
// o portal NUNCA é aberto de verdade: context.route intercepta o host e a nova aba é capturada com context.waitForEvent('page').
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const PORTAL = 'https://parceiros.example.test/register?src=crm'

/** Preenche o cadastro em `path` e devolve o corpo JSON do POST /api/auth/register. */
async function registerBody(page: Page, path: string) {
  await page.goto(path)
  await page.getByTestId('register-name').fill('Pessoa Afiliada')
  await page.getByTestId('register-email').fill(`t97-${uniq()}@example.test`)
  await page.getByTestId('register-password').fill('Senha-forte-123')
  await page.getByTestId('register-password-confirmation').fill('Senha-forte-123')
  const req = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/auth/register')
  await page.getByTestId('register-submit').click()
  const body = (await req).postDataJSON() as Record<string, unknown>
  await expect(page).toHaveURL(/\/login/)
  return body
}

/** Alterna a URL do portal servida por GET /api/app-config. */
async function serveAppConfig(page: Page, url: string | null) {
  await page.route('**/api/app-config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ affiliate_portal_url: url }) }),
  )
}

/** Intercepta o host do portal no contexto inteiro (a nova aba não herda page.route) e registra as visitas. */
async function stubPortal(context: BrowserContext) {
  const hits: string[] = []
  await context.route('https://parceiros.example.test/**', (route) => {
    hits.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>portal</title><p>portal fake</p>' })
  })
  return hits
}

async function openShell(page: Page) {
  await loginAs(page, 'owner')
  await page.goto('/welcome')
  await expect(page).toHaveURL(/\/welcome/)
  await expect(page.getByTestId('shell-sidebar')).toBeVisible()
}

test.describe('T97 — captura de indicação no cadastro', () => {
  test('AC-T97-01 /register?ref=a&via=b envia referral_code = a', async ({ page }) => {
    const body = await registerBody(page, '/register?ref=a&via=b')
    expect(body.referral_code).toBe('a')
  })

  test('AC-T97-01 só ?via=b envia referral_code = b', async ({ page }) => {
    const body = await registerBody(page, '/register?via=b')
    expect(body.referral_code).toBe('b')
  })

  test('AC-T97-01 sem query não envia o campo referral_code', async ({ page }) => {
    const body = await registerBody(page, '/register')
    expect(body).not.toHaveProperty('referral_code')
    expect(body.email).toMatch(/^t97-/)
  })

  test('AC-T97-01 /cadastro usa a mesma captura (?ref tem precedência)', async ({ page }) => {
    const body = await registerBody(page, '/cadastro?ref=Parceiro_01&via=outro')
    expect(body.referral_code).toBe('Parceiro_01')
  })

  test('AC-T97-02 código com 64 caracteres de [A-Za-z0-9_-] é aceito', async ({ page }) => {
    const code = `Ab9_-${'x'.repeat(59)}`
    expect(code).toHaveLength(64)
    const body = await registerBody(page, `/register?ref=${code}`)
    expect(body.referral_code).toBe(code)
  })

  for (const [label, raw] of [
    ['65 caracteres', 'a'.repeat(65)],
    ['mais de 120 caracteres', 'b'.repeat(130)],
    ['espaço', 'a b'],
    ['ponto', 'a.b'],
    ['barra', 'a/b'],
    ['acento', 'código'],
    ['símbolos', '<script>'],
  ] as const) {
    test(`AC-T97-02 código fora da regra (${label}) é ignorado: não envia referral_code`, async ({ page }) => {
      const body = await registerBody(page, `/register?ref=${encodeURIComponent(raw)}`)
      expect(body).not.toHaveProperty('referral_code')
    })
  }

  test('AC-T97-02 via inválido também é ignorado', async ({ page }) => {
    const body = await registerBody(page, `/register?via=${encodeURIComponent('c d!')}`)
    expect(body).not.toHaveProperty('referral_code')
  })

  test('AC-T97-02 ref inválido conta como ausente e cai para via válido (decisão do Orquestrador)', async ({ page }) => {
    const body = await registerBody(page, `/register?ref=${'x'.repeat(65)}&via=ok_1`)
    expect(body.referral_code).toBe('ok_1')
  })
})

test.describe('T97 — item "Programa de afiliados"', () => {
  test('AC-T97-03 sem a variável (API real do harness) o item não existe no DOM', async ({ page }) => {
    const cfg = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/app-config')
    await openShell(page)
    const res = await cfg
    expect(res.status()).toBe(200)
    expect((await res.json()).affiliate_portal_url).toBeNull()
    await expect(page.getByTestId('affiliate-entry')).toHaveCount(0)
    await expect(page.getByTestId('affiliate-modal')).toHaveCount(0)
    await expect(page.getByText('Programa de afiliados')).toHaveCount(0)
  })

  for (const url of [null, PORTAL]) {
    test(`AC-T97-03 drawer (390 px) com affiliate_portal_url ${url ? 'definida mostra' : 'null não mostra'} o item`, async ({ page }) => {
      await serveAppConfig(page, url)
      await page.setViewportSize({ width: 390, height: 844 })
      await loginAs(page, 'owner')
      await page.goto('/welcome')
      await expect(page).toHaveURL(/\/welcome/)
      // no mobile o item só monta com o drawer aberto: é aí que /api/app-config é pedido
      const cfg = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/app-config')
      await page.getByTestId('shell-drawer-open').click()
      await cfg
      const drawer = page.getByTestId('shell-drawer')
      await expect(drawer).toBeVisible()
      if (url) {
        await expect(drawer.getByTestId('affiliate-entry')).toBeVisible()
        await drawer.getByTestId('affiliate-entry').click()
        await expect(page.getByTestId('affiliate-modal')).toBeVisible()
        await expect(page.getByTestId('affiliate-modal-continue')).toHaveAttribute('rel', /(^|\s)noopener(\s|$)/)
      } else {
        await expect(page.getByTestId('affiliate-entry')).toHaveCount(0)
      }
    })
  }

  test('AC-T97-03 com a URL definida: item no rodapé → modal de site externo → Continuar abre nova aba com rel=noopener', async ({
    page,
    context,
  }) => {
    const hits = await stubPortal(context)
    await serveAppConfig(page, PORTAL)
    await openShell(page)

    const entry = page.getByTestId('affiliate-entry').filter({ visible: true })
    await expect(entry).toHaveCount(1)
    await expect(entry).toContainText('Programa de afiliados')
    await expect(page.getByTestId('shell-sidebar').getByTestId('affiliate-entry')).toBeVisible()
    await expect(page.getByTestId('affiliate-modal')).toHaveCount(0)

    await entry.click()
    const modal = page.getByTestId('affiliate-modal')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('affiliate-modal-text')).toContainText(/site externo/i)
    await expect(page.getByTestId('affiliate-modal-text')).toContainText('CRM')
    const cont = page.getByTestId('affiliate-modal-continue')
    await expect(cont).toHaveAttribute('href', PORTAL)
    await expect(cont).toHaveAttribute('target', '_blank')
    await expect(cont).toHaveAttribute('rel', /(^|\s)noopener(\s|$)/)
    expect(hits).toHaveLength(0) // abrir o modal não visita o portal

    const newPage = context.waitForEvent('page')
    await cont.click()
    const tab = await newPage
    await tab.waitForLoadState('domcontentloaded')
    expect(tab.url()).toBe(PORTAL)
    expect(await tab.evaluate(() => window.opener)).toBeNull()
    expect(hits).toEqual([PORTAL])
    // a aba do app não navegou e o modal fechou
    await expect(page).toHaveURL(/\/welcome/)
    await expect(modal).toHaveCount(0)
    await tab.close()
  })

  test('AC-T97-03 Cancelar fecha o modal sem abrir aba nem visitar o portal', async ({ page, context }) => {
    const hits = await stubPortal(context)
    await serveAppConfig(page, PORTAL)
    await openShell(page)
    let opened = 0
    context.on('page', () => opened++)

    await page.getByTestId('affiliate-entry').filter({ visible: true }).click()
    await expect(page.getByTestId('affiliate-modal')).toBeVisible()
    await page.getByTestId('affiliate-modal-cancel').click()
    await expect(page.getByTestId('affiliate-modal')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(opened).toBe(0)
    expect(hits).toHaveLength(0)
    await expect(page).toHaveURL(/\/welcome/)
  })

  test('AC-T97-03 URL que não é http/https (javascript:) não mostra o item', async ({ page }) => {
    await serveAppConfig(page, 'javascript:alert(1)')
    const cfg = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/app-config')
    await openShell(page)
    await cfg
    await expect(page.getByTestId('shell-sidebar')).toBeVisible()
    await expect(page.getByTestId('affiliate-entry')).toHaveCount(0)
  })
})
