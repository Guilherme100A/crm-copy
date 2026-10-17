// AC-T100-01..04 — UI do admin interno (/admin?tab=), upload global de imagem (POST /api/admin/uploads + GET público
// /api/public/admin-media/:id), pop-up de aviso no app do cliente e créditos de IA. Testids combinados com o Lastro
// (spec/reports/T100-entrega.md). Só desktop (nenhum AC cita mobile).
import { expect, test, type Browser, type Page, type Request } from '@playwright/test'
import { XRW } from '../helpers/chats-e2e'
import { loginAs, resetSeed, type SeedRole } from '../helpers/e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const COMPANY = { id: '00000000-0000-4000-8000-00000000c001', name: 'Empresa Demo' } as const
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

// PNG 1x1 e 2x3 válidos (CRC ok), o 2x3 para conferir naturalWidth na prévia.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4wcAAAAJcAMlDyBJGAAAAAElFTkSuQmCC',
  'base64',
)
const PNG_2x3 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEUlEQVR4nGM4wcBwggGMERQANf0EsUHB6U0AAAAASUVORK5CYII=',
  'base64',
)
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>')

async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, data?: unknown) {
  const res =
    method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.status() === 204 ? null : res.json()
}

const upload = (page: Page, file: { name: string; mimeType: string; buffer: Buffer }) =>
  page.request.post('/api/admin/uploads', { multipart: { file }, headers: XRW })

async function openTab(page: Page, tab: string) {
  await page.goto(`/admin?tab=${tab}`)
  await expect(page).toHaveURL(new RegExp(`[?&]tab=${tab}(&|$)`))
  await expect(page.getByTestId(`admin-panel-${tab}`)).toBeVisible()
}

async function asRole(browser: Browser, baseURL: string | undefined, role: SeedRole) {
  const ctx = await browser.newContext({ baseURL })
  const page = await ctx.newPage()
  await loginAs(page, role)
  return { ctx, page }
}

/** Linhas visíveis da tabela de uma lista do admin (ids). */
const rowIds = (page: Page, prefix: string) =>
  page
    .getByTestId(`${prefix}-table`)
    .locator(`tbody tr[data-testid^="${prefix}-item-"]`)
    .evaluateAll((els, p) => els.map((e) => e.getAttribute('data-testid')!.replace(`${p}-item-`, '')), prefix)

/** Requisições GET para um caminho da API (com a query). */
function trackGets(page: Page, path: string) {
  const seen: { url: URL; at: number }[] = []
  page.on('request', (r: Request) => {
    const u = new URL(r.url())
    if (r.method() === 'GET' && u.pathname === path) seen.push({ url: u, at: Date.now() })
  })
  return seen
}

/** Requisições não-GET para /api (para provar que algo não chamou a API). */
function trackMutations(page: Page) {
  const seen: string[] = []
  page.on('request', (r: Request) => {
    const u = new URL(r.url())
    if (r.method() !== 'GET' && u.pathname.startsWith('/api/')) seen.push(`${r.method()} ${u.pathname}`)
  })
  return seen
}

const HHMM = /atualizado às \d{2}:\d{2}/

