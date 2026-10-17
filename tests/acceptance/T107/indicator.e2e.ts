// T107 — indicador de conexões desconectadas no menu (E2E desktop no harness da T17). Contrato em
// spec/reports/T107-entrega.md: `GET /api/connections/disconnect-alert`, `[data-testid=nav-item-connections]
// [data-testid=shell-disconnect-indicator]` com aria-label "Instância desconectada nas últimas 24h" (ausente quando
// false), queda por `POST /__e2e/wa/sessions/:sid/state` (rota da T71 → worker → projetor da T47 → SSE).
// Contagem de consultas por `page.on('request')`, medida a partir de imediatamente antes da queda.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type Page, type Request } from '@playwright/test'
import { loginAs, resetSeed, type SeedRole } from '../helpers/e2e'
import { createConnection, trackSse, waitSseOpen, XRW } from '../helpers/chats-e2e'
import { dbUrl, lit, sqlOk } from '../helpers/pg'

const ALERT_PATH = '/api/connections/disconnect-alert'
const LABEL = 'Instância desconectada nas últimas 24h'
const SUPPORT_ID = '00000000-0000-4000-8000-000000000a05' // seed/modules/support-user.ts
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

/** Banco do harness deste worktree (test-results/e2e-server.json). */
function harnessDb(): string {
  const info = JSON.parse(readFileSync(join(process.cwd(), 'test-results', 'e2e-server.json'), 'utf8'))
  return dbUrl(info.database)
}

/** Leva a sessão do fake a um estado e espera o worker do harness consumir os eventos publicados. */
async function drive(page: Page, sessionId: string, to: 'open' | 'close') {
  const res = await page.request.post(`/__e2e/wa/sessions/${sessionId}/state`, { data: { to }, headers: XRW })
  expect(res.status(), await res.text()).toBe(202)
  const { events } = await res.json()
  for (const e of events as Array<{ stream_id: string }>) {
    const d = await page.request.get(`/__e2e/wa/deliveries?stream_id=${encodeURIComponent(e.stream_id)}&wait_ms=10000`)
    expect((await d.json()).acked, 'worker do harness não consumiu o evento').toBe(true)
  }
}

/** Registra as consultas ao alerta feitas pela página (desde já). */
function trackAlert(page: Page) {
  const calls: Request[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === ALERT_PATH) calls.push(r)
  })
  return calls
}

const indicator = (page: Page) => page.getByTestId('nav-item-connections').getByTestId('shell-disconnect-indicator')
const anyIndicator = (page: Page) => page.getByTestId('shell-disconnect-indicator')

/** Abre a página e espera a primeira consulta ao alerta responder e o SSE abrir. */
async function openShell(page: Page, path = '/welcome') {
  await trackSse(page)
  const first = page.waitForResponse((r) => new URL(r.url()).pathname === ALERT_PATH)
  await page.goto(path)
  expect((await first).status()).toBe(200)
  await expect(page.getByTestId('nav-item-connections')).toBeVisible()
  await waitSseOpen(page)
}

/** Conexão da empresa ativa que já caiu uma vez (open → close), antes de a página abrir. */
async function droppedConnection(page: Page) {
  const conn = await createConnection(page, `Queda ${uniq()}`)
  await drive(page, conn.session_id, 'open')
  await drive(page, conn.session_id, 'close')
  return conn
}

async function newUserPage(browser: Browser, role: SeedRole) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const login = await loginAs(page, role)
  return { ctx, page, login }
}

/** Sem indicador e sem nenhuma consulta ao alerta depois de o shell estabilizar (SSE aberto + folga). */
async function expectNoAlert(page: Page, calls: Request[]) {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)
  await expect(anyIndicator(page)).toHaveCount(0)
  expect(calls.map((r) => r.url()), 'não deveria consultar o alerta').toEqual([])
}

