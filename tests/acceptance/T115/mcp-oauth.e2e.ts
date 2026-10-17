// AC-T115-05 (desktop e mobile): criar credencial OAuth mostra a URL do conector e os passos; o status passa de
// "Pendente" a "Conectada · Claude" ao recarregar depois que o cliente de teste conclui o OAuth por HTTP no harness.
// AC-T115-01 (desktop): login + tela de consentimento (/oauth/consent?request=…) aprovando ou negando.
// Testids e roteiro combinados com o Operário (Forja, spec/reports/T115-entrega.md). Nenhum serviço externo: o
// redirect_uri do cliente (http://127.0.0.1:9/cb) é interceptado com page.route.
import { createHash, randomBytes } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { XRW } from '../helpers/chats-e2e'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed, SEED_PASSWORD, SEED_USERS } from '../helpers/e2e'

const REDIRECT = 'http://127.0.0.1:9/cb'
const MCP_ACCEPT = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function revokeAll(page: Page) {
  const res = await page.request.get('/api/mcp_credentials')
  expect(res.status(), await res.text()).toBe(200)
  for (const c of (await res.json()).mcp_credentials ?? []) {
    const del = await page.request.delete(`/api/mcp_credentials/${c.id}`, { headers: XRW })
    expect(del.status(), await del.text()).toBe(200)
  }
}

/** Abre a aba de credenciais MCP: no mobile pelo seletor do hub (T53/T58), no desktop pela URL. */
async function openTab(page: Page) {
  if (isMobile(page)) {
    await page.goto('/settings')
    await page.getByTestId('settings-tab-select').click()
    await page.getByTestId('settings-tab-select-search').fill('MCP')
    await page.getByTestId('settings-tab-option-mcp_credentials').click()
  } else {
    await page.goto('/settings?tab=mcp_credentials')
  }
  await expect(page.getByTestId('mcp-credentials')).toBeVisible()
}

/** Registro dinâmico + /authorize (sem seguir o 302); devolve o id do pedido de consentimento. */
async function startAuthorization(request: APIRequestContext, connectorUrl: string, clientName = 'Claude') {
  const reg = await request.post('/api/mcp-oauth/register', {
    data: { client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
  })
  expect(reg.status(), await reg.text()).toBe(201)
  const client = await reg.json()
  const { verifier, challenge } = pkce()
  const state = uniq()
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: connectorUrl,
  })
  const az = await request.get(`/api/mcp-oauth/authorize?${qs}`, { maxRedirects: 0 })
  expect(az.status(), await az.text()).toBe(302)
  const location = new URL(az.headers()['location']!)
  expect(location.pathname).toBe('/oauth/consent')
  const requestId = location.searchParams.get('request')!
  expect(requestId).toBeTruthy()
  return { client, verifier, state, requestId }
}

async function exchange(request: APIRequestContext, clientId: string, code: string, verifier: string) {
  const res = await request.post('/api/mcp-oauth/token', {
    form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId },
  })
  expect(res.status(), await res.text()).toBe(200)
  return res.json()
}

const connectorPath = (url: string) => new URL(url).pathname