// ---------------------------------------------------------------------------------------------------------------
test.describe('T100 — hub e acesso', () => {
  test('AC-T100-01 aba inválida ou ausente volta para "Visão geral" (replace)', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await page.goto('/admin?tab=nao-existe')
    await expect(page).toHaveURL(/[?&]tab=overview(&|$)/)
    await expect(page.getByTestId('page-admin')).toBeVisible()
    await expect(page.getByTestId('admin-panel-overview')).toBeVisible()
    await expect(page.getByTestId('admin-tab-overview')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('admin-tab-overview')).toHaveText('Visão geral')
    await page.goto('/admin')
    await expect(page).toHaveURL(/[?&]tab=overview(&|$)/)
    await expect(page.getByTestId('admin-panel-overview')).toBeVisible()
    // aba válida é respeitada e as abas do AC existem (a da IA sem marca)
    for (const id of ['overview', 'users', 'accounts', 'announcements', 'banners', 'health', 'sessions', 'ai'])
      await expect(page.getByTestId(`admin-tab-${id}`)).toBeVisible()
    await expect(page.getByTestId('admin-tab-ai')).toHaveText('IA')
    await page.getByTestId('admin-tab-users').click()
    await expect(page).toHaveURL(/[?&]tab=users(&|$)/)
    await expect(page.getByTestId('admin-panel-users')).toBeVisible()
    await expect(page.getByTestId('admin-tab-users')).toHaveAttribute('aria-current', 'page')
  })

  test('AC-T100-01 item "Admin" só aparece para platform_admin; os demais não abrem /admin', async ({ page, browser, baseURL }) => {
    await loginAs(page, 'platformAdmin')
    await page.goto('/profile')
    await expect(page.getByTestId('nav-item-admin').first()).toBeVisible()
    await page.getByTestId('nav-item-admin').first().click()
    await expect(page.getByTestId('page-admin')).toBeVisible()

    for (const role of ['owner', 'admin', 'member'] as const) {
      const { ctx, page: p } = await asRole(browser, baseURL, role)
      await p.goto('/profile')
      await expect(p.getByTestId('shell-breadcrumbs').or(p.locator('main')).first()).toBeVisible()
      await expect(p.locator('[data-testid^="nav-item-"]').first()).toBeVisible()
      await expect(p.getByTestId('nav-item-admin'), `${role} não vê o item Admin`).toHaveCount(0)
      await p.goto('/admin?tab=users')
      await expect(p).not.toHaveURL(/\/admin/)
      await expect(p.getByTestId('page-admin')).toHaveCount(0)
      // e a API recusa
      expect((await p.request.get('/api/admin/users')).status()).toBe(403)
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('T100 — usuários e empresas', () => {
  test('AC-T100-02 usuários: lista paginada de 20 com "Página X de Y"', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    const before = (await api(page, 'get', '/api/admin/users?limit=1')).page.total_count as number
    const tag = uniq()
    for (let i = before; i < 21; i++)
      await api(page, 'post', '/api/admin/users', { name: `Pag ${tag} ${i}`, email: `pag-${tag}-${i}@demo.test`, password: 'Senha-123', password_confirmation: 'Senha-123' })
    const total = (await api(page, 'get', '/api/admin/users?limit=1')).page.total_count as number
    expect(total).toBe(Math.max(21, before))

    const gets = trackGets(page, '/api/admin/users')
    await openTab(page, 'users')
    await expect.poll(async () => (await rowIds(page, 'admin-users')).length).toBe(20)
    expect(gets.some((g) => g.url.searchParams.get('limit') === '20')).toBe(true)
    await expect(page.getByTestId('admin-users-page')).toHaveText(`Página 1 de ${Math.ceil(total / 20)}`)
    await expect(page.getByTestId('admin-users-prev')).toBeDisabled()
    await page.getByTestId('admin-users-next').click()
    await expect(page.getByTestId('admin-users-page')).toHaveText(`Página 2 de ${Math.ceil(total / 20)}`)
    await expect.poll(async () => (await rowIds(page, 'admin-users')).length).toBe(total - 20)
    expect(gets.some((g) => g.url.searchParams.get('page') === '2' && g.url.searchParams.get('limit') === '20')).toBe(true)
  })

  test('AC-T100-02 usuários: busca com debounce de 450 ms (só o termo final vai ao servidor)', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await openTab(page, 'users')
    await expect.poll(async () => (await rowIds(page, 'admin-users')).length).toBeGreaterThan(1)
    const gets = trackGets(page, '/api/admin/users')
    const box = page.getByTestId('admin-users-search')
    await box.pressSequentially('owner', { delay: 60 })
    const typedAt = Date.now()
    await expect.poll(() => gets.filter((g) => g.url.searchParams.get('search') === 'owner').length).toBe(1)
    const searched = gets.filter((g) => g.url.searchParams.has('search'))
    // nenhum prefixo intermediário ("o", "ow", ...) foi buscado
    expect(searched.map((g) => g.url.searchParams.get('search'))).toEqual(['owner'])
    // a busca saiu pelo menos ~450 ms depois da última tecla (limite inferior: robusto sob carga)
    expect(searched[0]!.at - typedAt).toBeGreaterThanOrEqual(380)
    await expect.poll(async () => rowIds(page, 'admin-users')).toEqual(['00000000-0000-4000-8000-000000000a02'])
    await expect(page.getByTestId('admin-users-item-email-00000000-0000-4000-8000-000000000a02')).toHaveText('owner@demo.test')

    await box.fill('zzz-nada-assim')
    await expect(page.getByTestId('admin-users-empty')).toBeVisible()
  })

  test('AC-T100-02 empresas: lista paginada de 20, busca e reinício ao trocar de aba', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    const tag = uniq()
    const before = (await api(page, 'get', '/api/admin/companies?limit=1')).page.total_count as number
    for (let i = before; i < 21; i++) await api(page, 'post', '/api/companies', { name: `Empresa ${tag} ${String(i).padStart(2, '0')}` })
    const total = (await api(page, 'get', '/api/admin/companies?limit=1')).page.total_count as number
    expect(total).toBeGreaterThanOrEqual(21)

    const gets = trackGets(page, '/api/admin/companies')
    await openTab(page, 'accounts')
    await expect.poll(async () => (await rowIds(page, 'admin-accounts')).length).toBe(20)
    expect(gets.every((g) => g.url.searchParams.get('limit') === '20')).toBe(true)
    await expect(page.getByTestId('admin-accounts-page')).toHaveText(`Página 1 de ${Math.ceil(total / 20)}`)
    await page.getByTestId('admin-accounts-next').click()
    await expect(page.getByTestId('admin-accounts-page')).toHaveText(`Página 2 de ${Math.ceil(total / 20)}`)

    // busca: debounce (só o termo final) e volta à página 1
    gets.length = 0
    await page.getByTestId('admin-accounts-search').pressSequentially('Empresa Demo', { delay: 40 })
    // (a implementação pode emitir 1 GET com a página antiga antes do reset para 1; o que vale é o termo e a página final)
    await expect.poll(() => gets.some((g) => g.url.searchParams.get('search') === 'Empresa Demo' && g.url.searchParams.get('page') === '1')).toBe(true)
    await expect(page.getByTestId('admin-accounts-page')).toHaveCount(0)
    await expect.poll(async () => rowIds(page, 'admin-accounts')).toEqual([COMPANY.id])
    expect(new Set(gets.filter((g) => g.url.searchParams.has('search')).map((g) => g.url.searchParams.get('search')))).toEqual(new Set(['Empresa Demo']))
    await expect(page.getByTestId(`admin-accounts-item-name-${COMPANY.id}`)).toHaveText(COMPANY.name)

    // trocar de aba e voltar: busca vazia e página 1
    await page.getByTestId('admin-tab-users').click()
    await expect(page.getByTestId('admin-panel-users')).toBeVisible()
    await page.getByTestId('admin-tab-accounts').click()
    await expect(page.getByTestId('admin-panel-accounts')).toBeVisible()
    await expect(page.getByTestId('admin-accounts-search')).toHaveValue('')
    await expect(page.getByTestId('admin-accounts-page')).toHaveText(`Página 1 de ${Math.ceil(total / 20)}`)
    await expect.poll(async () => (await rowIds(page, 'admin-accounts')).length).toBe(20)
  })

  test('AC-T100-02 usuários: busca e página reiniciam ao trocar de aba', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    const tag = uniq()
    for (let i = 0; i < 17; i++)
      await api(page, 'post', '/api/admin/users', { name: `Reset ${tag} ${i}`, email: `reset-${tag}-${i}@demo.test`, password: 'Senha-123', password_confirmation: 'Senha-123' })
    await openTab(page, 'users')
    await page.getByTestId('admin-users-next').click()
    await expect(page.getByTestId('admin-users-page')).toHaveText(/^Página 2 de/)
    await page.getByTestId('admin-tab-health').click()
    await expect(page.getByTestId('admin-panel-health')).toBeVisible()
    await page.getByTestId('admin-tab-users').click()
    await expect(page.getByTestId('admin-users-page')).toHaveText(/^Página 1 de/)

    await page.getByTestId('admin-users-search').fill('owner')
    await expect.poll(async () => rowIds(page, 'admin-users')).toEqual(['00000000-0000-4000-8000-000000000a02'])
    await page.getByTestId('admin-tab-accounts').click()
    await expect(page.getByTestId('admin-panel-accounts')).toBeVisible()
    await page.getByTestId('admin-tab-users').click()
    await expect(page.getByTestId('admin-users-search')).toHaveValue('')
    await expect.poll(async () => (await rowIds(page, 'admin-users')).length).toBe(20)
  })

  test('AC-T100-02 modal de usuário valida e-mail e senha ≥ 6 antes de enviar e cria o usuário', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await openTab(page, 'users')
    const muts = trackMutations(page)
    await page.getByTestId('admin-users-new').click()
    const dlg = page.getByTestId('admin-user-editor')
    await expect(dlg).toBeVisible()
    const tag = uniq()
    await page.getByTestId('admin-user-name').fill(`Novo ${tag}`)
    await page.getByTestId('admin-user-email').fill('sem-arroba')
    await page.getByTestId('admin-user-password').fill('12345')
    await page.getByTestId('admin-user-password-confirmation').fill('12345')
    await page.getByTestId('admin-user-save').click()
    await expect(page.getByTestId('admin-user-email-error')).toHaveText('E-mail inválido')
    await expect(page.getByTestId('admin-user-password-error')).toHaveText('A senha deve ter no mínimo 6 caracteres')
    expect(muts).toEqual([])

    await page.getByTestId('admin-user-email').fill(`novo-${tag}@demo.test`)
    await page.getByTestId('admin-user-password').fill('123456')
    await page.getByTestId('admin-user-password-confirmation').fill('654321')
    await page.getByTestId('admin-user-save').click()
    await expect(page.getByTestId('admin-user-email-error')).toHaveCount(0)
    await expect(page.getByTestId('admin-user-password-error')).toHaveCount(0)
    await expect(page.getByTestId('admin-user-password-confirmation-error')).toBeVisible()
    expect(muts).toEqual([])

    await page.getByTestId('admin-user-password-confirmation').fill('123456')
    await page.getByTestId('admin-user-save').click()
    await expect(page.getByTestId('admin-user-saved')).toBeVisible()
    await expect(dlg).toHaveCount(0)
    expect(muts).toEqual(['POST /api/admin/users'])
    const created = (await api(page, 'get', `/api/admin/users?search=novo-${tag}`)).items as Any[]
    expect(created).toHaveLength(1)
    expect(created[0].email).toBe(`novo-${tag}@demo.test`)
    await page.getByTestId('admin-users-search').fill(`novo-${tag}`)
    await expect(page.getByTestId(`admin-users-item-email-${created[0].id}`)).toHaveText(`novo-${tag}@demo.test`)

    // a nova senha funciona (≥ 6 aceito)
    const login = await page.context().request.fetch('/api/auth/login', {
      method: 'POST',
      data: { email: `novo-${tag}@demo.test`, password: '123456' },
      headers: XRW,
    })
    expect(login.status()).toBe(200)
  })

  test('AC-T100-02 edição: e-mail travado e senha curta recusada', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await openTab(page, 'users')
    const member = '00000000-0000-4000-8000-000000000a04'
    await page.getByTestId(`admin-users-item-edit-${member}`).click()
    await expect(page.getByTestId('admin-user-editor')).toBeVisible()
    await expect(page.getByTestId('admin-user-email')).toBeDisabled()
    await expect(page.getByTestId('admin-user-email')).toHaveValue('member@demo.test')
    const muts = trackMutations(page)
    await page.getByTestId('admin-user-password').fill('abc')
    await page.getByTestId('admin-user-password-confirmation').fill('abc')
    await page.getByTestId('admin-user-save').click()
    await expect(page.getByTestId('admin-user-password-error')).toHaveText('A senha deve ter no mínimo 6 caracteres')
    expect(muts).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('T100 — upload global de imagem (contrato HTTP)', () => {
  test('AC-T100-03 POST /api/admin/uploads: só platform_admin, só imagem raster ≤ 2 MB; GET público serve a imagem', async ({
    page,
    browser,
    baseURL,
    playwright,
  }) => {
    // não admin → 403
    const { ctx, page: owner } = await asRole(browser, baseURL, 'owner')
    expect((await upload(owner, { name: 'a.png', mimeType: 'image/png', buffer: PNG_1x1 })).status()).toBe(403)
    await ctx.close()

    await loginAs(page, 'platformAdmin')
    // SVG (mesmo declarado como PNG) e texto → 422 no campo file
    for (const f of [
      { name: 'x.svg', mimeType: 'image/svg+xml', buffer: SVG },
      { name: 'x.png', mimeType: 'image/png', buffer: SVG },
      { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('ola') },
    ]) {
      const r = await upload(page, f)
      expect(r.status(), `${f.name} ${f.mimeType}`).toBe(422)
      expect((await r.json()).error.details.fields[0].path).toBe('file')
    }
    // > 2 MB → 422
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(2 * 1024 * 1024 + 10, 0)])
    const rb = await upload(page, { name: 'big.png', mimeType: 'image/png', buffer: big })
    expect(rb.status()).toBe(422)
    // sem arquivo → 422
    const rn = await page.request.post('/api/admin/uploads', { multipart: { other: 'x' }, headers: XRW })
    expect(rn.status()).toBe(422)

    const ok = await upload(page, { name: 'ok.png', mimeType: 'image/png', buffer: PNG_2x3 })
    expect(ok.status(), await ok.text()).toBe(201)
    const body = await ok.json()
    expect(body.mime).toBe('image/png')
    expect(body.size).toBe(PNG_2x3.length)
    expect(body.url).toMatch(/^https?:\/\/[^/]+\/api\/public\/admin-media\/[^/]+$/)
    // a URL é aceita como image_url de um aviso
    await api(page, 'post', '/api/admin/announcements', { title: `Img ${uniq()}`, message: 'm', image_url: body.url, active: false })

    // GET público, sem sessão nenhuma
    const anon = await playwright.request.newContext()
    const g = await anon.get(body.url)
    expect(g.status()).toBe(200)
    expect(g.headers()['content-type']).toBe('image/png')
    expect(g.headers()['cache-control']).toContain('immutable')
    expect(Buffer.from(await g.body()).equals(PNG_2x3)).toBe(true)
    // id adulterado/sem assinatura → 404
    const forged = body.url.replace(/[^/]+$/, (id: string) => `${id.slice(0, -2)}${id.endsWith('aa') ? 'bb' : 'aa'}`)
    expect((await anon.get(forged)).status()).toBe(404)
    expect((await anon.get(body.url.replace(/[^/]+$/, 'a'.repeat(64)))).status()).toBe(404)
    await anon.dispose()
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('T100 — avisos, banners e pop-up', () => {
  test('AC-T100-03 aviso: upload de imagem com prévia, salvo com a URL pública', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await openTab(page, 'announcements')
    await page.getByTestId('admin-announcements-new').click()
    await expect(page.getByTestId('admin-announcement-editor')).toBeVisible()
    const title = `Aviso ${uniq()}`
    await page.getByTestId('admin-announcement-title').fill(title)
    await page.getByTestId('admin-announcement-message').fill('Mensagem do aviso')
    await page.getByTestId('admin-announcement-type').selectOption('warning')

    // arquivo inválido: erro e nada de prévia
    await page.getByTestId('admin-announcement-image-file').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
    await expect(page.getByTestId('admin-announcement-image-error')).toBeVisible()
    await expect(page.getByTestId('admin-announcement-image-preview')).toHaveCount(0)

    const up = page.waitForResponse((r) => r.url().includes('/api/admin/uploads') && r.request().method() === 'POST')
    await page.getByTestId('admin-announcement-image-file').setInputFiles({ name: 'ok.png', mimeType: 'image/png', buffer: PNG_2x3 })
    const res = await up
    expect(res.status()).toBe(201)
    const { url } = await res.json()
    await expect(page.getByTestId('admin-announcement-image-url')).toHaveValue(url)
    const preview = page.getByTestId('admin-announcement-image-preview')
    await expect(preview).toHaveAttribute('src', url)
    await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(2)
    await expect(page.getByTestId('admin-announcement-image-error')).toHaveCount(0)

    // remover limpa e some a prévia; reenviar volta
    await page.getByTestId('admin-announcement-image-remove').click()
    await expect(page.getByTestId('admin-announcement-image-preview')).toHaveCount(0)
    await expect(page.getByTestId('admin-announcement-image-url')).toHaveValue('')
    await page.getByTestId('admin-announcement-image-file').setInputFiles({ name: 'ok.png', mimeType: 'image/png', buffer: PNG_2x3 })
    await expect(page.getByTestId('admin-announcement-image-preview')).toBeVisible()

    await page.getByTestId('admin-announcement-save').click()
    await expect(page.getByTestId('admin-announcement-saved')).toBeVisible()
    const items = (await api(page, 'get', `/api/admin/announcements?search=${encodeURIComponent(title)}`)).items as Any[]
    expect(items).toHaveLength(1)
    expect(items[0].image_url).toMatch(/\/api\/public\/admin-media\//)
    expect(items[0].announcement_type).toBe('warning')
    expect(items[0].active).toBe(true)
    await expect(page.getByTestId(`admin-announcements-item-title-${items[0].id}`)).toHaveText(title)
  })

  test('AC-T100-03 banner: salvar desabilitado sem imagem; upload com prévia habilita e salva', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await openTab(page, 'banners')
    await page.getByTestId('admin-banners-new').click()
    await expect(page.getByTestId('admin-banner-editor')).toBeVisible()
    const title = `Banner ${uniq()}`
    await page.getByTestId('admin-banner-title').fill(title)
    await expect(page.getByTestId('admin-banner-save')).toBeDisabled()

    await page.getByTestId('admin-banner-image-file').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG_2x3 })
    const preview = page.getByTestId('admin-banner-image-preview')
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(2)
    await expect(page.getByTestId('admin-banner-save')).toBeEnabled()
    await page.getByTestId('admin-banner-image-remove').click()
    await expect(page.getByTestId('admin-banner-save')).toBeDisabled()
    await page.getByTestId('admin-banner-image-file').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG_2x3 })
    await expect(page.getByTestId('admin-banner-save')).toBeEnabled()
    await page.getByTestId('admin-banner-save').click()
    await expect(page.getByTestId('admin-banner-saved')).toBeVisible()

    const items = (await api(page, 'get', `/api/admin/banners?search=${encodeURIComponent(title)}`)).items as Any[]
    expect(items).toHaveLength(1)
    expect(items[0].image_url).toMatch(/\/api\/public\/admin-media\//)
    const img = page.getByTestId(`admin-banners-item-image-${items[0].id}`)
    await expect(img).toHaveAttribute('src', items[0].image_url)
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(2)
  })

  test('AC-T100-03 aviso ativo aparece como pop-up no app do cliente e "fechar" persiste sem chamar a API', async ({
    page,
    browser,
    baseURL,
  }) => {
    await loginAs(page, 'platformAdmin')
    const up = await upload(page, { name: 'p.png', mimeType: 'image/png', buffer: PNG_2x3 })
    expect(up.status()).toBe(201)
    const { url: imageUrl } = await up.json()
    const tag = uniq()
    const first = (
      await api(page, 'post', '/api/admin/announcements', {
        title: `Primeiro ${tag}`,
        message: 'Mensagem um',
        image_url: imageUrl,
        url: 'https://example.com/novidade',
        announcement_type: 'warning',
        priority: 10,
        active: true,
      })
    ).announcement
    const second = (
      await api(page, 'post', '/api/admin/announcements', { title: `Segundo ${tag}`, message: 'Mensagem dois', priority: 1, active: true })
    ).announcement
    // inativo nunca aparece
    await api(page, 'post', '/api/admin/announcements', { title: `Inativo ${tag}`, message: 'x', priority: 99, active: false })
    expect(first?.id && second?.id).toBeTruthy()

    // o operador não vê o pop-up dentro do /admin
    await openTab(page, 'announcements')
    await expect(page.getByTestId('admin-announcement-popup')).toHaveCount(0)

    const { ctx, page: client } = await asRole(browser, baseURL, 'owner')
    const muts = trackMutations(client)
    await client.goto('/profile')
    const popup = client.getByTestId('admin-announcement-popup')
    await expect(popup).toBeVisible()
    await expect(popup).toHaveAttribute('data-announcement-id', first.id)
    await expect(popup).toHaveAttribute('data-type', 'warning')
    await expect(client.getByTestId('admin-announcement-popup-title')).toHaveText(`Primeiro ${tag}`)
    await expect(client.getByTestId('admin-announcement-popup-message')).toHaveText('Mensagem um')
    await expect(client.getByTestId('admin-announcement-popup-link')).toHaveAttribute('href', 'https://example.com/novidade')
    const img = client.getByTestId('admin-announcement-popup-image')
    await expect(img).toHaveAttribute('src', imageUrl)
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(2)

    // fechar → próximo aviso; fechar → nenhum
    await client.getByTestId('admin-announcement-popup-close').click()
    await expect(popup).toHaveAttribute('data-announcement-id', second.id)
    await expect(client.getByTestId('admin-announcement-popup-title')).toHaveText(`Segundo ${tag}`)
    await expect(client.getByTestId('admin-announcement-popup-image')).toHaveCount(0)
    await client.getByTestId('admin-announcement-popup-close').click()
    await expect(popup).toHaveCount(0)
    expect(muts, 'fechar não chama a API').toEqual([])

    // recarregar e navegar: continua fechado para este usuário
    await client.reload()
    await expect(client.locator('main').first()).toBeVisible()
    await client.waitForResponse((r) => new URL(r.url()).pathname === '/api/announcements').catch(() => undefined)
    await client.goto('/welcome')
    await expect(client.locator('main').first()).toBeVisible()
    await client.waitForTimeout(1_000)
    await expect(popup).toHaveCount(0)
    expect(muts).toEqual([])

    // outro usuário no mesmo navegador ainda vê o aviso (fechar é por usuário)
    await loginAs(client, 'admin')
    await client.goto('/profile')
    await expect(popup).toBeVisible()
    await expect(popup).toHaveAttribute('data-announcement-id', first.id)

    // aviso desativado pelo admin some do cliente
    await api(page, 'patch', `/api/admin/announcements/${first.id}`, { active: false })
    await api(page, 'patch', `/api/admin/announcements/${second.id}`, { active: false })
    const ctx2 = await browser.newContext({ baseURL })
    const fresh = await ctx2.newPage()
    await loginAs(fresh, 'member')
    await fresh.goto('/profile')
    await expect(fresh.locator('main').first()).toBeVisible()
    await fresh.waitForTimeout(1_500)
    await expect(fresh.getByTestId('admin-announcement-popup')).toHaveCount(0)
    await ctx2.close()
    await ctx.close()
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('T100 — saúde, sessões, IA e créditos', () => {
  test('AC-T100-04 Saúde mostra "atualizado às HH:MM" e Atualizar refaz a leitura', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await openTab(page, 'health')
    await expect(page.getByTestId('admin-health-updated-at')).toHaveText(HHMM)
    await expect(page.getByTestId('admin-health-updated-at')).toContainText('Só visualização')
    await expect(page.getByTestId('admin-health-overall')).toBeVisible()
    const health = await api(page, 'get', '/api/admin/health')
    const d = new Date(health.checked_at)
    // HH:MM local (timezone do projeto: America/Sao_Paulo) de um checked_at recente
    const hhmm = (x: Date) =>
      new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo' }).format(x)
    const text = await page.getByTestId('admin-health-updated-at').innerText()
    const shown = /(\d{2}:\d{2})/.exec(text)![1]
    expect([hhmm(d), hhmm(new Date(d.getTime() - 60_000)), hhmm(new Date(d.getTime() + 60_000))]).toContain(shown)
    const again = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/health' && r.request().method() === 'GET')
    await page.getByTestId('admin-health-refresh').click()
    expect((await again).status()).toBe(200)
    await expect(page.getByTestId('admin-health-updated-at')).toHaveText(HHMM)
  })

  test('AC-T100-04 Sessões WhatsApp mostra "atualizado às HH:MM" com Atualizar', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await openTab(page, 'sessions')
    await expect(page.getByTestId('admin-tab-sessions')).toBeVisible()
    await expect(page.getByTestId('admin-sessions-updated-at')).toHaveText(HHMM)
    await expect(page.getByTestId('admin-sessions-table').or(page.getByTestId('admin-sessions-empty'))).toBeVisible()
    const again = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/wa/sessions')
    await page.getByTestId('admin-sessions-refresh').click()
    expect((await again).status()).toBe(200)
    await expect(page.getByTestId('admin-sessions-updated-at')).toHaveText(HHMM)
  })

  test('AC-T100-04 modo extensão (sessões → 404): a aba Sessões não aparece e ?tab=sessions volta para a visão geral', async ({
    page,
  }) => {
    await loginAs(page, 'platformAdmin')
    await page.route('**/api/admin/wa/sessions**', (r) =>
      r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }) }),
    )
    await page.goto('/admin?tab=sessions')
    await expect(page).toHaveURL(/[?&]tab=overview(&|$)/)
    await expect(page.getByTestId('admin-panel-overview')).toBeVisible()
    await expect(page.getByTestId('admin-tab-health')).toBeVisible()
    await expect(page.getByTestId('admin-tab-sessions')).toHaveCount(0)
    await expect(page.getByTestId('admin-panel-sessions')).toHaveCount(0)
    // as demais abas continuam
    await openTab(page, 'health')
    await expect(page.getByTestId('admin-tab-sessions')).toHaveCount(0)
    await openTab(page, 'ai')
  })

  test('AC-T100-04 IA mostra "atualizado às HH:MM" com Atualizar', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await openTab(page, 'ai')
    await expect(page.getByTestId('admin-ai-updated-at')).toHaveText(HHMM)
    await expect(page.getByTestId('admin-ai-usage').or(page.getByTestId('admin-ai-usage-empty'))).toBeVisible()
    await expect(page.getByTestId('admin-ai-wallets').or(page.getByTestId('admin-ai-wallets-empty'))).toBeVisible()
    const usage = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/ai/usage')
    await page.getByTestId('admin-ai-refresh').click()
    expect((await usage).status()).toBe(200)
    await expect(page.getByTestId('admin-ai-updated-at')).toHaveText(HHMM)
  })

  test('AC-T100-04 recarga de créditos: nota obrigatória e confirmação antes do POST; saldo aparece na aba IA', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await openTab(page, 'accounts')
    const muts = trackMutations(page)
    await page.getByTestId(`admin-accounts-item-credits-${COMPANY.id}`).click()
    await expect(page.getByTestId('admin-credits-editor')).toBeVisible()
    await page.getByTestId('admin-credits-amount').fill('500')
    // sem nota: erro e nada enviado
    await page.getByTestId('admin-credits-save').click()
    await expect(page.getByTestId('admin-credits-note-error')).toHaveText('Informe a nota')
    await expect(page.getByTestId('admin-credits-confirm')).toHaveCount(0)
    // nota só com espaços também não vale
    await page.getByTestId('admin-credits-note').fill('   ')
    await page.getByTestId('admin-credits-save').click()
    await expect(page.getByTestId('admin-credits-note-error')).toHaveText('Informe a nota')
    // recarga ≤ 0 recusada
    await page.getByTestId('admin-credits-amount').fill('0')
    await page.getByTestId('admin-credits-note').fill('Bônus de boas-vindas')
    await page.getByTestId('admin-credits-save').click()
    await expect(page.getByTestId('admin-credits-amount-error')).toBeVisible()
    expect(muts).toEqual([])

    // confirmação: cancelar não envia
    await page.getByTestId('admin-credits-amount').fill('500')
    await page.getByTestId('admin-credits-save').click()
    await expect(page.getByTestId('admin-credits-confirm')).toBeVisible()
    await expect(page.getByTestId('admin-credits-confirm')).toContainText('Recarregar 500 créditos para Empresa Demo?')
    await page.getByTestId('admin-credits-confirm-cancel').click()
    await expect(page.getByTestId('admin-credits-confirm')).toHaveCount(0)
    expect(muts).toEqual([])

    // confirmar envia com a nota
    await page.getByTestId('admin-credits-save').click()
    const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/api/platform/companies/${COMPANY.id}/ai/topups`))
    await page.getByTestId('admin-credits-confirm-ok').click()
    const req = await post
    expect(req.postDataJSON()).toMatchObject({ credits: 500, note: 'Bônus de boas-vindas' })
    await expect(page.getByTestId('admin-credits-saved')).toBeVisible()
    expect(muts).toEqual([`POST /api/platform/companies/${COMPANY.id}/ai/topups`])

    await page.getByTestId('admin-tab-ai').click()
    await expect(page.getByTestId(`admin-ai-item-${COMPANY.id}`)).toBeVisible()
    await expect(page.getByTestId(`admin-ai-item-balance-${COMPANY.id}`)).toContainText('500')
  })

  test('AC-T100-04 ajuste de créditos (negativo) pela aba IA com nota obrigatória e confirmação', async ({ page }) => {
    await loginAs(page, 'platformAdmin')
    await api(page, 'post', `/api/platform/companies/${COMPANY.id}/ai/topups`, { credits: 300, note: 'base' })
    await openTab(page, 'ai')
    await expect(page.getByTestId(`admin-ai-item-balance-${COMPANY.id}`)).toContainText('300')
    const muts = trackMutations(page)
    await page.getByTestId(`admin-ai-item-adjust-${COMPANY.id}`).click()
    await expect(page.getByTestId('admin-credits-editor')).toBeVisible()
    await page.getByTestId('admin-credits-amount').fill('-120')
    await page.getByTestId('admin-credits-save').click()
    await expect(page.getByTestId('admin-credits-note-error')).toHaveText('Informe a nota')
    expect(muts).toEqual([])
    await page.getByTestId('admin-credits-note').fill('Estorno de uso indevido')
    await page.getByTestId('admin-credits-save').click()
    await expect(page.getByTestId('admin-credits-confirm')).toBeVisible()
    await expect(page.getByTestId('admin-credits-confirm')).toContainText('Empresa Demo')
    expect(muts).toEqual([])
    const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/api/platform/companies/${COMPANY.id}/ai/adjustments`))
    await page.getByTestId('admin-credits-confirm-ok').click()
    expect((await post).postDataJSON()).toMatchObject({ credits: -120, note: 'Estorno de uso indevido' })
    await expect(page.getByTestId('admin-credits-saved')).toBeVisible()
    await expect(page.getByTestId(`admin-ai-item-balance-${COMPANY.id}`)).toContainText('180')
    const wallets = (await api(page, 'get', '/api/platform/ai/wallets')).items as Any[]
    expect(wallets.find((w) => w.company_id === COMPANY.id)?.balance_credits).toBe(180)
  })
})
