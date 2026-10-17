// AC-T108-01..04 — item "Tutoriais" e widget de suporte plugável (Playwright, desktop, harness T17).
// Contrato do Prumo (spec/reports/T108-entrega.md): testids nav-item-tutorials / support-button (data-provider) /
// support-widget-script (id e data-testid do <script>) / shell-user-menu(-logout); a config vem de GET /api/app-config
// (alternada com page.route ANTES do goto). Nada de serviço externo: o script do widget é um FAKE servido por
// context.route (registra chamadas em window.__supportCalls) e wa.me / tutoriais também são interceptados.
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { loginAs, resetSeed, SEED_PASSWORD, SEED_USERS, type SeedRole } from '../helpers/e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const TUTORIALS = 'https://tutoriais.example.test/playlist'
const CHAT_HOST = 'https://chat.example.test'
const SCRIPT = `${CHAT_HOST}/widget.js`
const SCRIPT_SLOW = `${CHAT_HOST}/slow.js` // expõe o global só 3 s depois de carregar
const SCRIPT_NEVER = `${CHAT_HOST}/never.js` // nunca expõe o global
const PHONE = '5511999998888'
const NOOPENER = /(^|\s)noopener(\s|$)/

type Support = { provider: 'none' | 'script' | 'whatsapp-link'; script_url?: string | null; phone?: string | null; script_global?: string; storage_prefix?: string }
type Calls = Array<[string, unknown?]>

/** Serve GET /api/app-config com tutoriais/suporte escolhidos (o resto como a API real). */
async function serveAppConfig(page: Page, cfg: { tutorials_url?: string | null; support?: Support }) {
  const support = {
    provider: 'none',
    script_url: null,
    phone: null,
    script_global: 'SupportChat',
    storage_prefix: 'support_chat_',
    ...cfg.support,
  }
  await page.route('**/api/app-config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ affiliate_portal_url: null, tutorials_url: cfg.tutorials_url ?? null, support }),
    }),
  )
}

const scriptCfg = (over: Partial<Support> = {}): Support => ({ provider: 'script', script_url: SCRIPT, ...over })

/** Script FAKE do widget: expõe window[global] = { identify, show, open, close } e grava chaves com o prefixo. */
function fakeScript(global: string, prefix: string, delayMs: number | null) {
  return `(function(){
  var calls = window.__supportCalls = window.__supportCalls || [];
  window.__supportScriptRuns = (window.__supportScriptRuns || 0) + 1;
  try { localStorage.setItem(${JSON.stringify(prefix + 'user')}, 'x'); localStorage.setItem(${JSON.stringify(prefix + 'conv_1')}, 'y'); } catch (e) {}
  function expose(){ window[${JSON.stringify(global)}] = {
    identify: function(u){ calls.push(['identify', JSON.parse(JSON.stringify(u))]); },
    show: function(){ calls.push(['show']); },
    open: function(){ calls.push(['open']); },
    close: function(){ calls.push(['close']); }
  }; }
  ${delayMs === null ? '' : delayMs === 0 ? 'expose();' : `setTimeout(expose, ${delayMs});`}
})();`
}

/** Intercepta o host do chat no contexto inteiro e conta os downloads do script. */
async function stubChatHost(context: BrowserContext, opts: { global?: string; prefix?: string } = {}) {
  const hits: string[] = []
  const global = opts.global ?? 'SupportChat'
  const prefix = opts.prefix ?? 'support_chat_'
  await context.route(`${CHAT_HOST}/**`, (route) => {
    const url = route.request().url()
    hits.push(url)
    const path = new URL(url).pathname
    const delay = path === '/never.js' ? null : path === '/slow.js' ? 3000 : 0
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: fakeScript(global, prefix, delay) })
  })
  return hits
}

/** Intercepta um host externo (nova aba) e registra as visitas. */
async function stubHost(context: BrowserContext, pattern: string) {
  const hits: string[] = []
  await context.route(pattern, (route) => {
    hits.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>fake</title><p>fake</p>' })
  })
  return hits
}

const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __supportCalls?: Calls }).__supportCalls ?? []) as Calls)
const callNames = async (page: Page) => (await calls(page)).map((c) => c[0])
const scriptTags = (page: Page) => page.locator('script#support-widget-script, script[src^="https://chat.example.test/"]')
const storageKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).sort())

