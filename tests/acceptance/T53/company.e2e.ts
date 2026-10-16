// AC-T53-01..05 — UI da aba Empresa no hub /settings?tab=accounts: Dados Corporativos (nome, fuso por papel,
// desativar/reativar), Departamentos (paleta de 10 cores, cor própria, busca no servidor, exclusão com diálogo),
// Horários de Trabalho (conexão com status, intervalo padrão 09:00–18:00, validação igual à do servidor) e o hub
// (replace da aba inválida/sem permissão; select pesquisável no mobile). Testids combinados com o Prumo (brief T53).
import { expect, test, type Page } from '@playwright/test'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed, SEED_USERS } from '../helpers/e2e'
import { createConnection, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

async function companyId(page: Page): Promise<string> {
  const me = await api(page, 'get', '/api/auth/profile')
  const id = me.companies?.find((c: any) => c.id === me.user?.last_company_id)?.id ?? me.companies?.[0]?.id
  expect(id, JSON.stringify(me).slice(0, 300)).toBeTruthy()
  return id
}

async function company(page: Page) {
  return (await api(page, 'get', `/api/companies/${await companyId(page)}`)).company
}

/** Troca as permissões do membro do seed (o owner precisa estar logado em `page`). */
async function setMemberPerms(page: Page, keys: string[]) {
  const team = await api(page, 'get', '/api/team')
  const m = (team.items ?? team.members ?? team).find((x: any) => (x.email ?? x.user?.email) === SEED_USERS.member)
  await api(page, 'patch', `/api/team/${m.user_id ?? m.user?.id}`, { permission_keys: keys })
}

// URL da home depois que o redirect e os replaces do hub (?tab=, ?company_tab=) assentaram:
// sob carga o replace chega depois do primeiro not.toHaveURL(/\/$/), e capturar antes deixa o start errado
async function settledUrl(page: Page): Promise<string> {
  await expect(page).not.toHaveURL(/\/$/)
  if (new URL(page.url()).pathname === '/settings') await expect(page).toHaveURL(/[?&]tab=/)
  let last = page.url()
  let stable = 0
  await expect
    .poll(
      () => {
        const now = page.url()
        stable = now === last ? stable + 1 : 0
        last = now
        return stable
      },
      { intervals: [250], timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(4)
  return last
}

const openTab = (page: Page, companyTab: 'info' | 'departments' | 'hours') =>
  page.goto(`/settings?tab=accounts&company_tab=${companyTab}`)

test.describe('T53 — Dados Corporativos', () => {
  test('AC-T53-01 /settings?tab=accounts mostra os dados da empresa e salva', async ({ page }) => {
    await loginAs(page, 'owner')
    const c = await company(page)
    await page.goto('/settings?tab=accounts')
    await expect(page).toHaveURL(/company_tab=info/)
    await expect(page.getByTestId('company-info')).toBeVisible()
    await expect(page.getByTestId('company-name')).toHaveValue(c.name)
    await expect(page.getByTestId('company-slug')).toHaveValue(c.slug)
    await expect(page.getByTestId('company-time-zone')).toHaveValue(c.time_zone)
    await expect(page.getByTestId('company-status')).toHaveAttribute('data-active', 'true')

    const name = `Empresa ${uniq()}`
    await page.getByTestId('company-name').fill(name)
    await page.getByTestId('company-time-zone').selectOption('America/Manaus')
    await page.getByTestId('company-save').click()
    await expect(page.getByTestId('company-saved')).toBeVisible()
    await expect.poll(async () => (await company(page)).name).toBe(name)
    expect((await company(page)).time_zone).toBe('America/Manaus')
    await page.reload()
    await expect(page.getByTestId('company-name')).toHaveValue(name)
    await expect(page.getByTestId('company-time-zone')).toHaveValue('America/Manaus')
  })

  test('AC-T53-01 salvar fica desabilitado com nome vazio', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'info')
    const save = page.getByTestId('company-save')
    await expect(save).toBeEnabled()
    await page.getByTestId('company-name').fill('')
    await expect(save).toBeDisabled()
    await page.getByTestId('company-name').fill('   ')
    await expect(save).toBeDisabled()
    await page.getByTestId('company-name').fill('Outra')
    await expect(save).toBeEnabled()
  })

  test('AC-T53-01 fuso editável por owner e admin; member vê bloqueado e sem salvar', async ({ page, browser, baseURL }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'info')
    await expect(page.getByTestId('company-time-zone')).toBeEnabled()

    const adminCtx = await browser.newContext({ baseURL })
    const admin = await adminCtx.newPage()
    await loginAs(admin, 'admin')
    await openTab(admin, 'info')
    await expect(admin.getByTestId('company-time-zone')).toBeEnabled()
    await admin.getByTestId('company-time-zone').selectOption('America/Bogota')
    await admin.getByTestId('company-save').click()
    await expect(admin.getByTestId('company-saved')).toBeVisible()
    await expect.poll(async () => (await company(page)).time_zone).toBe('America/Bogota')
    await adminCtx.close()

    const memberCtx = await browser.newContext({ baseURL })
    const member = await memberCtx.newPage()
    await loginAs(member, 'member')
    await openTab(member, 'info')
    await expect(member.getByTestId('company-info')).toBeVisible()
    await expect(member.getByTestId('company-time-zone')).toBeDisabled()
    await expect(member.getByTestId('company-time-zone-hint')).toBeVisible()
    await expect(member.getByTestId('company-save')).toHaveCount(0)
    await expect(member.getByTestId('company-readonly')).toBeVisible()
    await memberCtx.close()
  })

  test('AC-T53-02 desativar abre diálogo crítico com os efeitos e exige confirmação; reativar volta ao normal', async ({ page, browser, baseURL }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'info')
    await expect(page.getByTestId('company-status')).toHaveAttribute('data-active', 'true')

    // cancelar não desativa
    await page.getByTestId('company-deactivate').click()
    const dialog = page.getByTestId('company-deactivate-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('role', 'alertdialog')
    await expect(page.getByTestId('company-deactivate-effects').locator('li')).toHaveCount(4)
    await page.getByTestId('company-deactivate-dialog-cancel').click()
    await expect(dialog).toHaveCount(0)
    expect((await company(page)).active).toBe(true)

    // confirmar desativa
    await page.getByTestId('company-deactivate').click()
    const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && /\/api\/companies\/[^/]+$/.test(new URL(r.url()).pathname))
    await page.getByTestId('company-deactivate-dialog-ok').click()
    expect((await del).status()).toBeLessThan(300)
    await expect(page.getByTestId('company-deactivated')).toBeVisible()
    await expect(page.getByTestId('company-status')).toHaveAttribute('data-active', 'false')
    await expect(page.getByTestId('company-inactive-banner')).toBeVisible()
    expect((await company(page)).active).toBe(false)

    // a tela continua acessível para reativar (recarregando)
    await page.reload()
    await expect(page.getByTestId('company-inactive-banner')).toBeVisible()
    await page.getByTestId('company-reactivate').click()
    await page.getByTestId('company-reactivate-dialog-ok').click()
    await expect(page.getByTestId('company-reactivated')).toBeVisible()
    await expect(page.getByTestId('company-status')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('company-inactive-banner')).toHaveCount(0)
    await expect(page.getByTestId('company-deactivate')).toBeVisible()
    expect((await company(page)).active).toBe(true)
    // outras rotas voltam a responder
    const res = await page.request.get('/api/departments?page=1&limit=20')
    expect(res.status()).toBe(200)

    // só o owner desativa
    const adminCtx = await browser.newContext({ baseURL })
    const admin = await adminCtx.newPage()
    await loginAs(admin, 'admin')
    await openTab(admin, 'info')
    await expect(admin.getByTestId('company-status')).toBeVisible()
    await expect(admin.getByTestId('company-deactivate')).toHaveCount(0)
    await adminCtx.close()
  })
})