async function mcpInit(request: APIRequestContext, path: string, token: string) {
  const res = await request.post(path, {
    headers: { ...MCP_ACCEPT, authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-t115', version: '1' } } },
  })
  return res.status()
}

/** Intercepta o redirect_uri do cliente e devolve a URL a que o navegador foi mandado. */
async function catchRedirect(page: Page) {
  let resolve!: (u: URL) => void
  const hit = new Promise<URL>((r) => (resolve = r))
  await page.route('http://127.0.0.1:9/**', async (route) => {
    resolve(new URL(route.request().url()))
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>cliente</p>' })
  })
  return { hit }
}

test.describe('T115 — conector OAuth na tela', () => {
  test('AC-T115-05 criar credencial OAuth mostra a URL do conector e os passos; após conectar, recarregar mostra "Conectada · Claude"', async ({ page }) => {
    await loginAs(page, 'owner')
    await revokeAll(page)
    await openTab(page)

    const name = `Claude ${uniq()}`
    await page.getByTestId('mcp-create').click()
    await page.getByTestId('mcp-name').fill(name)
    await page.getByTestId('mcp-auth-type').selectOption('oauth')
    // OAuth não tem expiração
    await expect(page.getByTestId('mcp-expiration')).toHaveCount(0)
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/mcp_credentials')
    await page.getByTestId('mcp-create-submit').click()
    const createdRes = await created
    expect(createdRes.status()).toBe(201)
    const createdBody = await createdRes.json()
    expect(createdBody.mcp_credential).toMatchObject({ auth_type: 'oauth', status: 'pending' })
    const credId: string = createdBody.mcp_credential.id

    // URL do conector e os passos, sem token para copiar
    const urlEl = page.getByTestId('mcp-connector-url')
    await expect(urlEl).toBeVisible()
    const connectorUrl = ((await urlEl.textContent()) ?? '').trim()
    expect(connectorUrl).toMatch(new RegExp(`^https?://[^/]+/api/mcp/${credId}$`))
    expect(connectorUrl).toBe(createdBody.mcp_credential.connector_url)
    const steps = page.getByTestId('mcp-connector-steps')
    await expect(steps).toBeVisible()
    await expect(steps.locator('li')).toHaveCount(4)
    await expect(steps).toContainText('Claude')
    await expect(page.getByTestId('mcp-connector-copy')).toBeVisible()
    await expect(page.getByTestId('mcp-token')).toHaveCount(0)
    await expectNoHorizontalScroll(page)
    await page.getByTestId('mcp-connector-close').click()

    // na lista: Pendente, com a URL do conector
    const row = page.locator(`[data-testid="mcp-credential-row"][data-id="${credId}"]`)
    await expect(row).toBeVisible()
    await expect(row.getByTestId('mcp-status')).toHaveAttribute('data-status', 'pending')
    await expect(row.getByTestId('mcp-status')).toHaveText('Pendente')
    await expect(row.getByTestId('mcp-credential-connector-url')).toHaveText(connectorUrl)
    await expectNoHorizontalScroll(page)

    // o cliente de teste conclui o OAuth por HTTP (aprovação com a sessão do dono)
    const { client, verifier, requestId } = await startAuthorization(page.request, connectorUrl)
    const info = await page.request.get(`/api/mcp-oauth/consent?request=${requestId}`)
    expect(info.status(), await info.text()).toBe(200)
    const companyId = (await info.json()).authorization_request.company.id
    const dec = await page.request.post('/api/mcp-oauth/consent', { headers: XRW, data: { request: requestId, company_id: companyId, approve: true } })
    expect(dec.status(), await dec.text()).toBe(200)
    const code = new URL((await dec.json()).redirect_to).searchParams.get('code')!
    const tokens = await exchange(page.request, client.client_id, code, verifier)
    expect(await mcpInit(page.request, connectorPath(connectorUrl), tokens.access_token)).toBe(200)

    // sem realtime: só muda ao recarregar
    await page.reload()
    await expect(page.getByTestId('mcp-credentials')).toBeVisible()
    const status = page.locator(`[data-testid="mcp-credential-row"][data-id="${credId}"]`).getByTestId('mcp-status')
    await expect(status).toHaveAttribute('data-status', 'connected')
    await expect(status).toHaveText('Conectada · Claude')
    await expect(status).toBeInViewport()
    await expectNoHorizontalScroll(page)
  })

  test('AC-T115-01 tela de consentimento: sem sessão leva ao login e volta; mostra cliente e empresa; aprovar devolve o código ao cliente e o token funciona', async ({ page }) => {
    await loginAs(page, 'owner')
    await revokeAll(page)
    const cr = await page.request.post('/api/mcp_credentials', { headers: XRW, data: { mcp_credential: { name: `Claude ${uniq()}`, auth_type: 'oauth' } } })
    expect(cr.status(), await cr.text()).toBe(201)
    const cred = (await cr.json()).mcp_credential
    const { client, verifier, state, requestId } = await startAuthorization(page.request, cred.connector_url)

    // sem sessão: login e volta para o consentimento
    await page.context().clearCookies()
    await page.goto(`/oauth/consent?request=${requestId}`)
    await expect(page).toHaveURL(/\/login\?/)
    await page.getByTestId('login-email').fill(SEED_USERS.owner)
    await page.getByTestId('login-password').fill(SEED_PASSWORD)
    await page.getByTestId('login-submit').click()
    await expect(page).toHaveURL(new RegExp(`/oauth/consent\\?request=${requestId}`))

    await expect(page.getByTestId('mcp-oauth-consent')).toBeVisible()
    await expect(page.getByTestId('mcp-oauth-client')).toContainText('Claude')
    await expect(page.getByTestId('mcp-oauth-credential')).toContainText(cred.name)
    await expect(page.getByTestId('mcp-oauth-redirect')).toContainText('127.0.0.1')
    const company = page.getByTestId('mcp-oauth-company')
    await expect(company).toBeVisible()
    const companyId = await company.getAttribute('data-company-id')
    expect(companyId).toBeTruthy()

    const redirected = (await catchRedirect(page)).hit
    await page.getByTestId('mcp-oauth-approve').click()
    const back = await redirected
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    expect(back.searchParams.get('state')).toBe(state)
    const code = back.searchParams.get('code')!
    expect(code).toBeTruthy()

    const tokens = await exchange(page.request, client.client_id, code, verifier)
    expect(await mcpInit(page.request, connectorPath(cred.connector_url), tokens.access_token)).toBe(200)
    // o pedido já decidido não volta a ser aprovável
    await page.unroute('http://127.0.0.1:9/**')
    await page.goto(`/oauth/consent?request=${requestId}`)
    await expect(page.getByTestId('mcp-oauth-error')).toBeVisible()
    await expect(page.getByTestId('mcp-oauth-approve')).toHaveCount(0)
  })

  test('AC-T115-01 negar no consentimento devolve access_denied ao cliente; pedido inválido mostra erro', async ({ page }) => {
    await loginAs(page, 'owner')
    await revokeAll(page)
    const cr = await page.request.post('/api/mcp_credentials', { headers: XRW, data: { mcp_credential: { name: `Claude ${uniq()}`, auth_type: 'oauth' } } })
    const cred = (await cr.json()).mcp_credential
    const { state, requestId } = await startAuthorization(page.request, cred.connector_url)

    await page.goto(`/oauth/consent?request=${requestId}`)
    await expect(page.getByTestId('mcp-oauth-consent')).toBeVisible()
    const redirected = (await catchRedirect(page)).hit
    await page.getByTestId('mcp-oauth-deny').click()
    const back = await redirected
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('state')).toBe(state)
    expect(back.searchParams.get('code')).toBeNull()

    await page.unroute('http://127.0.0.1:9/**')
    await page.goto('/oauth/consent?request=nao-e-um-pedido')
    await expect(page.getByTestId('mcp-oauth-error')).toBeVisible()
    await expect(page.getByTestId('mcp-oauth-approve')).toHaveCount(0)
    // a credencial continua pendente
    const list = await (await page.request.get('/api/mcp_credentials')).json()
    expect(list.mcp_credentials.find((c: { id: string }) => c.id === cred.id)).toMatchObject({ status: 'pending' })
  })
})
