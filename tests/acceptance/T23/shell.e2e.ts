// AC-T23-01..07 — shell da web (guards, sidebar, tema, mobile, 404, 401, i18n) no harness E2E, desktop e mobile.
import { expect, test, type Page } from '@playwright/test'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed } from '../helpers/e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

/** Seletor de idioma visível (header ou menu do usuário). */
async function languageSelect(page: Page) {
  const visible = page.getByTestId('shell-language-select').filter({ visible: true })
  if ((await visible.count()) === 0) await page.getByTestId('shell-user-menu').click()
  await expect(visible.first()).toBeVisible()
  return visible.first()
}

const pathOf = (page: Page) => new URL(page.url()).pathname
const searchOf = (page: Page, k: string) => new URL(page.url()).searchParams.get(k)

/** Área onde ficam os itens de navegação: sidebar no desktop, drawer no mobile. */
async function nav(page: Page) {
  if (isMobile(page)) {
    await page.getByTestId('shell-drawer-open').click()
    const drawer = page.getByTestId('shell-drawer')
    await expect(drawer).toBeVisible()
    return drawer
  }
  const sidebar = page.getByTestId('shell-sidebar')
  await expect(sidebar).toBeVisible()
  return sidebar
}

const ALL_ITEMS = ['dashboard', 'chats', 'kanban', 'contacts', 'flows', 'agents', 'connections', 'inbound-webhooks', 'mass-dispatch', 'facebook', 'settings', 'admin']

async function visibleItems(page: Page) {
  const scope = await nav(page)
  const out: string[] = []
  for (const id of ALL_ITEMS) if (await scope.getByTestId(`nav-item-${id}`).isVisible()) out.push(id)
  return out
}

test.describe('T23 — guards', () => {
  test('AC-T23-01 sem sessão, rota interna redireciona para /login?redirect=<rota>', async ({ page }) => {
    for (const route of ['/chats', '/customers', '/settings']) {
      await page.goto(route)
      await expect(page).toHaveURL(/\/login\?/)
      expect(pathOf(page)).toBe('/login')
      expect(searchOf(page, 'redirect'), route).toBe(route)
    }
  })

  test('AC-T23-01 redirect seguro é seguido após o login; valores com //, :// ou \\ são ignorados', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/login?redirect=%2Fcustomers')
    await expect(page).toHaveURL(/\/customers$/)

    for (const bad of ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com', '/x//y', 'javascript://alert(1)']) {
      await page.goto(`/login?redirect=${encodeURIComponent(bad)}`)
      await expect(page).not.toHaveURL(/\/login/)
      const u = new URL(page.url())
      expect(u.host, bad).toMatch(/^127\.0\.0\.1:/)
      expect(u.pathname, bad).not.toContain('evil')
      expect(u.pathname).not.toBe('/x//y')
    }
  })
})

test.describe('T23 — sidebar e permissões', () => {
  test('AC-T23-02 owner vê todos os itens permitidos (sem o admin da plataforma)', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/chats')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    const items = await visibleItems(page)
    expect(items).toEqual(['dashboard', 'chats', 'kanban', 'contacts', 'flows', 'agents', 'connections', 'inbound-webhooks', 'mass-dispatch', 'facebook', 'settings'])
  })

  test('AC-T23-02 member vê só os itens da matriz do papel', async ({ page }) => {
    await loginAs(page, 'member')
    await page.goto('/chats')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    expect(await visibleItems(page)).toEqual(['chats', 'kanban', 'contacts', 'flows', 'agents', 'mass-dispatch', 'settings'])
  })

  test('AC-T23-02 rota sem permissão por URL leva à primeira rota permitida e mostra o aviso uma vez', async ({ page }) => {
    await loginAs(page, 'member')
    await page.goto('/connections')
    await expect(page).toHaveURL(/\/chats$/)
    await expect(page.getByTestId('chat-page')).toBeVisible()
    const toast = page.getByTestId('shell-permission-denied')
    await expect(toast).toHaveCount(1)
    await expect(toast).toContainText('Você não tem permissão para acessar esta página.')
    await page.waitForTimeout(500)
    await expect(page.getByTestId('shell-permission-denied')).toHaveCount(1)
    await expect(page.getByTestId('page-connections')).toHaveCount(0)
  })
})

test.describe('T23 — tema', () => {
  const theme = (page: Page) => page.evaluate(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'))

  test('AC-T23-03 Ctrl/Cmd+M alterna o tema fora de campos de texto, não dentro de um input, e persiste ao recarregar', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/chats')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    const initial = await theme(page)

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    await page.keyboard.press('ControlOrMeta+m')
    await expect.poll(() => theme(page)).not.toBe(initial)
    const toggled = await theme(page)

    // dentro de um campo de texto: não alterna
    await page.evaluate(() => {
      const i = document.createElement('input')
      i.type = 'text'
      i.setAttribute('data-testid', 't23-probe-input')
      document.body.appendChild(i)
    })
    await page.getByTestId('t23-probe-input').focus()
    await page.keyboard.press('ControlOrMeta+m')
    await page.waitForTimeout(300)
    expect(await theme(page)).toBe(toggled)

    await page.reload()
    await expect(page.getByTestId('chat-page')).toBeVisible()
    expect(await theme(page)).toBe(toggled)
  })
})