test.describe('T53 — Departamentos', () => {
  test('AC-T53-03 paleta de 10 cores: criar com cor da paleta', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'departments')
    await page.getByTestId('departments-new').click()
    await expect(page.getByTestId('departments-form')).toBeVisible()
    const ids = ['blue', 'red', 'green', 'amber', 'purple', 'orange', 'cyan', 'lime', 'pink', 'gray']
    for (const id of ids) await expect(page.getByTestId(`departments-color-${id}`)).toBeVisible()
    await expect(page.locator('[data-testid^="departments-color-"][role="radio"]')).toHaveCount(10)

    const name = `Vendas ${uniq()}`
    await page.getByTestId('departments-form-name').fill(name)
    await page.getByTestId('departments-color-purple').click()
    await expect(page.getByTestId('departments-color-purple')).toHaveAttribute('aria-checked', 'true')
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/departments')
    await page.getByTestId('departments-form-save').click()
    const created = (await (await post).json()).department
    expect(created.color.toUpperCase()).toBe('#8B5CF6')
    await expect(page.getByTestId('departments-saved')).toBeVisible()
    await expect(page.getByTestId(`departments-item-name-${created.id}`)).toHaveText(name)
    await expect(page.getByTestId(`departments-item-color-${created.id}`)).toHaveAttribute('data-color', /#8B5CF6/i)
  })

  test('AC-T53-03 criar com cor própria (hex), validar e persistir', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'departments')
    await page.getByTestId('departments-new').click()
    const name = `Suporte ${uniq()}`
    await page.getByTestId('departments-form-name').fill(name)
    await page.getByTestId('departments-color-custom').fill('#12zz')
    await expect(page.getByTestId('departments-form-save')).toBeDisabled()
    await page.getByTestId('departments-color-custom').fill('#123abc')
    await expect(page.getByTestId('departments-form-save')).toBeEnabled()
    await expect(page.locator('[data-testid^="departments-color-"][role="radio"][aria-checked="true"]')).toHaveCount(0)
    await expect(page.getByTestId('departments-color-kind')).toContainText('#123ABC')
    await page.getByTestId('departments-form-save').click()
    await expect(page.getByTestId('departments-saved')).toBeVisible()

    const list = await api(page, 'get', `/api/departments?page=1&limit=20&search=${encodeURIComponent(name)}`)
    const d = list.items.find((x: any) => x.name === name)
    expect(d?.color?.toUpperCase()).toBe('#123ABC')
    await expect(page.getByTestId(`departments-item-color-${d.id}`)).toHaveAttribute('data-color', /#123ABC/i)
  })

  test('AC-T53-03 buscar pelo servidor e excluir com diálogo de confirmação', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const a = (await api(page, 'post', '/api/departments', { name: `Financeiro ${tag}` })).department
    const b = (await api(page, 'post', '/api/departments', { name: `Logística ${tag}`, color: '#EF4444' })).department
    await openTab(page, 'departments')
    await expect(page.getByTestId(`departments-item-${a.id}`)).toBeVisible()
    await expect(page.getByTestId(`departments-item-${b.id}`)).toBeVisible()

    const searched = page.waitForRequest((r) => {
      const u = new URL(r.url())
      return u.pathname === '/api/departments' && (u.searchParams.get('search') ?? '').toLowerCase() === 'financeiro'
    })
    await page.getByTestId('departments-search').fill('financeiro')
    await searched
    await expect(page.getByTestId(`departments-item-${a.id}`)).toBeVisible()
    await expect(page.getByTestId(`departments-item-${b.id}`)).toHaveCount(0)

    await page.getByTestId('departments-search').fill(`nada-${tag}`)
    await expect(page.getByTestId('departments-empty')).toBeVisible()
    await page.getByTestId('departments-search').fill('')
    await expect(page.getByTestId(`departments-item-${b.id}`)).toBeVisible()

    // cancelar mantém
    await page.getByTestId(`departments-item-delete-${a.id}`).click()
    await expect(page.getByTestId('departments-confirm')).toBeVisible()
    await page.getByTestId('departments-confirm-cancel').click()
    await expect(page.getByTestId('departments-confirm')).toHaveCount(0)
    await expect(page.getByTestId(`departments-item-${a.id}`)).toBeVisible()

    // confirmar exclui
    await page.getByTestId(`departments-item-delete-${a.id}`).click()
    await expect(page.getByTestId('departments-confirm')).toContainText(`Financeiro ${tag}`)
    await page.getByTestId('departments-confirm-ok').click()
    await expect(page.getByTestId('departments-deleted')).toBeVisible()
    await expect(page.getByTestId(`departments-item-${a.id}`)).toHaveCount(0)
    const all = await api(page, 'get', '/api/departments/all')
    expect(all.items.map((x: any) => x.id)).not.toContain(a.id)
    expect(all.items.map((x: any) => x.id)).toContain(b.id)
  })
})