// member e platformAdmin (role member na empresa) não têm o dashboard (/welcome redireciona para /chats)
const noDashboard = (role: SeedRole) => role === 'member' || role === 'platformAdmin'
const home = (role: SeedRole) => (role === 'support' ? /\/support\// : noDashboard(role) ? /\/chats/ : /\/welcome/)
const homePath = (role: SeedRole) => (role === 'support' ? '/support/access' : noDashboard(role) ? '/chats' : '/welcome')

async function openShell(page: Page, role: SeedRole = 'owner') {
  await loginAs(page, role)
  await page.goto(homePath(role))
  await expect(page).toHaveURL(home(role))
  await expect(page.getByTestId('shell-sidebar')).toBeVisible()
}

async function logoutByMenu(page: Page) {
  await page.getByTestId('shell-sidebar').getByTestId('shell-user-menu').click()
  await page.getByTestId('shell-user-menu-logout').click()
  await expect(page).toHaveURL(/\/login/)
}

test.describe('T108 — item "Tutoriais"', () => {
  for (const role of ['owner', 'admin', 'member', 'platformAdmin'] as const) {
    test(`AC-T108-01 com tutorials_url, ${role} vê "Tutoriais" (link externo em nova aba, rel=noopener)`, async ({ page }) => {
      await serveAppConfig(page, { tutorials_url: TUTORIALS })
      await openShell(page, role)
      const item = page.getByTestId('shell-sidebar').getByTestId('nav-item-tutorials')
      await expect(item).toBeVisible()
      await expect(item).toHaveAttribute('href', TUTORIALS)
      await expect(item).toHaveAttribute('target', '_blank')
      await expect(item).toHaveAttribute('rel', NOOPENER)
    })
  }

  test('AC-T108-01 clicar em "Tutoriais" abre a URL em nova aba sem window.opener e o app não navega', async ({ page, context }) => {
    const hits = await stubHost(context, 'https://tutoriais.example.test/**')
    await serveAppConfig(page, { tutorials_url: TUTORIALS })
    await openShell(page)
    const tabPromise = context.waitForEvent('page')
    await page.getByTestId('shell-sidebar').getByTestId('nav-item-tutorials').click()
    const tab = await tabPromise
    await tab.waitForLoadState('domcontentloaded')
    expect(tab.url()).toBe(TUTORIALS)
    expect(await tab.evaluate(() => window.opener)).toBeNull()
    expect(hits).toEqual([TUTORIALS])
    await expect(page).toHaveURL(/\/welcome/)
    await tab.close()
  })

  test('AC-T108-01 usuário support não vê "Tutoriais" mesmo com tutorials_url', async ({ page }) => {
    await serveAppConfig(page, { tutorials_url: TUTORIALS })
    const cfg = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/app-config')
    await openShell(page, 'support')
    await cfg
    await expect(page.getByTestId('shell-sidebar').locator('[data-testid^="nav-item-"]').first()).toBeVisible()
    await expect(page.getByTestId('nav-item-tutorials')).toHaveCount(0)
  })

  test('AC-T108-01 sem a variável (API real do harness: tutorials_url null) o item não existe', async ({ page }) => {
    const cfg = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/app-config')
    await openShell(page)
    const res = await cfg
    expect(res.status()).toBe(200)
    expect((await res.json()).tutorials_url).toBeNull()
    await expect(page.getByTestId('shell-sidebar').locator('[data-testid^="nav-item-"]').first()).toBeVisible()
    await expect(page.getByTestId('nav-item-tutorials')).toHaveCount(0)
    await expect(page.locator('a[href*="youtube.com"]')).toHaveCount(0)
  })

  test('AC-T108-01 tutorials_url null (config servida) não mostra o item para owner nem member', async ({ page }) => {
    await serveAppConfig(page, { tutorials_url: null })
    for (const role of ['owner', 'member'] as const) {
      const cfg = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/app-config')
      await openShell(page, role)
      await cfg
      await expect(page.getByTestId('shell-sidebar').locator('[data-testid^="nav-item-"]').first()).toBeVisible()
      await expect(page.getByTestId('nav-item-tutorials')).toHaveCount(0)
    }
  })
})

test.describe('T108 — widget de suporte (provider script)', () => {
  test('AC-T108-02 injeta o script FAKE e chama identify com e-mail, nome e telefone', async ({ page, context }) => {
    const hits = await stubChatHost(context)
    await loginAs(page, 'owner')
    const put = await page.request.put('/api/auth/profile', { data: { personal_whatsapp: '+55 11 98888-7777' }, headers: { 'x-requested-with': 'crm' } })
    expect(put.status(), await put.text()).toBe(200)
    await serveAppConfig(page, { support: scriptCfg() })
    await page.goto('/welcome')
    await expect(page).toHaveURL(/\/welcome/)

    await expect(page.locator('script#support-widget-script')).toHaveCount(1)
    await expect(page.locator('script#support-widget-script')).toHaveAttribute('src', SCRIPT)
    await expect.poll(() => callNames(page)).toContain('identify')
    const identify = (await calls(page)).find((c) => c[0] === 'identify')![1] as Record<string, string>
    expect(identify.email).toBe(SEED_USERS.owner)
    expect(identify.name).toBe('Olivia Owner')
    expect(identify.phone).toMatch(/98888.?7777/)
    expect(hits).toEqual([SCRIPT])
  })

  test('AC-T108-02 remontagem (recolher/expandir sidebar e navegar) não duplica o script', async ({ page, context }) => {
    const hits = await stubChatHost(context)
    await serveAppConfig(page, { support: scriptCfg() })
    await openShell(page)
    await expect(page.locator('script#support-widget-script')).toHaveCount(1)
    await expect.poll(() => callNames(page)).toContain('identify')

    const toggle = page.getByTestId('shell-sidebar-toggle')
    await toggle.click()
    await expect(page.getByTestId('shell-sidebar').getByTestId('support-button')).toBeVisible()
    await toggle.click()
    for (const path of ['/chats', '/customers', '/welcome']) {
      await page.goto(path) // navegação completa: novo documento, o script entra de novo uma única vez
      await expect(page).toHaveURL(new RegExp(path))
      await expect(page.getByTestId('shell-sidebar')).toBeVisible()
      await expect(scriptTags(page)).toHaveCount(1)
    }
    // navegação SPA (sem recarregar): continua um só
    await page.getByTestId('shell-sidebar').locator('a[href^="/"][data-testid^="nav-item-"]').first().click()
    await page.getByTestId('shell-sidebar').getByTestId('shell-sidebar-toggle').click()
    await page.getByTestId('shell-sidebar').getByTestId('shell-sidebar-toggle').click()
    await expect(page.getByTestId('shell-sidebar')).toBeVisible()
    await expect(scriptTags(page)).toHaveCount(1)
    expect(await page.evaluate(() => (window as unknown as { __supportScriptRuns: number }).__supportScriptRuns)).toBe(1)
    // 1 download por documento (a primeira carga + 3 gotos)
    expect(hits).toHaveLength(4)
  })

  test('AC-T108-02 identify espera o script expor o global (polling) e chama assim que ele aparece', async ({ page, context }) => {
    await stubChatHost(context)
    await serveAppConfig(page, { support: scriptCfg({ script_url: SCRIPT_SLOW }) })
    await page.clock.install()
    await openShell(page)
    await expect(page.locator('script#support-widget-script')).toHaveCount(1)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __supportScriptRuns?: number }).__supportScriptRuns ?? 0)).toBe(1)
    expect(await callNames(page)).toEqual([])
    await page.clock.runFor(3_500)
    await expect.poll(() => callNames(page)).toEqual(['identify'])
  })

  test('AC-T108-02 sem o global em 10 s desiste em silêncio (sem erro, sem identify tardio)', async ({ page, context }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error' && /support|identify|SupportChat|chat\.example/i.test(m.text())) errors.push(`console: ${m.text()}`)
    })
    await stubChatHost(context)
    await serveAppConfig(page, { support: scriptCfg({ script_url: SCRIPT_NEVER }) })
    await page.clock.install()
    await openShell(page)
    await expect(page.locator('script#support-widget-script')).toHaveCount(1)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __supportScriptRuns?: number }).__supportScriptRuns ?? 0)).toBe(1)
    await page.clock.runFor(10_500)
    // o global aparece tarde demais: o polling já desistiu
    await page.evaluate(() => {
      const w = window as unknown as { __supportCalls: Calls; SupportChat: unknown }
      w.SupportChat = { identify: (u: unknown) => w.__supportCalls.push(['identify', u]) }
    })
    await page.clock.runFor(2_000)
    expect(await callNames(page)).toEqual([])
    expect(errors).toEqual([])
    await expect(page.getByTestId('shell-sidebar')).toBeVisible()
    await expect(page).toHaveURL(/\/welcome/)
  })

  test('AC-T108-02 o nome do global vem da config (script_global)', async ({ page, context }) => {
    await stubChatHost(context, { global: 'AcmeHelp' })
    await serveAppConfig(page, { support: scriptCfg({ script_global: 'AcmeHelp' }) })
    await openShell(page)
    await expect.poll(() => callNames(page)).toContain('identify')
  })

  test('AC-T108-02 "Suporte" no modo script abre o widget (show/open) sem sair da página', async ({ page, context }) => {
    await stubChatHost(context)
    await serveAppConfig(page, { support: scriptCfg() })
    await openShell(page)
    await expect.poll(() => callNames(page)).toContain('identify')
    const btn = page.getByTestId('shell-sidebar').getByTestId('support-button')
    await expect(btn).toHaveAttribute('data-provider', 'script')
    await btn.click()
    await expect.poll(() => callNames(page)).toEqual(expect.arrayContaining(['open']))
    await expect(page).toHaveURL(/\/welcome/)
  })
})