test.describe('T23 — mobile e layout', () => {
  test('AC-T23-04 barra inferior no mobile, sidebar vira drawer; no desktop a sidebar colapsa (240/64 px) e persiste', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/chats')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    if (isMobile(page)) {
      const bottom = page.getByTestId('shell-bottom-nav')
      await expect(bottom).toBeVisible()
      for (const id of ['home', 'chats', 'kanban', 'flows', 'more']) await expect(bottom.getByTestId(`bottom-nav-${id}`)).toBeVisible()
      await expect(page.getByTestId('shell-sidebar')).toBeHidden()
      await page.getByTestId('bottom-nav-more').click()
      await expect(page.getByTestId('shell-drawer')).toBeVisible()
      await expect(page.getByTestId('shell-drawer').getByTestId('nav-item-contacts')).toBeVisible()
      await page.getByTestId('shell-drawer').getByTestId('nav-item-contacts').click()
      await expect(page).toHaveURL(/\/customers$/)
      await expect(page.getByTestId('shell-drawer')).toBeHidden()
      await bottom.getByTestId('bottom-nav-chats').click()
      await expect(page).toHaveURL(/\/chats$/)
    } else {
      await expect(page.getByTestId('shell-bottom-nav')).toBeHidden()
      const sidebar = page.getByTestId('shell-sidebar')
      await expect(sidebar).toBeVisible()
      expect(Math.round((await sidebar.boundingBox())!.width)).toBe(240)
      await page.getByTestId('shell-sidebar-toggle').click()
      await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
      await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(64)
      await page.reload()
      await expect(page.getByTestId('shell-sidebar')).toHaveAttribute('data-collapsed', 'true')
      await page.getByTestId('shell-sidebar-toggle').click()
      await expect(page.getByTestId('shell-sidebar')).toHaveAttribute('data-collapsed', 'false')
    }
  })

  test('AC-T23-04 nenhuma página do shell tem rolagem horizontal', async ({ page }) => {
    await loginAs(page, 'owner')
    for (const route of ['/welcome', '/chats', '/crms', '/customers', '/flows', '/settings', '/profile', '/rota-que-nao-existe']) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      await expectNoHorizontalScroll(page)
    }
    await page.context().clearCookies()
    await page.goto('/login')
    await expectNoHorizontalScroll(page)
  })
})

test.describe('T23 — 404 e home por papel', () => {
  test('AC-T23-05 rota inexistente mostra a página 404 com link para a home do papel', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/rota-que-nao-existe-t23')
    await expect(page.getByTestId('not-found')).toBeVisible()
    await page.getByTestId('not-found-home').click()
    await expect(page).toHaveURL(/\/welcome$/)

    await page.context().clearCookies()
    await loginAs(page, 'member')
    await page.goto('/outra-inexistente')
    await expect(page.getByTestId('not-found')).toBeVisible()
    await page.getByTestId('not-found-home').click()
    await expect(page).toHaveURL(/\/chats$/)
  })

  test('AC-T23-05 usuário sem permissão de dashboard não entra em loop em /welcome', async ({ page }) => {
    await loginAs(page, 'member')
    let welcomeNavs = 0
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame() && new URL(f.url()).pathname === '/welcome') welcomeNavs++
    })
    await page.goto('/welcome')
    await expect(page).toHaveURL(/\/chats$/)
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await page.waitForTimeout(1500)
    expect(pathOf(page)).toBe('/chats')
    expect(welcomeNavs).toBeLessThanOrEqual(1)

    await page.goto('/')
    await expect(page).toHaveURL(/\/chats$/)
  })
})

test.describe('T23 — 401 e APP_NAME', () => {
  test('AC-T23-06 um 401 gera uma única sonda de perfil e redireciona ao login', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/chats')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await page.waitForLoadState('networkidle')

    const probes: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/auth/profile') probes.push(r.url())
    })
    await page.context().clearCookies()
    await (await languageSelect(page)).selectOption('en')

    await expect(page).toHaveURL(/\/login\?/)
    expect(searchOf(page, 'redirect')).toBe('/chats')
    await page.waitForTimeout(800)
    expect(probes).toHaveLength(1)
  })

  test('AC-T23-06 o título da aba e o shell usam APP_NAME', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/chats')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await expect(page).toHaveTitle(/· CRM$/)
    if (isMobile(page)) await page.getByTestId('shell-drawer-open').click()
    await expect(page.getByTestId('shell-app-name').first()).toHaveText('CRM')
    await page.context().clearCookies()
    await page.goto('/login')
    await expect(page).toHaveTitle(/CRM/)
  })
})

test.describe('T23 — idioma', () => {
  async function chooseLanguage(page: Page, lang: string) {
    await (await languageSelect(page)).selectOption(lang)
    await page.keyboard.press('Escape')
  }

  async function navLabel(page: Page, id: string) {
    const scope = await nav(page)
    const text = (await scope.getByTestId(`nav-item-${id}`).innerText()).trim()
    if (isMobile(page)) await page.keyboard.press('Escape')
    return text
  }

  test('AC-T23-07 trocar para en e es muda os textos do shell e o <html lang> sem recarregar, e a escolha persiste', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/chats')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
    expect(await navLabel(page, 'chats')).toBe('Chats ao vivo')
    await page.evaluate(() => ((window as any).__t23NoReload = true))

    await chooseLanguage(page, 'en')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect(await navLabel(page, 'chats')).toBe('Live chats')
    expect(await navLabel(page, 'contacts')).toBe('Contacts')

    await chooseLanguage(page, 'es')
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')
    expect(await navLabel(page, 'chats')).toBe('Chats en vivo')
    expect(await navLabel(page, 'contacts')).toBe('Contactos')
    expect(await page.evaluate(() => (window as any).__t23NoReload)).toBe(true)

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')
    expect(await navLabel(page, 'chats')).toBe('Chats en vivo')
  })
})
