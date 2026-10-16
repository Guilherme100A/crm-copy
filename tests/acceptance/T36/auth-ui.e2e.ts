// AC-T36-01..07 — telas públicas, reset, troca de empresa, convite, mobile e idioma (Playwright, desktop e mobile, harness T17).
// Contrato de data-testid combinado com o Torno.
import { expect, test, type Page, type Request } from '@playwright/test'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed, SEED_PASSWORD, SEED_USERS } from '../helpers/e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const H = { 'x-requested-with': 'crm' }
const pathOf = (page: Page) => new URL(page.url()).pathname
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

async function uiLogin(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByTestId('login-email').fill(email)
  await page.getByTestId('login-password').fill(password)
  await page.getByTestId('login-submit').click()
}

/** E-mails capturados pelo harness para um destinatário. */
async function mailsTo(page: Page, to: string) {
  const res = await page.request.get('/__e2e/mail')
  expect(res.status()).toBe(200)
  const { items } = await res.json()
  return (items as any[]).filter((m) => JSON.stringify(m.to).toLowerCase().includes(to.toLowerCase()))
}

const tokenFrom = (mail: any) => {
  const body = `${mail.text ?? ''}\n${mail.html ?? ''}`
  for (const raw of body.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    const t = new URL(raw.replace(/&amp;/g, '&')).searchParams.get('token')
    if (t) return t
  }
  throw new Error(`e-mail sem token: ${body.slice(0, 300)}`)
}

/** Seletor de empresa visível (topo da sidebar no desktop; dentro do drawer no mobile). */
async function openSwitcher(page: Page) {
  if (isMobile(page) && !(await page.getByTestId('company-switcher-trigger').filter({ visible: true }).count())) {
    await page.getByTestId('shell-drawer-open').click()
  }
  const trigger = page.getByTestId('company-switcher-trigger').filter({ visible: true }).first()
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByTestId('company-switcher-popup')).toBeVisible()
}
/** Nome da empresa ativa no seletor (no mobile abre o drawer para lê-lo). */
async function currentCompany(page: Page) {
  if (isMobile(page) && !(await page.getByTestId('company-switcher-current').filter({ visible: true }).count())) {
    await page.getByTestId('shell-drawer-open').click()
  }
  return page.getByTestId('company-switcher-current').filter({ visible: true }).first()
}

/** Registra os EventSource abertos/fechados pela página (o log de rede do Playwright só mostra o SSE ao fechar). */
async function trackEventSources(page: Page) {
  await page.addInitScript(() => {
    const w = window as any
    w.__es = [] as Array<{ url: string; closed: boolean }>
    const Orig = w.EventSource
    w.EventSource = class extends Orig {
      constructor(url: string, init?: any) {
        super(url, init)
        const rec = { url: String(new URL(url, location.href)), closed: false }
        w.__es.push(rec)
        const close = this.close.bind(this)
        this.close = () => {
          rec.closed = true
          close()
        }
      }
    }
  })
  return async () => (await page.evaluate(() => (window as any).__es ?? [])) as Array<{ url: string; closed: boolean }>
}
const companyOf = (url: string) => new URL(url).searchParams.get('company_id')

async function createCompany(page: Page, name: string) {
  const res = await page.request.post('/api/companies', { data: { name }, headers: H })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()).company as { id: string; name: string }
}

test.describe('T36 — login', () => {
  // home do papel (homeOf da T23): owner/admin → /welcome; member (sem dashboard) → /chats
  for (const [role, home] of [
    ['owner', '/welcome'],
    ['admin', '/welcome'],
    ['member', '/chats'],
  ] as const) {
    test(`AC-T36-01 login do ${role} do seed leva à home do papel (${home})`, async ({ page }) => {
      await uiLogin(page, SEED_USERS[role], SEED_PASSWORD)
      await expect(page).toHaveURL(new RegExp(`${home}$`))
    })
  }

  test('AC-T36-01 credencial errada mostra erro na tela sem limpar o e-mail', async ({ page }) => {
    await uiLogin(page, SEED_USERS.owner, 'senha-errada-123')
    await expect(page.getByTestId('login-error')).toBeVisible()
    expect(pathOf(page)).toBe('/login')
    await expect(page.getByTestId('login-email')).toHaveValue(SEED_USERS.owner)
  })

  test('AC-T36-01 login com ?redirect seguro volta para a rota pedida', async ({ page }) => {
    await page.goto('/login?redirect=%2Fprofile')
    await page.getByTestId('login-email').fill(SEED_USERS.owner)
    await page.getByTestId('login-password').fill(SEED_PASSWORD)
    await page.getByTestId('login-submit').click()
    await expect(page).toHaveURL(/\/profile/)
  })
})