test.describe('T108 — "Suporte" por link de WhatsApp / none', () => {
  test('AC-T108-03 whatsapp-link: "Suporte" é link para wa.me/<telefone> em nova aba (rel=noopener) e não injeta script', async ({
    page,
    context,
  }) => {
    const chat = await stubChatHost(context)
    const wa = await stubHost(context, 'https://wa.me/**')
    await serveAppConfig(page, { support: { provider: 'whatsapp-link', phone: PHONE } })
    await openShell(page)
    const btn = page.getByTestId('shell-sidebar').getByTestId('support-button')
    await expect(btn).toBeVisible()
    await expect(btn).toHaveAttribute('href', `https://wa.me/${PHONE}`)
    await expect(btn).toHaveAttribute('target', '_blank')
    await expect(btn).toHaveAttribute('rel', NOOPENER)

    const tabPromise = context.waitForEvent('page')
    await btn.click()
    const tab = await tabPromise
    await tab.waitForLoadState('domcontentloaded')
    expect(new URL(tab.url()).href).toBe(`https://wa.me/${PHONE}`)
    expect(await tab.evaluate(() => window.opener)).toBeNull()
    expect(wa).toEqual([`https://wa.me/${PHONE}`])
    await tab.close()

    await expect(page).toHaveURL(/\/welcome/)
    await expect(scriptTags(page)).toHaveCount(0)
    expect(chat).toHaveLength(0)
  })

  test('AC-T108-03 whatsapp-link continua no rodapé com a sidebar recolhida', async ({ page }) => {
    await serveAppConfig(page, { support: { provider: 'whatsapp-link', phone: PHONE } })
    await openShell(page)
    await page.getByTestId('shell-sidebar-toggle').click()
    const btn = page.getByTestId('shell-sidebar').getByTestId('support-button')
    await expect(btn).toBeVisible()
    await expect(btn).toHaveAttribute('href', `https://wa.me/${PHONE}`)
  })

  test('AC-T108-03 provider none esconde os botões de suporte e não injeta script', async ({ page, context }) => {
    const chat = await stubChatHost(context)
    await serveAppConfig(page, { tutorials_url: TUTORIALS, support: { provider: 'none' } })
    await openShell(page)
    await expect(page.getByTestId('nav-item-tutorials')).toBeVisible() // config carregada
    await expect(page.getByTestId('support-button')).toHaveCount(0)
    await expect(page.getByTestId('support-menu-item')).toHaveCount(0)
    await page.getByTestId('shell-sidebar-toggle').click()
    await expect(page.getByTestId('support-button')).toHaveCount(0)
    await page.getByTestId('shell-sidebar').getByTestId('shell-user-menu').click()
    await expect(page.getByTestId('shell-user-menu-logout')).toBeVisible()
    await expect(page.getByTestId('support-menu-item')).toHaveCount(0)
    await expect(scriptTags(page)).toHaveCount(0)
    expect(chat).toHaveLength(0)
  })

  test('AC-T108-03 sem provedor configurado (API real do harness) não há botão "Suporte"', async ({ page }) => {
    const cfg = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/app-config')
    await openShell(page)
    const body = await (await cfg).json()
    expect(body.support?.provider ?? 'none').toBe('none')
    await expect(page.getByTestId('shell-sidebar').locator('[data-testid^="nav-item-"]').first()).toBeVisible()
    await expect(page.getByTestId('support-button')).toHaveCount(0)
    await expect(scriptTags(page)).toHaveCount(0)
  })
})