test.describe('T107 — indicador de conexões desconectadas no menu', () => {
  test('AC-T107-01 queda nas últimas 24 h: a API devolve true e o item Conexões mostra o indicador ao abrir', async ({ page }) => {
    await loginAs(page, 'owner')
    const before = await page.request.get(ALERT_PATH)
    expect(before.status()).toBe(200)
    expect(await before.json()).toEqual({ has_recent_disconnected: false, last_disconnected_at: null })

    const conn = await droppedConnection(page)
    const after = await page.request.get(ALERT_PATH)
    expect(after.status()).toBe(200)
    const body = await after.json()
    expect(body.has_recent_disconnected).toBe(true)
    const { connection } = await (await page.request.get(`/api/connections/${conn.id}`)).json()
    expect(body.last_disconnected_at).toBe(connection.disconnected_at)

    await openShell(page)
    await expect(indicator(page)).toBeVisible()
    await expect(indicator(page)).toHaveAttribute('aria-label', LABEL)
    await expect(anyIndicator(page)).toHaveCount(1)
  })

  test('AC-T107-01 sem queda (conexão só conectada): sem indicador', async ({ page }) => {
    await loginAs(page, 'owner')
    const conn = await createConnection(page, `Ok ${uniq()}`)
    await drive(page, conn.session_id, 'open')
    await openShell(page)
    await page.waitForTimeout(1000)
    await expect(anyIndicator(page)).toHaveCount(0)
  })

  for (const path of ['/welcome', '/connections']) {
    test(`AC-T107-02 em ${path}: connection.disconnected via SSE liga o indicador sem nova consulta; connection.connected consulta de novo`, async ({ page }) => {
      await loginAs(page, 'owner')
      const conn = await createConnection(page, `Ao vivo ${uniq()}`)
      await drive(page, conn.session_id, 'open') // o primeiro open (pending → connected) também consultaria: antes da medição
      await openShell(page, path)
      await expect(anyIndicator(page)).toHaveCount(0)
      await page.waitForLoadState('networkidle')

      // medição a partir de imediatamente antes da queda
      const calls = trackAlert(page)
      await drive(page, conn.session_id, 'close')
      await expect(indicator(page)).toBeVisible()
      await expect(indicator(page)).toHaveAttribute('aria-label', LABEL)
      await page.waitForTimeout(2000) // folga para um refetch tardio aparecer
      expect(calls.map((r) => r.url()), 'a queda não pode gerar consulta').toEqual([])

      const refetch = page.waitForResponse((r) => new URL(r.url()).pathname === ALERT_PATH)
      await drive(page, conn.session_id, 'open')
      expect((await refetch).status()).toBe(200)
      expect(calls.length).toBeGreaterThanOrEqual(1)
      // a queda segue nas últimas 24 h: o indicador continua aceso depois da nova consulta
      await expect(indicator(page)).toBeVisible()
    })
  }

  test('AC-T107-03 member (sem connections.view) não vê nem consulta; API → 403', async ({ page, browser }) => {
    await loginAs(page, 'owner')
    await droppedConnection(page)

    const { ctx, page: m } = await newUserPage(browser, 'member')
    try {
      const calls = trackAlert(m)
      await trackSse(m)
      await m.goto('/')
      await waitSseOpen(m)
      await expectNoAlert(m, calls)
      expect((await m.request.get(ALERT_PATH)).status()).toBe(403)
    } finally {
      await ctx.close()
    }
  })

  test('AC-T107-03 support (mesmo membro com connections.view) não vê nem consulta; API → 403', async ({ page, browser }) => {
    const login = await loginAs(page, 'owner')
    const demoId: string = login.companies[0].id
    await droppedConnection(page)
    sqlOk(
      harnessDb(),
      `INSERT INTO crm.company_members (company_id, user_id, role, permission_keys)
       VALUES (${lit(demoId)}, ${lit(SUPPORT_ID)}, 'admin', ARRAY['connections.view']::text[]) ON CONFLICT DO NOTHING;
       UPDATE crm.users SET last_company_id = ${lit(demoId)} WHERE id = ${lit(SUPPORT_ID)};`,
    )

    const { ctx, page: s } = await newUserPage(browser, 'support')
    try {
      const calls = trackAlert(s)
      await s.goto('/')
      await s.waitForLoadState('networkidle')
      await expectNoAlert(s, calls)
      await s.goto('/connections')
      await expectNoAlert(s, calls)
      const r = await s.request.get(ALERT_PATH, { headers: { 'x-company-id': demoId } })
      expect(r.status(), await r.text()).toBe(403)
    } finally {
      await ctx.close()
    }
  })

  test('AC-T107-03 admin (com connections.view) e owner veem o indicador', async ({ page, browser }) => {
    await loginAs(page, 'owner')
    await droppedConnection(page)
    await openShell(page)
    await expect(indicator(page)).toBeVisible()

    const { ctx, page: a } = await newUserPage(browser, 'admin')
    try {
      await openShell(a)
      await expect(indicator(a)).toBeVisible()
      await expect(indicator(a)).toHaveAttribute('aria-label', LABEL)
    } finally {
      await ctx.close()
    }
  })

  test('AC-T107-04 trocar de empresa refaz a consulta com o X-Company-Id da nova empresa (e volta)', async ({ page }) => {
    const login = await loginAs(page, 'owner')
    const demoId: string = login.companies.find((c: any) => c.name === 'Empresa Demo')?.id ?? login.companies[0].id
    await droppedConnection(page)
    const res = await page.request.post('/api/companies', { data: { name: `Filial ${uniq()}` }, headers: XRW })
    expect(res.status(), await res.text()).toBe(201)
    const b = (await res.json()).company as { id: string; name: string }

    await openShell(page)
    await expect(indicator(page)).toBeVisible()
    await page.waitForLoadState('networkidle')

    const calls = trackAlert(page)
    const switchTo = async (id: string) => {
      const trigger = page.getByTestId('company-switcher-trigger').filter({ visible: true }).first()
      await trigger.click()
      await expect(page.getByTestId('company-switcher-popup')).toBeVisible()
      await page.getByTestId(`company-switcher-item-${id}`).click()
    }

    await switchTo(b.id)
    await expect.poll(() => calls.some((r) => r.headers()['x-company-id'] === b.id), { timeout: 20_000 }).toBe(true)
    await expect(page.getByTestId('company-switcher-current').filter({ visible: true }).first()).toHaveText(new RegExp(b.name))
    // a nova empresa não teve queda: o indicador some
    await expect(anyIndicator(page)).toHaveCount(0)

    const n = calls.length
    if (await page.getByTestId('company-switcher-popup').isVisible()) await page.keyboard.press('Escape')
    await switchTo(demoId)
    await expect.poll(() => calls.slice(n).some((r) => r.headers()['x-company-id'] === demoId), { timeout: 20_000 }).toBe(true)
    await expect(indicator(page)).toBeVisible()
  })
})