test.describe('T36 — cadastro', () => {
  test('AC-T36-02 senhas diferentes não enviam o formulário', async ({ page }) => {
    const posts: Request[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/auth/register')) posts.push(r)
    })
    await page.goto('/register')
    await page.getByTestId('register-name').fill('Pessoa Teste')
    await page.getByTestId('register-email').fill(`t36-${uniq()}@example.test`)
    await page.getByTestId('register-password').fill('Senha-forte-123')
    await page.getByTestId('register-password-confirmation').fill('Senha-forte-124')
    await page.getByTestId('register-submit').click()
    await expect(page.getByTestId('register-password-mismatch')).toBeVisible()
    await page.waitForTimeout(500)
    expect(posts).toHaveLength(0)
    expect(pathOf(page)).toBe('/register')
  })

  test('AC-T36-02 cadastro válido redireciona para /login com o e-mail preenchido', async ({ page }) => {
    const email = `t36-${uniq()}@example.test`
    await page.goto('/register')
    await page.getByTestId('register-name').fill('Pessoa Nova')
    await page.getByTestId('register-email').fill(email)
    await page.getByTestId('register-password').fill('Senha-forte-123')
    await page.getByTestId('register-password-confirmation').fill('Senha-forte-123')
    await page.getByTestId('register-submit').click()
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByTestId('login-email')).toHaveValue(email)
    await expect(page.getByTestId('login-message')).toBeVisible()
    // a conta existe de fato
    await page.getByTestId('login-password').fill('Senha-forte-123')
    await page.getByTestId('login-submit').click()
    await expect(page).not.toHaveURL(/\/login/)
  })
})