test.describe('T108 — encerramento (logout / usuário support)', () => {
  test('AC-T108-04 logout fecha o widget, remove o script e limpa só as chaves do provedor', async ({ page, context }) => {
    await stubChatHost(context)
    await serveAppConfig(page, { support: scriptCfg() })
    await openShell(page)
    await expect.poll(() => callNames(page)).toContain('identify')
    await page.evaluate(() => localStorage.setItem('outra_coisa', '1'))
    expect(await storageKeys(page)).toEqual(expect.arrayContaining(['support_chat_user', 'support_chat_conv_1', 'outra_coisa']))

    await logoutByMenu(page)
    await expect.poll(() => callNames(page)).toContain('close')
    await expect(scriptTags(page)).toHaveCount(0)
    const keys = await storageKeys(page)
    expect(keys.filter((k) => k.startsWith('support_chat_'))).toEqual([])
    expect(keys).toContain('outra_coisa')
  })

  test('AC-T108-04 logout com storage_prefix configurado limpa as chaves desse prefixo', async ({ page, context }) => {
    await stubChatHost(context, { prefix: 'acme_help_' })
    await serveAppConfig(page, { support: scriptCfg({ storage_prefix: 'acme_help_' }) })
    await openShell(page)
    await expect.poll(() => callNames(page)).toContain('identify')
    expect((await storageKeys(page)).filter((k) => k.startsWith('acme_help_'))).toHaveLength(2)
    await logoutByMenu(page)
    await expect.poll(() => callNames(page)).toContain('close')
    expect((await storageKeys(page)).filter((k) => k.startsWith('acme_help_'))).toEqual([])
  })

  test('AC-T108-04 usuário support: nada de script, identify nem botão, e chaves que sobraram são apagadas', async ({ page, context }) => {
    const chat = await stubChatHost(context)
    await serveAppConfig(page, { tutorials_url: TUTORIALS, support: scriptCfg() })
    await page.goto('/login')
    await page.evaluate(() => {
      localStorage.setItem('support_chat_user', 'de-outro-usuario')
      localStorage.setItem('support_chat_conv_9', 'z')
    })
    await openShell(page, 'support')
    await expect.poll(async () => (await storageKeys(page)).filter((k) => k.startsWith('support_chat_'))).toEqual([])
    await expect(scriptTags(page)).toHaveCount(0)
    await expect(page.getByTestId('support-button')).toHaveCount(0)
    expect(await calls(page)).toEqual([])
    expect(chat).toHaveLength(0)
  })

  test('AC-T108-04 mesma aba: owner com widget → logout → entra como support pelo formulário: widget não volta', async ({ page, context }) => {
    const chat = await stubChatHost(context)
    await serveAppConfig(page, { support: scriptCfg() })
    await openShell(page)
    await expect.poll(() => callNames(page)).toContain('identify')
    await logoutByMenu(page)
    await expect.poll(() => callNames(page)).toContain('close')

    await page.getByTestId('login-email').fill(SEED_USERS.support)
    await page.getByTestId('login-password').fill(SEED_PASSWORD)
    await page.getByTestId('login-submit').click()
    await expect(page).toHaveURL(/\/support\//)
    await expect(page.getByTestId('shell-sidebar')).toBeVisible()
    await page.waitForTimeout(500)
    await expect(scriptTags(page)).toHaveCount(0)
    expect((await storageKeys(page)).filter((k) => k.startsWith('support_chat_'))).toEqual([])
    expect((await calls(page)).filter((c) => c[0] === 'identify')).toHaveLength(1) // só o do owner
    expect(chat).toHaveLength(1)
  })
})
