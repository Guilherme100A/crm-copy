// AC-T94-04 — tela /settings?tab=mcp_credentials: estado vazio, criar com token mostrado e copiado uma vez, revogar
// com confirmação, layout mobile (cards). data-testid combinados com o Cinzel; massa e conferência pela API.
import { expect, test, type Page } from '@playwright/test'
import { expectNoHorizontalScroll, loginAs, resetSeed } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'

const TOKEN_RE = /crm_mcp_[A-Za-z0-9_-]{43}/
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

/** Revoga pela API todas as credenciais da empresa (estado vazio garantido). */
async function revokeAll(page: Page) {
  const res = await page.request.get('/api/mcp_credentials')
  expect(res.status(), await res.text()).toBe(200)
  for (const c of (await res.json()).mcp_credentials ?? []) {
    const del = await page.request.delete(`/api/mcp_credentials/${c.id}`, { headers: XRW })
    expect(del.status(), await del.text()).toBe(200)
  }
}

/** Chamada MCP pelo proxy da web com o Bearer dado; devolve o status. */
async function mcpStatus(page: Page, token: string) {
  const res = await page.request.post('/api/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } },
  })
  return res.status()
}

async function openTab(page: Page) {
  await page.goto('/settings?tab=mcp_credentials')
  await expect(page.getByTestId('mcp-credentials')).toBeVisible()
}

/** Cria pela tela; devolve o token mostrado. Deixa o diálogo aberto. */
async function createViaUi(page: Page, name: string, expiration?: string) {
  await page.getByTestId('mcp-create').click()
  await page.getByTestId('mcp-name').fill(name)
  if (expiration) await page.getByTestId('mcp-expiration').selectOption({ label: expiration })
  await page.getByTestId('mcp-create-submit').click()
  const token = page.getByTestId('mcp-token')
  await expect(token).toBeVisible()
  const value = ((await token.inputValue().catch(() => null)) ?? (await token.textContent()) ?? '').trim()
  expect(value).toMatch(TOKEN_RE)
  return value.match(TOKEN_RE)![0]
}

test.describe('T94 — credenciais MCP na tela', () => {
  test('AC-T94-04 estado vazio, criar mostra o token e a URL; copiar uma vez; fechado, o token não aparece mais', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await loginAs(page, 'owner')
    await revokeAll(page)
    await openTab(page)
    await expect(page.getByTestId('mcp-empty')).toContainText('Nenhuma credencial MCP')
    await expect(page.getByTestId('mcp-endpoint-url')).toContainText(/\/api\/mcp\b/)
    await expectNoHorizontalScroll(page)

    const name = `Cursor ${uniq()}`
    const token = await createViaUi(page, name, '30 dias')
    await expect(page.getByText('Copie agora: o token não será mostrado de novo')).toBeVisible()
    await page.getByTestId('mcp-token-copy').click()
    await expect(page.getByTestId('mcp-token-copy')).toContainText('Copiado')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token)
    await expectNoHorizontalScroll(page)
    await page.getByTestId('mcp-token-close').click()

    // o token sumiu da tela e não volta depois de recarregar
    await expect(page.getByTestId('mcp-token')).toHaveCount(0)
    const row = page.getByTestId('mcp-credential-row').filter({ hasText: name })
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('mcp-status')).toHaveText('Ativa')
    await expect(row).toContainText('Nunca usado')
    await expect(page.getByTestId('mcp-empty')).toHaveCount(0)
    expect(await page.content()).not.toContain(token)
    await page.reload()
    await expect(page.getByTestId('mcp-credential-row').filter({ hasText: name })).toHaveCount(1)
    expect(await page.content()).not.toContain(token)
    await expect(page.getByTestId('mcp-token-copy')).toHaveCount(0)

    // o token copiado funciona no endpoint
    expect(await mcpStatus(page, token)).toBe(200)
  })

  test('AC-T94-04 revogar pede confirmação, a linha some e o token passa a dar 401', async ({ page }) => {
    await loginAs(page, 'owner')
    await revokeAll(page)
    await openTab(page)
    const name = `n8n ${uniq()}`
    const token = await createViaUi(page, name)
    await page.getByTestId('mcp-token-close').click()
    const row = page.getByTestId('mcp-credential-row').filter({ hasText: name })
    await expect(row).toContainText('Nunca')
    expect(await mcpStatus(page, token)).toBe(200)

    await row.getByTestId('mcp-revoke').click()
    const confirm = page.getByTestId('mcp-revoke-confirm')
    await expect(confirm).toBeVisible()
    // sem confirmar nada muda
    expect(await mcpStatus(page, token)).toBe(200)
    const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname.startsWith('/api/mcp_credentials/'))
    await confirm.click()
    expect((await del).status()).toBe(200)
    await expect(page.getByTestId('mcp-credential-row').filter({ hasText: name })).toHaveCount(0)
    await expect(page.getByTestId('mcp-empty')).toBeVisible()
    expect(await mcpStatus(page, token)).toBe(401)
  })

  test('AC-T94-04 lista com status e último uso preenchido; layout sem rolagem horizontal', async ({ page }) => {
    await loginAs(page, 'owner')
    await revokeAll(page)
    const used = await page.request.post('/api/mcp_credentials', { headers: XRW, data: { mcp_credential: { name: `Usada ${uniq()}`, auth_type: 'static' } } })
    expect(used.status(), await used.text()).toBe(201)
    const usedBody = await used.json()
    expect(await mcpStatus(page, usedBody.token)).toBe(200)
    const soon = await page.request.post('/api/mcp_credentials', {
      headers: XRW,
      data: { mcp_credential: { name: `Curta ${uniq()}`, auth_type: 'static', expires_in_days: 1 } },
    })
    expect(soon.status(), await soon.text()).toBe(201)

    await openTab(page)
    const usedRow = page.locator(`[data-testid="mcp-credential-row"][data-id="${usedBody.mcp_credential.id}"]`)
    await expect(usedRow).toBeVisible()
    await expect(usedRow.getByTestId('mcp-status')).toHaveText('Ativa')
    await expect(usedRow).not.toContainText('Nunca usado')
    await expect(page.getByTestId('mcp-credential-row')).toHaveCount(2)
    await expectNoHorizontalScroll(page)
    for (const btn of await page.getByTestId('mcp-revoke').all()) await expect(btn).toBeInViewport()
  })

  test('AC-T94-04 membro sem settings.mcp.edit/delete não vê os botões de criar e revogar', async ({ page }) => {
    await loginAs(page, 'owner')
    await revokeAll(page)
    const cred = await page.request.post('/api/mcp_credentials', { headers: XRW, data: { mcp_credential: { name: `Equipe ${uniq()}`, auth_type: 'static' } } })
    expect(cred.status()).toBe(201)
    await page.context().clearCookies()
    await loginAs(page, 'member')
    await page.goto('/settings?tab=mcp_credentials')
    await expect(page.getByTestId('mcp-create')).toHaveCount(0)
    await expect(page.getByTestId('mcp-revoke')).toHaveCount(0)
  })
})
