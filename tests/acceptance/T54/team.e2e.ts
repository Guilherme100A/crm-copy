// AC-T54-01..05 — UI de Equipe, permissões, convites e acesso de suporte (hub /settings?tab=team|platform_invitations
// e modal global do shell). Testids combinados com o Esquadro (brief T54, "Entrega do operário"). Só desktop.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { loginAs, resetSeed, SEED_PASSWORD, SEED_USERS } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'
import { dbUrl, lit, sqlOk } from '../helpers/pg'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

// ids fixos do seed-base (packages/db/src/seed/base.ts) e do usuário de suporte (seed/modules/support-user.ts)
const ID = {
  platformAdmin: '00000000-0000-4000-8000-000000000a01',
  owner: '00000000-0000-4000-8000-000000000a02',
  admin: '00000000-0000-4000-8000-000000000a03',
  member: '00000000-0000-4000-8000-000000000a04',
  support: '00000000-0000-4000-8000-000000000a05',
} as const

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, data?: unknown) {
  const res =
    method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

const team = async (page: Page): Promise<Any[]> => (await api(page, 'get', '/api/team')).items
const memberOf = async (page: Page, userId: string) => (await team(page)).find((m) => m.user_id === userId)

/** Banco do harness deste worktree (test-results/e2e-server.json). */
function harnessDb(): string {
  const info = JSON.parse(readFileSync(join(process.cwd(), 'test-results', 'e2e-server.json'), 'utf8'))
  return dbUrl(info.database)
}

async function newUser(browser: Browser, baseURL: string | undefined, role: keyof typeof SEED_USERS) {
  const ctx = await browser.newContext({ baseURL })
  const page = await ctx.newPage()
  await loginAs(page, role)
  return { ctx, page }
}

const openTab = async (page: Page, tab: string) => {
  await page.goto(`/settings?tab=${tab}`)
  await expect(page).toHaveURL(new RegExp(`[?&]tab=${tab}`))
}

/** Linhas da tabela da equipe na ordem da tela (user_id). */
const rowIds = (page: Page) =>
  page
    .getByTestId('team-table')
    .locator('tbody tr[data-testid^="team-item-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('team-item-', '')))

const countOf = async (page: Page, group: string) => {
  const txt = (await page.getByTestId(`permissions-group-count-${group}`).innerText()).trim()
  const m = /^(\d+) ativa\(s\)$/.exec(txt)
  expect(m, `contador "${txt}"`).not.toBeNull()
  return Number(m![1])
}

// ---------------------------------------------------------------------------------------------------------------
test.describe('T54 — Equipe (lista)', () => {
  test('AC-T54-01 lista ordena owner < admin < member e filtra por papel', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'team')
    await expect(page.getByTestId('team-table')).toBeVisible()
    // owner, admin, depois os members por nome ("Admin da Plataforma" < "Maria Member")
    await expect.poll(() => rowIds(page)).toEqual([ID.owner, ID.admin, ID.platformAdmin, ID.member])
    await expect(page.getByTestId(`team-item-role-${ID.owner}`)).toHaveAttribute('data-role', 'owner')
    await expect(page.getByTestId(`team-item-role-${ID.admin}`)).toHaveAttribute('data-role', 'admin')
    await expect(page.getByTestId(`team-item-role-${ID.member}`)).toHaveAttribute('data-role', 'member')

    const role = page.getByTestId('team-filter-role')
    await role.selectOption('admin')
    await expect.poll(() => rowIds(page)).toEqual([ID.admin])
    await role.selectOption('member')
    await expect.poll(() => rowIds(page)).toEqual([ID.platformAdmin, ID.member])
    await role.selectOption('owner')
    await expect.poll(() => rowIds(page)).toEqual([ID.owner])
    await role.selectOption('all')
    await expect.poll(() => rowIds(page)).toEqual([ID.owner, ID.admin, ID.platformAdmin, ID.member])
  })

  test('AC-T54-01 filtro por departamento e "Sem departamento"', async ({ page }) => {
    await loginAs(page, 'owner')
    const dept = (await api(page, 'post', '/api/departments', { name: `Vendas ${uniq()}`, color: '#3b82f6' })).department
    const other = (await api(page, 'post', '/api/departments', { name: `Suporte ${uniq()}`, color: '#ef4444' })).department
    const member = await memberOf(page, ID.member)
    const admin = await memberOf(page, ID.admin)
    await api(page, 'put', `/api/departments/members/${member.id}/scope`, { department_ids: [dept.id] })
    await api(page, 'put', `/api/departments/members/${admin.id}/scope`, { department_ids: [dept.id, other.id] })

    await openTab(page, 'team')
    await expect(page.getByTestId('team-table')).toBeVisible()
    await expect(page.getByTestId(`team-item-${ID.member}`)).toContainText(dept.name)
    await expect(page.getByTestId(`team-item-${ID.owner}`)).toContainText('Sem departamento')

    const filter = page.getByTestId('team-filter-department')
    await expect(filter.locator('option[value="none"]')).toHaveText('Sem departamento')
    await filter.selectOption(dept.id)
    await expect.poll(() => rowIds(page)).toEqual([ID.admin, ID.member])
    await filter.selectOption(other.id)
    await expect.poll(() => rowIds(page)).toEqual([ID.admin])
    await filter.selectOption('none')
    await expect.poll(() => rowIds(page)).toEqual([ID.owner, ID.platformAdmin])

    // papel + departamento combinados
    await page.getByTestId('team-filter-role').selectOption('member')
    await expect.poll(() => rowIds(page)).toEqual([ID.platformAdmin])
    await filter.selectOption(dept.id)
    await expect.poll(() => rowIds(page)).toEqual([ID.member])
  })

  test('AC-T54-01 sem team.view: aba oculta e, com a permissão revogada na sessão aberta, "Acesso negado"', async ({
    page,
    browser,
    baseURL,
  }) => {
    await loginAs(page, 'owner')
    const { ctx, page: member } = await newUser(browser, baseURL, 'member')

    // member padrão não tem team.view: a aba não aparece e ?tab=team cai em outra aba
    await member.goto('/settings?tab=team')
    await expect(member.getByTestId('page-settings')).toBeVisible()
    await expect(member).not.toHaveURL(/[?&]tab=team/)
    await expect(member.getByTestId('settings-tab-team')).toHaveCount(0)
    await expect(member.getByTestId('team-settings')).toHaveCount(0)

    // com team.view a aba aparece; revogada com a sessão aberta (perfil em cache), a carga da lista dá 403 → "Acesso negado"
    const base = (await memberOf(page, ID.member)).effective_permissions as string[]
    await api(page, 'patch', `/api/team/${ID.member}`, { permission_keys: [...base, 'team.view'] })
    await member.goto('/settings?tab=accounts')
    await expect(member.getByTestId('settings-tab-team')).toBeVisible()
    await expect(member.getByTestId('company-info')).toBeVisible()

    await api(page, 'patch', `/api/team/${ID.member}`, { permission_keys: base.filter((k) => k !== 'team.view') })
    const res = member.waitForResponse((r) => new URL(r.url()).pathname === '/api/team' && r.request().method() === 'GET')
    await member.getByTestId('settings-tab-team').click()
    expect((await res).status()).toBe(403)
    await expect(member.getByTestId('team-denied')).toBeVisible()
    await expect(member.getByTestId('team-denied')).toContainText('Acesso negado')
    await expect(member.getByTestId('team-table')).toHaveCount(0)
    await ctx.close()
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('T54 — Modal de permissões', () => {
  test('AC-T54-02 matriz área × ação aplica dependências e atualiza "N ativa(s)"; salvar grava a lista', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'team')
    await page.getByTestId(`team-permissions-${ID.member}`).click()
    const modal = page.getByTestId('permissions-modal')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('permissions-matrix')).toBeVisible()
    await expect(page.getByTestId('permissions-owner-locked')).toHaveCount(0)

    const cell = (area: string, a: 'view' | 'edit' | 'delete') => page.getByTestId(`permissions-cell-${area}-${a}`)
    // member padrão: ver etiquetas sim, editar/excluir não
    await expect(cell('labels', 'view')).toBeChecked()
    await expect(cell('labels', 'edit')).not.toBeChecked()
    await expect(cell('labels', 'delete')).not.toBeChecked()
    const n0 = await countOf(page, 'settings')

    // tirar "ver" → contador -1
    await cell('labels', 'view').uncheck()
    await expect(cell('labels', 'view')).not.toBeChecked()
    await expect.poll(() => countOf(page, 'settings')).toBe(n0 - 1)
    // marcar "excluir" marca "ver" junto (dependência) → +2
    await cell('labels', 'delete').check()
    await expect(cell('labels', 'view')).toBeChecked()
    await expect(cell('labels', 'edit')).not.toBeChecked()
    await expect.poll(() => countOf(page, 'settings')).toBe(n0 + 1)
    // marcar "editar" em outra área também liga o "ver" dela
    await cell('products', 'view').uncheck()
    await cell('products', 'edit').check()
    await expect(cell('products', 'view')).toBeChecked()
    await expect.poll(() => countOf(page, 'settings')).toBe(n0 + 2)
    // tirar "ver" tira editar e excluir
    await cell('products', 'view').uncheck()
    await expect(cell('products', 'edit')).not.toBeChecked()
    await expect.poll(() => countOf(page, 'settings')).toBe(n0)

    // texto do contador no formato "N ativa(s)"
    await expect(page.getByTestId('permissions-group-count-settings')).toHaveText(`${n0} ativa(s)`)

    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/team/${ID.member}`)
    await page.getByTestId('permissions-save').click()
    expect((await patch).status()).toBeLessThan(300)
    await expect(modal).toHaveCount(0)
    const saved = (await memberOf(page, ID.member)).permission_keys as string[]
    expect(saved).toEqual(expect.arrayContaining(['settings.labels.view', 'settings.labels.delete', 'settings.view']))
    expect(saved).not.toContain('settings.labels.edit')
    expect(saved).not.toContain('settings.products.view')
    expect(saved).not.toContain('settings.products.edit')

    // reabrir mostra o salvo
    await page.getByTestId(`team-permissions-${ID.member}`).click()
    await expect(cell('labels', 'delete')).toBeChecked()
    await expect(cell('products', 'view')).not.toBeChecked()
  })

  test('AC-T54-02 escopo do chat só habilitado com chat.view; bloquear contato liga chat.view', async ({ page }) => {
    await loginAs(page, 'owner')
    const dept = (await api(page, 'post', '/api/departments', { name: `Escopo ${uniq()}`, color: '#22c55e' })).department
    await openTab(page, 'team')
    await page.getByTestId(`team-permissions-${ID.member}`).click()
    await expect(page.getByTestId('permissions-modal')).toBeVisible()
    await page.getByTestId('permissions-group-toggle-chat').click()

    const chatView = page.getByTestId('permissions-key-chat.view')
    const chatBlock = page.getByTestId('permissions-key-chat.block')
    const scope = page.getByTestId('permissions-scope')
    const deptBox = page.getByTestId(`permissions-scope-department-${dept.id}`)
    await expect(chatView).toBeChecked()
    await expect(page.getByTestId('permissions-group-count-chat')).toHaveText('1 ativa(s)')
    await expect(scope).toHaveAttribute('data-enabled', 'true')
    await expect(deptBox).toBeEnabled()

    await chatView.uncheck()
    await expect(page.getByTestId('permissions-group-count-chat')).toHaveText('0 ativa(s)')
    await expect(scope).toHaveAttribute('data-enabled', 'false')
    await expect(deptBox).toBeDisabled()

    // chat.block ⇒ chat.view
    await chatBlock.check()
    await expect(chatView).toBeChecked()
    await expect(page.getByTestId('permissions-group-count-chat')).toHaveText('2 ativa(s)')
    await expect(scope).toHaveAttribute('data-enabled', 'true')
    await expect(deptBox).toBeEnabled()
    // tirar chat.view tira chat.block
    await chatView.uncheck()
    await expect(chatBlock).not.toBeChecked()
    await expect(scope).toHaveAttribute('data-enabled', 'false')

    // com chat.view de volta, o escopo grava
    await chatView.check()
    await deptBox.check()
    await page.getByTestId('permissions-save').click()
    await expect(page.getByTestId('permissions-modal')).toHaveCount(0)
    const m = await memberOf(page, ID.member)
    await expect
      .poll(async () => (await api(page, 'get', `/api/departments/members/${m.id}/scope`)).scope.department_ids)
      .toEqual([dept.id])
  })

  test('AC-T54-02 owner aparece travado (tudo marcado, nada editável, sem salvar)', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'team')
    await page.getByTestId(`team-permissions-${ID.owner}`).click()
    await expect(page.getByTestId('permissions-modal')).toBeVisible()
    await expect(page.getByTestId('permissions-owner-locked')).toBeVisible()
    await expect(page.getByTestId('permissions-save')).toHaveCount(0)
    const cells = page.locator('[data-testid^="permissions-cell-"]')
    expect(await cells.count()).toBeGreaterThanOrEqual(13 * 3)
    for (const c of await cells.all()) {
      await expect(c).toBeChecked()
      await expect(c).toBeDisabled()
    }
    await page.getByTestId('permissions-cancel').click()
    await expect(page.getByTestId('permissions-modal')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
test.describe('T54 — Transferir propriedade', () => {
  test('AC-T54-03 mostra as consequências; cancelar não muda; confirmar troca os papéis na lista', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'team')
    await expect(page.getByTestId('team-table')).toBeVisible()
    // só para admin
    await expect(page.getByTestId(`team-transfer-${ID.member}`)).toHaveCount(0)
    await expect(page.getByTestId(`team-transfer-${ID.owner}`)).toHaveCount(0)

    await page.getByTestId(`team-transfer-${ID.admin}`).click()
    const dialog = page.getByTestId('transfer-dialog')
    await expect(dialog).toBeVisible()
    const cons = page.getByTestId('transfer-consequences')
    await expect(cons.locator('li')).toHaveCount(4)
    for (const k of ['newOwner', 'youAdmin', 'billing', 'irreversible'])
      await expect(page.getByTestId(`transfer-consequence-${k}`)).not.toBeEmpty()
    await expect(page.getByTestId('transfer-consequence-newOwner')).toContainText('Alan Admin')
    await page.getByTestId('transfer-cancel').click()
    await expect(dialog).toHaveCount(0)
    expect((await memberOf(page, ID.owner)).role).toBe('owner')

    await page.getByTestId(`team-transfer-${ID.admin}`).click()
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/team/${ID.admin}/transfer-ownership`))
    await page.getByTestId('transfer-confirm').click()
    expect((await post).status()).toBeLessThan(300)
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId(`team-item-role-${ID.admin}`)).toHaveAttribute('data-role', 'owner')
    await expect(page.getByTestId(`team-item-role-${ID.owner}`)).toHaveAttribute('data-role', 'admin')
    await expect.poll(() => rowIds(page)).toEqual([ID.admin, ID.owner, ID.platformAdmin, ID.member])
    expect((await memberOf(page, ID.admin)).role).toBe('owner')
    expect((await memberOf(page, ID.owner)).role).toBe('admin')
    // quem deixou de ser owner não vê mais o botão de transferir
    await expect(page.locator('[data-testid^="team-transfer-"]')).toHaveCount(0)
    // persiste após recarregar
    await page.reload()
    await expect(page.getByTestId(`team-item-role-${ID.admin}`)).toHaveAttribute('data-role', 'owner')
    await expect(page.getByTestId(`team-item-role-${ID.owner}`)).toHaveAttribute('data-role', 'admin')
  })
})