test.describe('T36 — reset de senha', () => {
  async function requestReset(page: Page, email: string) {
    await page.goto('/forgot-password')
    await page.getByTestId('forgot-password-email').fill(email)
    await page.getByTestId('forgot-password-submit').click()
    await expect(page.getByTestId('forgot-password-sent')).toBeVisible()
    const mails = await mailsTo(page, email)
    expect(mails.length).toBeGreaterThanOrEqual(1)
    return tokenFrom(mails.at(-1))
  }

  test('AC-T36-03 token válido troca a senha e redireciona para o login', async ({ page }) => {
    const token = await requestReset(page, SEED_USERS.admin)
    await page.goto(`/reset-password?token=${encodeURIComponent(token)}`)
    await expect(page.getByTestId('reset-password-form')).toBeVisible()
    await page.getByTestId('reset-password-password').fill('Nova-senha-t36')
    await page.getByTestId('reset-password-confirmation').fill('Nova-senha-t36')
    await page.getByTestId('reset-password-submit').click()
    await expect(page.getByTestId('reset-password-success')).toBeVisible()
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
    await uiLogin(page, SEED_USERS.admin, 'Nova-senha-t36')
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('AC-T36-03 link já usado ou inválido mostra "link inválido ou expirado"', async ({ page }) => {
    const token = await requestReset(page, SEED_USERS.member)
    const used = await page.request.patch(`/api/auth/password-resets/${encodeURIComponent(token)}`, {
      data: { password: 'Outra-senha-t36', password_confirmation: 'Outra-senha-t36' },
      headers: H,
    })
    expect(used.status(), await used.text()).toBeLessThan(300)
    for (const t of [token, 'token-que-nao-existe-t36-1234567890']) {
      await page.goto(`/reset-password?token=${encodeURIComponent(t)}`)
      await expect(page.getByTestId('reset-password-invalid')).toBeVisible()
      await expect(page.getByTestId('reset-password-form')).toHaveCount(0)
    }
    await page.goto('/reset-password')
    await expect(page.getByTestId('reset-password-invalid')).toBeVisible()
  })
})

test.describe('T36 — troca de empresa', () => {
  test('AC-T36-04 trocar de empresa atualiza o header, recarrega os dados com a nova empresa e reabre o SSE', async ({ page }) => {
    const eventSources = await trackEventSources(page)
    const login = await loginAs(page, 'owner')
    const demoId: string = login.companies.find((c: any) => c.name === 'Empresa Demo').id
    const b = await createCompany(page, `Filial ${uniq()}`)
    await page.goto('/welcome')
    await expect(await currentCompany(page)).toHaveText(/Empresa Demo/)
    await expect.poll(async () => (await eventSources()).some((e) => companyOf(e.url) === demoId && !e.closed), { timeout: 20_000 }).toBe(true)

    const apiCalls: Request[] = []
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) apiCalls.push(r)
    })
    await openSwitcher(page)
    await page.getByTestId(`company-switcher-item-${b.id}`).click()

    // SSE reaberto para a nova empresa e o da empresa anterior fechado
    await expect.poll(async () => (await eventSources()).some((e) => companyOf(e.url) === b.id && !e.closed), { timeout: 20_000 }).toBe(true)
    expect((await eventSources()).filter((e) => companyOf(e.url) === demoId).every((e) => e.closed)).toBe(true)
    await expect(await currentCompany(page)).toHaveText(new RegExp(b.name))

    // dados recarregados com o cabeçalho da nova empresa
    await expect.poll(() => apiCalls.some((r) => r.method() === 'GET' && !r.url().includes('/api/events') && r.headers()['x-company-id'] === b.id)).toBe(true)
    const afterSwitch = apiCalls.filter((r) => r.method() === 'GET' && r.headers()['x-company-id'])
    expect(afterSwitch.at(-1)!.headers()['x-company-id']).toBe(b.id)
    // a lista do seletor é refeita: o item ativo passa a ser a nova empresa
    if (!(await page.getByTestId('company-switcher-popup').isVisible())) await openSwitcher(page)
    await expect(page.getByTestId(`company-switcher-item-${b.id}`)).toHaveAttribute('data-active', 'true')
    const demoActive = page.locator('[data-testid^="company-switcher-item-"][data-active="true"]')
    await expect(demoActive).toHaveCount(1)
    await page.keyboard.press('Escape')

    // a escolha persiste ao recarregar a página
    await page.reload()
    await expect(await currentCompany(page)).toHaveText(new RegExp(b.name))
  })

  test('AC-T36-04 busca do seletor filtra e criar empresa pelo seletor a lista', async ({ page }) => {
    await loginAs(page, 'owner')
    const name = `Unidade ${uniq()}`
    await page.goto('/welcome')
    await openSwitcher(page)
    await page.getByTestId('company-switcher-create').click()
    await page.getByTestId('company-switcher-create-name').fill(name)
    await page.getByTestId('company-switcher-create-submit').click()
    await expect(page.getByTestId('company-switcher-popup').getByText(name)).toBeVisible()
    await page.getByTestId('company-switcher-search').fill(name.slice(-6))
    await expect(page.getByTestId('company-switcher-popup').getByText(name)).toBeVisible()
    await expect(page.getByTestId('company-switcher-popup').getByText('Empresa Demo')).toHaveCount(0)
  })
})