test.describe('T53 — Horários de Trabalho', () => {
  test('AC-T53-04 escolher a conexão (com status), adicionar intervalo 09:00–18:00 e salvar persiste', async ({ page }) => {
    await loginAs(page, 'owner')
    const c1 = await createConnection(page, `Loja A ${uniq()}`)
    const c2 = await createConnection(page, `Loja B ${uniq()}`)
    await openTab(page, 'hours')
    const select = page.getByTestId('hours-connection')
    await expect(select).toBeVisible()
    await expect(select.locator(`option[value="${c1.id}"]`)).toHaveText(new RegExp(`${c1.name} — Pendente`))
    await expect(select.locator(`option[value="${c2.id}"]`)).toHaveText(new RegExp(`${c2.name} — Pendente`))
    await select.selectOption(c2.id)
    await expect(page.getByTestId('hours-connection-status')).toHaveAttribute('data-status', 'pending')

    await page.getByTestId('hours-add-1').click()
    await expect(page.getByTestId('hours-interval-start-0')).toHaveValue('09:00')
    await expect(page.getByTestId('hours-interval-end-0')).toHaveValue('18:00')
    await expect(page.getByTestId('hours-interval-0')).toHaveAttribute('data-day', '1')
    await page.getByTestId('hours-add-1').click()
    await page.getByTestId('hours-interval-start-1').fill('19:00')
    await page.getByTestId('hours-interval-end-1').fill('24:00')
    await page.getByTestId('hours-add-5').click()
    await page.getByTestId('hours-active').click()
    await page.getByTestId('hours-action-message').check()
    await page.getByTestId('hours-message').fill('Voltamos amanhã às 9h.')

    const put = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/business-hours/${c2.id}`)
    await page.getByTestId('hours-save').click()
    expect((await put).status()).toBe(200)
    await expect(page.getByTestId('hours-saved')).toBeVisible()

    const { config } = await api(page, 'get', `/api/business-hours/${c2.id}`)
    expect(config.active).toBe(true)
    expect(config.action_type).toBe('message')
    expect(config.message_text).toBe('Voltamos amanhã às 9h.')
    const rows = config.business_hours
      .map((h: any) => `${h.day_of_week} ${h.start_time.slice(0, 5)}-${h.end_time.slice(0, 5)}`)
      .sort()
    expect(rows).toEqual(['1 09:00-18:00', '1 19:00-24:00', '5 09:00-18:00'])
    // a outra conexão não foi tocada
    expect((await api(page, 'get', `/api/business-hours/${c1.id}`)).config.business_hours).toHaveLength(0)

    await page.reload()
    await page.getByTestId('hours-connection').selectOption(c2.id)
    await expect(page.locator('[data-testid^="hours-interval-start-"]')).toHaveCount(3)
    await expect(page.getByTestId('hours-active')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('hours-message')).toHaveValue('Voltamos amanhã às 9h.')
  })

  test('AC-T53-04 validação igual à do servidor (horário, fim > início, 24:00, mensagem/fluxo)', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page, `Loja V ${uniq()}`)
    await openTab(page, 'hours')
    await expect(page.getByTestId('hours-panel')).toBeVisible()
    await page.getByTestId('hours-add-2').click()

    const putReqs: string[] = []
    page.on('request', (r) => r.method() === 'PUT' && r.url().includes('/api/business-hours/') && putReqs.push(r.url()))

    // fim antes do início: cliente e servidor recusam no mesmo campo
    await page.getByTestId('hours-interval-start-0').fill('18:00')
    await page.getByTestId('hours-interval-end-0').fill('09:00')
    await expect(page.getByTestId('hours-interval-error-0')).toBeVisible()
    await expect(page.getByTestId('hours-interval-end-0')).toHaveAttribute('aria-invalid', 'true')
    const srv = await page.request.put(`/api/business-hours/${conn.id}`, {
      headers: XRW,
      data: { active: false, business_hours: [{ day_of_week: 2, start_time: '18:00', end_time: '09:00' }] },
    })
    expect(srv.status()).toBe(422)
    expect(JSON.stringify(await srv.json())).toContain('business_hours.0.end_time')

    // formato inválido
    await page.getByTestId('hours-interval-start-0').fill('25:00')
    await page.getByTestId('hours-interval-end-0').fill('26:00')
    await expect(page.getByTestId('hours-interval-start-0')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('hours-interval-error-0')).toBeVisible()

    // 24:00 não vale como início
    await page.getByTestId('hours-interval-start-0').fill('24:00')
    await page.getByTestId('hours-interval-end-0').fill('24:00')
    await expect(page.getByTestId('hours-interval-start-0')).toHaveAttribute('aria-invalid', 'true')
    const srv24 = await page.request.put(`/api/business-hours/${conn.id}`, {
      headers: XRW,
      data: { active: false, business_hours: [{ day_of_week: 2, start_time: '24:00', end_time: '24:00' }] },
    })
    expect(srv24.status()).toBe(422)
    expect(JSON.stringify(await srv24.json())).toContain('business_hours.0.start_time')

    // salvar com erro não chama o servidor
    await page.getByTestId('hours-save').click()
    await expect(page.getByTestId('hours-invalid')).toBeVisible()

    // 24:00 como fim é válido
    await page.getByTestId('hours-interval-start-0').fill('22:00')
    await page.getByTestId('hours-interval-end-0').fill('24:00')
    await expect(page.getByTestId('hours-interval-error-0')).toHaveCount(0)

    // ativo + mensagem exige texto; ativo + fluxo exige fluxo
    await page.getByTestId('hours-active').click()
    await page.getByTestId('hours-action-message').check()
    await page.getByTestId('hours-message').fill('')
    await page.getByTestId('hours-save').click()
    await expect(page.getByTestId('hours-message-error')).toBeVisible()
    await page.getByTestId('hours-action-flow').check()
    await page.getByTestId('hours-save').click()
    await expect(page.getByTestId('hours-flow-error')).toBeVisible()
    const srvFlow = await page.request.put(`/api/business-hours/${conn.id}`, {
      headers: XRW,
      data: { active: true, action_type: 'flow', business_hours: [] },
    })
    expect(srvFlow.status()).toBe(422)
    expect(JSON.stringify(await srvFlow.json())).toContain('flow_id')
    const srvMsg = await page.request.put(`/api/business-hours/${conn.id}`, {
      headers: XRW,
      data: { active: true, action_type: 'message', message_text: '', business_hours: [] },
    })
    expect(srvMsg.status()).toBe(422)
    expect(JSON.stringify(await srvMsg.json())).toContain('message_text')
    expect(putReqs, 'formulário inválido não deve chegar ao servidor').toHaveLength(0)

    // corrigido: salva
    await page.getByTestId('hours-action-message').check()
    await page.getByTestId('hours-message').fill('Fora do horário.')
    await page.getByTestId('hours-save').click()
    await expect(page.getByTestId('hours-saved')).toBeVisible()
    const { config } = await api(page, 'get', `/api/business-hours/${conn.id}`)
    expect(config.business_hours.map((h: any) => `${h.day_of_week} ${h.start_time.slice(0, 5)}-${h.end_time.slice(0, 5)}`)).toEqual([
      '2 22:00-24:00',
    ])
  })

  test('AC-T53-04 sem conexões mostra estado vazio; member sem connections.view vê aviso', async ({ page, browser, baseURL }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'hours')
    await expect(page.getByTestId('hours-no-connections')).toBeVisible()

    await createConnection(page, `Loja M ${uniq()}`)
    const memberCtx = await browser.newContext({ baseURL })
    const member = await memberCtx.newPage()
    await loginAs(member, 'member')
    await openTab(member, 'hours')
    await expect(member.getByTestId('hours-no-permission')).toBeVisible()
    await memberCtx.close()
  })
})

test.describe('T53 — hub e sub-abas', () => {
  test('AC-T53-05 aba inválida na URL é trocada (replace) pela primeira permitida', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/')
    const start = await settledUrl(page)
    await page.goto('/settings?tab=nao-existe')
    await expect(page).toHaveURL(/[?&]tab=accounts/)
    await expect(page).toHaveURL(/company_tab=info/)
    await expect(page.getByTestId('company-info')).toBeVisible()
    await page.goBack()
    await expect(page).not.toHaveURL(/tab=nao-existe/)
    expect(page.url()).toBe(start)

    await page.goto('/settings?tab=accounts&company_tab=nada')
    await expect(page).toHaveURL(/company_tab=info/)
    await expect(page.getByTestId('company-info')).toBeVisible()
    await page.goBack()
    await expect(page).not.toHaveURL(/company_tab=nada/)

    // sub-abas navegam pela URL
    await page.goto('/settings?tab=accounts')
    await page.getByTestId('company-tab-departments').click()
    await expect(page).toHaveURL(/company_tab=departments/)
    await expect(page.getByTestId('departments-panel')).toBeVisible()
    await page.getByTestId('company-tab-hours').click()
    await expect(page).toHaveURL(/company_tab=hours/)
  })

  test('AC-T53-05 sub-aba sem permissão na URL é trocada pela primeira permitida', async ({ page, browser, baseURL }) => {
    await loginAs(page, 'owner')
    // sem settings.departments.view: a sub-aba some e a URL cai na primeira permitida (info)
    await setMemberPerms(page, ['settings.view', 'settings.accounts.view', 'settings.business_hours.view'])
    const memberCtx = await browser.newContext({ baseURL })
    const member = await memberCtx.newPage()
    await loginAs(member, 'member')
    await member.goto('/')
    const start = await settledUrl(member)
    await member.goto('/settings?tab=accounts&company_tab=departments')
    await expect(member).toHaveURL(/company_tab=info/)
    await expect(member.getByTestId('company-info')).toBeVisible()
    await expect(member.getByTestId('company-tab-departments')).toHaveCount(0)
    await expect(member.getByTestId('company-tab-hours')).toBeVisible()
    await expect(member.getByTestId('departments-panel')).toHaveCount(0)
    await member.goBack()
    expect(member.url()).toBe(start)
    await memberCtx.close()
  })

  test('AC-T53-05 no mobile as abas viram um select pesquisável (desktop mantém a lista)', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/settings?tab=nao-existe')
    await expect(page).toHaveURL(/[?&]tab=accounts/)
    if (!isMobile(page)) {
      await expect(page.getByTestId('settings-tab-accounts')).toBeVisible()
      await expect(page.getByTestId('settings-tab-select')).toHaveCount(0)
      return
    }
    await expect(page.getByTestId('settings-tab-accounts')).toHaveCount(0)
    const trigger = page.getByTestId('settings-tab-select')
    await expect(trigger).toBeVisible()
    await expect(trigger).toContainText('Empresa')
    await trigger.click()
    const search = page.getByTestId('settings-tab-select-search')
    await expect(search).toBeVisible()
    await expect(page.getByTestId('settings-tab-option-accounts')).toBeVisible()
    await search.fill('zzz-nada')
    await expect(page.getByTestId('settings-tab-option-accounts')).toHaveCount(0)
    await search.fill('empr')
    await expect(page.getByTestId('settings-tab-option-accounts')).toBeVisible()
    await page.getByTestId('settings-tab-option-accounts').click()
    await expect(search).toHaveCount(0)
    await expect(page).toHaveURL(/[?&]tab=accounts/)
    await expect(page.getByTestId('company-info')).toBeVisible()
    await expectNoHorizontalScroll(page)
  })
})