// ---------------------------------------------------------------------------------------------------------------
const tokenOf = (link: string) => {
  const u = new URL(link)
  return u.searchParams.get('token') ?? u.pathname.split('/').filter(Boolean).pop()!
}

async function platformInvite(page: Page, role: 'admin' | 'member' = 'member') {
  const email = `conv-${uniq()}@exemplo.test`
  const r = await api(page, 'post', '/api/team/invitations', { kind: 'platform', email, role })
  return { id: r.invitation.id as string, email, link: r.invitation_link as string }
}

test.describe('T54 — Convites para Plataforma', () => {
  test('AC-T54-04 cards de contagem por status e filtro', async ({ page, request }) => {
    await loginAs(page, 'owner')
    const p1 = await platformInvite(page)
    const p2 = await platformInvite(page, 'admin')
    const dec = await platformInvite(page)
    const exp = await platformInvite(page)
    const acc = await platformInvite(page)
    const d = await request.post(`/api/invitations/${tokenOf(dec.link)}/decline`, { headers: XRW })
    expect(d.status(), await d.text()).toBeLessThan(300)
    const a = await request.post(`/api/invitations/${tokenOf(acc.link)}/accept`, {
      headers: XRW,
      data: { name: 'Pessoa Convidada', password: SEED_PASSWORD, password_confirmation: SEED_PASSWORD },
    })
    expect(a.status(), await a.text()).toBeLessThan(300)
    sqlOk(harnessDb(), `UPDATE crm.invitations SET expires_at = now() - interval '1 day' WHERE id = ${lit(exp.id)};`)

    await openTab(page, 'platform_invitations')
    await expect(page.getByTestId('invitations-settings')).toBeVisible()
    const value = (k: string) => page.getByTestId(`invitations-count-${k}-value`)
    await expect(value('total')).toHaveText('5')
    await expect(value('pending')).toHaveText('2')
    await expect(value('accepted')).toHaveText('1')
    await expect(value('declined')).toHaveText('1')
    await expect(value('expired')).toHaveText('1')

    const items = page.locator('[data-testid^="invitations-item-"]')
    await expect(items).toHaveCount(5)
    const filter = page.getByTestId('invitations-filter-status')
    await filter.selectOption('pending')
    await expect(items).toHaveCount(2)
    await expect(page.getByTestId(`invitations-item-${p1.id}`)).toHaveAttribute('data-status', 'pending')
    await expect(page.getByTestId(`invitations-item-${p2.id}`)).toBeVisible()
    await filter.selectOption('expired')
    await expect(items).toHaveCount(1)
    await expect(page.getByTestId(`invitations-item-${exp.id}`)).toHaveAttribute('data-status', 'expired')
    await filter.selectOption('declined')
    await expect(items).toHaveCount(1)
    await expect(page.getByTestId(`invitations-item-${dec.id}`)).toHaveAttribute('data-status', 'declined')
    await filter.selectOption('accepted')
    await expect(items).toHaveCount(1)
    await expect(page.getByTestId(`invitations-item-${acc.id}`)).toHaveAttribute('data-status', 'accepted')
    // card clicável também filtra
    await page.getByTestId('invitations-count-pending').click()
    await expect(filter).toHaveValue('pending')
    await expect(items).toHaveCount(2)
    await page.getByTestId('invitations-count-total').click()
    await expect(items).toHaveCount(5)
    // contagens não dependem do filtro
    await expect(value('pending')).toHaveText('2')
  })

  test('AC-T54-04 copiar link gera um link novo, copia para a área de transferência e invalida o anterior', async ({
    page,
    context,
    request,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await loginAs(page, 'owner')
    const inv = await platformInvite(page)
    await openTab(page, 'platform_invitations')
    const res = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/team/invitations/${inv.id}/link`))
    await page.getByTestId(`invitations-copy-${inv.id}`).click()
    const fresh = (await (await res).json()).invitation_link as string
    expect(fresh).toBeTruthy()
    expect(fresh).not.toBe(inv.link)
    await expect(page.getByTestId(`invitations-link-${inv.id}`)).toHaveValue(fresh)
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fresh)
    // o link novo vale; o anterior não
    expect((await request.get(`/api/invitations/${tokenOf(fresh)}`)).status()).toBe(200)
    expect((await request.get(`/api/invitations/${tokenOf(inv.link)}`)).status()).toBeGreaterThanOrEqual(400)
  })

  test('AC-T54-04 reenviar 3 vezes esgota: botão desabilitado e "Limite de 3 reenvios por dia"', async ({ page }) => {
    await loginAs(page, 'owner')
    const inv = await platformInvite(page)
    await openTab(page, 'platform_invitations')
    const btn = page.getByTestId(`invitations-resend-${inv.id}`)
    for (let i = 0; i < 3; i++) {
      await expect(btn).toBeEnabled()
      const res = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/team/invitations/${inv.id}/resend`))
      await btn.click()
      expect((await res).status()).toBeLessThan(300)
    }
    const err = page.getByTestId(`invitations-resend-error-${inv.id}`)
    await expect(err).toBeVisible()
    await expect(err).toHaveAttribute('data-reason', 'limit')
    await expect(err).toContainText('Limite de 3 reenvios por dia')
    await expect(btn).toBeDisabled()
    // o servidor confirma o esgotamento
    const r = await page.request.post(`/api/team/invitations/${inv.id}/resend`, { headers: XRW })
    expect(r.status()).toBe(429)
    // ao recarregar, o estado esgotado continua
    await page.reload()
    await expect(page.getByTestId(`invitations-resend-error-${inv.id}`)).toContainText('Limite de 3 reenvios por dia')
    await expect(page.getByTestId(`invitations-resend-${inv.id}`)).toBeDisabled()
  })

  test('AC-T54-04 o 429 resend_limit do servidor também mostra "Limite de 3 reenvios por dia"', async ({ page }) => {
    await loginAs(page, 'owner')
    const inv = await platformInvite(page)
    await openTab(page, 'platform_invitations')
    await expect(page.getByTestId(`invitations-resend-${inv.id}`)).toBeEnabled()
    // esgota por fora da tela (a lista na tela ainda acha que pode reenviar)
    for (let i = 0; i < 3; i++) await api(page, 'post', `/api/team/invitations/${inv.id}/resend`)
    const res = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/team/invitations/${inv.id}/resend`))
    await page.getByTestId(`invitations-resend-${inv.id}`).click()
    expect((await res).status()).toBe(429)
    const err = page.getByTestId(`invitations-resend-error-${inv.id}`)
    await expect(err).toHaveAttribute('data-reason', 'limit')
    await expect(err).toContainText('Limite de 3 reenvios por dia')
    await expect(page.getByTestId(`invitations-resend-${inv.id}`)).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------------------------------------------
/** Segundo usuário de suporte (o seed só tem um; cada suporte tem no máximo 1 pedido pendente por empresa). */
function ensureSupport2(): string {
  const email = 'support2@demo.test'
  sqlOk(
    harnessDb(),
    `INSERT INTO crm.users (email, password_hash, name, system_role)
     SELECT ${lit(email)}, password_hash, 'Sergio Suporte', 'support' FROM crm.users WHERE id = ${lit(ID.support)}
     ON CONFLICT DO NOTHING;`,
  )
  return email
}

test.describe('T54 — Acesso de suporte', () => {
  test('AC-T54-05 pedido por SSE abre o modal global; aprovar e recusar avançam para o próximo pendente', async ({
    page,
    browser,
    baseURL,
  }) => {
    // owner numa tela qualquer, com o SSE aberto antes do pedido
    const sse = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/events')
    await loginAs(page, 'owner')
    await page.goto('/settings?tab=team')
    await expect(page.getByTestId('team-table')).toBeVisible()
    await sse
    await expect(page.getByTestId('support-approval-modal')).toHaveCount(0)

    // suporte 1 pede pela própria tela (/support/access)
    const { ctx, page: support } = await newUser(browser, baseURL, 'support')
    await support.goto('/')
    await expect(support).toHaveURL(/\/support\/access/)
    await expect(support.getByTestId('page-support-access-real')).toBeVisible()
    await support.getByTestId('support-request-email').fill(SEED_USERS.owner)
    const sent = support.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/support/access-requests')
    await support.getByTestId('support-request-submit').click()
    expect((await sent).status()).toBe(201)
    await expect(support.locator('[data-testid^="support-requests-item-"][data-status="pending"]')).toHaveCount(1)

    const modal = page.getByTestId('support-approval-modal')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('support-approval-text')).toContainText('Sofia Suporte')
    await expect(page.getByTestId('support-approval-text')).toContainText(SEED_USERS.support)
    await expect(page.getByTestId('support-approval-count')).toHaveCount(0)
    const firstId = await modal.getAttribute('data-request-id')

    // suporte 2 pede pela API: chega por SSE e a fila passa a 2
    const s2email = ensureSupport2()
    const ctx2 = await browser.newContext({ baseURL })
    const s2 = await ctx2.newPage()
    const login2 = await s2.request.post('/api/auth/login', { data: { email: s2email, password: SEED_PASSWORD }, headers: XRW })
    expect(login2.status(), await login2.text()).toBe(200)
    const req2 = (await api(s2, 'post', '/api/support/access-requests', { email: SEED_USERS.owner })).request
    await expect(page.getByTestId('support-approval-count')).toBeVisible()
    await expect(page.getByTestId('support-approval-count')).toContainText('2')
    // o modal continua no primeiro
    await expect(modal).toHaveAttribute('data-request-id', firstId!)

    // aprovar o primeiro → mostra o próximo (suporte 2)
    const approve = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/support-access/requests/${firstId}/approve`))
    await page.getByTestId('support-approval-approve').click()
    expect((await approve).status()).toBeLessThan(300)
    await expect(modal).toHaveAttribute('data-request-id', req2.id)
    await expect(page.getByTestId('support-approval-text')).toContainText('Sergio Suporte')
    await expect(page.getByTestId('support-approval-count')).toHaveCount(0)

    // recusar o segundo → fila vazia, modal fecha
    const reject = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/support-access/requests/${req2.id}/reject`))
    await page.getByTestId('support-approval-reject').click()
    expect((await reject).status()).toBeLessThan(300)
    await expect(modal).toHaveCount(0)

    // efeitos no servidor
    const grants = (await api(page, 'get', '/api/support-access/grants')).grants as Any[]
    expect(grants.map((g) => g.support_user_id)).toEqual([ID.support])
    const all = (await api(page, 'get', '/api/support-access/requests?status=all')).requests as Any[]
    expect(all.find((r) => r.id === firstId)?.status).toBe('approved')
    expect(all.find((r) => r.id === req2.id)?.status).toBe('rejected')
    // concessão aparece na aba de suporte da empresa
    await openTab(page, 'support_access')
    await expect(page.getByTestId(`support-grants-item-${ID.support}`)).toBeVisible()
    // e na tela do suporte
    await support.reload()
    await expect(support.locator('[data-testid^="support-my-grants-item-"]')).toHaveCount(1)
    await ctx.close()
    await ctx2.close()
  })

  test('AC-T54-05 pendentes já existentes abrem o modal ao entrar; cancelado pelo suporte sai da fila por SSE', async ({
    page,
    browser,
    baseURL,
  }) => {
    const { ctx, page: support } = await newUser(browser, baseURL, 'support')
    const req1 = (await api(support, 'post', '/api/support/access-requests', { email: SEED_USERS.owner })).request
    const s2email = ensureSupport2()
    const ctx2 = await browser.newContext({ baseURL })
    const s2 = await ctx2.newPage()
    const login2 = await s2.request.post('/api/auth/login', { data: { email: s2email, password: SEED_PASSWORD }, headers: XRW })
    expect(login2.status(), await login2.text()).toBe(200)
    const req2 = (await api(s2, 'post', '/api/support/access-requests', { email: SEED_USERS.owner })).request

    // admin também revisa (owner/admin)
    const sse = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/events')
    await loginAs(page, 'admin')
    await page.goto('/settings?tab=team')
    await sse
    const modal = page.getByTestId('support-approval-modal')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('support-approval-count')).toContainText('2')
    await expect(modal).toHaveAttribute('data-request-id', req1.id)

    // o suporte 1 cancela: o modal avança sozinho para o próximo
    await api(support, 'delete', `/api/support/access-requests/${req1.id}`)
    await expect(modal).toHaveAttribute('data-request-id', req2.id)
    await expect(page.getByTestId('support-approval-count')).toHaveCount(0)

    // member não vê o modal
    const { ctx: mctx, page: member } = await newUser(browser, baseURL, 'member')
    await member.goto('/settings')
    await expect(member.getByTestId('page-settings')).toBeVisible()
    await expect(member.getByTestId('support-approval-modal')).toHaveCount(0)

    await page.getByTestId('support-approval-reject').click()
    await expect(modal).toHaveCount(0)
    await ctx.close()
    await ctx2.close()
    await mctx.close()
  })
})