test.describe('T36 — convite', () => {
  test('AC-T36-05 convite aberto sem login leva ao login com retorno ao convite; aceitar mostra a empresa nova no seletor', async ({ page, context }) => {
    await loginAs(page, 'owner')
    const b = await createCompany(page, `Parceira ${uniq()}`)
    const inv = await page.request.post('/api/team/invitations', {
      data: { email: SEED_USERS.member, role: 'member' },
      headers: { ...H, 'x-company-id': b.id },
    })
    expect(inv.status(), await inv.text()).toBe(201)
    const link = new URL((await inv.json()).invitation_link)
    await context.clearCookies()

    await page.goto(link.pathname)
    await expect(page).toHaveURL(/\/login/)
    expect(new URL(page.url()).searchParams.get('redirect')).toBe(link.pathname)
    await page.getByTestId('login-email').fill(SEED_USERS.member)
    await page.getByTestId('login-password').fill(SEED_PASSWORD)
    await page.getByTestId('login-submit').click()

    await expect(page.getByTestId('invitation-page')).toBeVisible()
    await expect(page.getByTestId('invitation-company')).toHaveText(new RegExp(b.name))
    await page.getByTestId('invitation-accept').click()
    await expect(page).not.toHaveURL(/\/invitations?\//)
    await openSwitcher(page)
    await expect(page.getByTestId(`company-switcher-item-${b.id}`)).toBeVisible()
  })

  test('AC-T36-05 o caminho singular /invitation/:token leva ao mesmo convite', async ({ page }) => {
    await loginAs(page, 'owner')
    const b = await createCompany(page, `Outra ${uniq()}`)
    const inv = await page.request.post('/api/team/invitations', { data: { email: SEED_USERS.admin, role: 'member' }, headers: { ...H, 'x-company-id': b.id } })
    expect(inv.status(), await inv.text()).toBe(201)
    const token = new URL((await inv.json()).invitation_link).pathname.split('/').pop()!
    await page.context().clearCookies()
    await page.goto(`/invitation/${token}`)
    await expect(page).toHaveURL(/\/login/)
    expect(new URL(page.url()).searchParams.get('redirect')).toContain(token)
  })
})

test.describe('T36 — mobile', () => {
  test('AC-T36-06 telas públicas sem rolagem horizontal', async ({ page }) => {
    // cada rota precisa mostrar a sua tela (senão uma página 404 passaria sem rolagem)
    const screens: Array<[string, string]> = [
      ['/login', 'login-form'],
      ['/register', 'register-form'],
      ['/cadastro', 'register-form'],
      ['/forgot-password', 'forgot-password-form'],
      ['/reset-password?token=x', 'reset-password-invalid'],
      ['/invitations/x', 'invitation-page|login-form'], // token desconhecido: tela do convite (inválido) ou login
    ]
    for (const [route, testId] of screens) {
      await page.goto(route)
      const [first, second] = testId.split('|') as [string, string | undefined]
      const screen = second ? page.getByTestId(first).or(page.getByTestId(second)) : page.getByTestId(first)
      await expect(screen.first(), route).toBeVisible()
      await page.waitForLoadState('networkidle')
      await expectNoHorizontalScroll(page)
    }
  })

  test('AC-T36-06 telas autenticadas (welcome, perfil nas 3 abas, seletor aberto) sem rolagem horizontal', async ({ page }) => {
    await loginAs(page, 'owner')
    const screens: Array<[string, string]> = [
      // no mobile o seletor fica dentro do drawer: a âncora é o botão do drawer
      ['/welcome', isMobile(page) ? 'shell-drawer-open' : 'company-switcher-trigger'],
      ['/profile?tab=personal', 'profile-name'],
      ['/profile?tab=security', 'profile-password-current'],
      ['/profile?tab=preferences', 'profile-locale'],
    ]
    for (const [route, testId] of screens) {
      await page.goto(route)
      await expect(page.getByTestId(testId).filter({ visible: true }).first(), route).toBeVisible()
      await page.waitForLoadState('networkidle')
      await expectNoHorizontalScroll(page)
    }
    await page.goto('/welcome')
    await openSwitcher(page)
    await expectNoHorizontalScroll(page)
    if (isMobile(page)) expect(page.viewportSize()!.width).toBe(390)
  })
})

test.describe('T36 — idioma', () => {
  for (const locale of ['en', 'es'] as const) {
    test(`AC-T36-07 Preferências → ${locale} salva o locale no servidor e vale após novo login`, async ({ page, context }) => {
      await loginAs(page, 'owner')
      await page.goto('/profile?tab=preferences')
      await page.getByTestId('profile-locale').selectOption(locale)
      const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/api/auth/profile'))
      await page.getByTestId('profile-preferences-save').click()
      await put
      await expect(page.getByTestId('profile-preferences-saved')).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', locale)

      const profile = await (await page.request.get('/api/auth/profile')).json()
      expect(profile.user.locale).toBe(locale)

      await context.clearCookies()
      await uiLogin(page, SEED_USERS.owner, SEED_PASSWORD)
      await expect(page).not.toHaveURL(/\/login/)
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await page.goto('/profile?tab=preferences')
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
    })
  }
})
