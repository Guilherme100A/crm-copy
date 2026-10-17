// AC-T102-01 (Playwright desktop, harness da T17): jornada de onboarding pela web.
// cadastro → login → empresa criada → /connections → Nova conexão → Conectar (QR fake) → sessão levada a STABLE pela rota
// do harness (`POST /__e2e/wa/sessions/:id/state {to:'open'}`, T71) → "Conectada" → contato manda mensagem
// (`/__e2e/wa/emit`) → o chat aparece na fila de /chats em tempo real (SSE, sem recarregar).
import { expect, test, type Page } from '@playwright/test'
import { resetSeed } from '../helpers/e2e'
import { inbound, newPhone, trackSse, waitSseOpen, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

/** Itens da lista de chats (só o link do item: os filhos usam chat-list-item-<campo>-<id>). */
const chatItems = (page: Page) => page.getByTestId(/^chat-list-item-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Leva a sessão do fake a um estado e espera o worker do harness consumir os eventos publicados. */
async function drive(page: Page, sessionId: string, body: Record<string, unknown>) {
  const res = await page.request.post(`/__e2e/wa/sessions/${sessionId}/state`, { data: body, headers: XRW })
  expect(res.status(), await res.text()).toBe(202)
  for (const e of (await res.json()).events as Array<{ stream_id: string }>) {
    const d = await page.request.get(`/__e2e/wa/deliveries?stream_id=${encodeURIComponent(e.stream_id)}&wait_ms=10000`)
    expect((await d.json()).acked, 'worker do harness não consumiu o evento').toBe(true)
  }
}

test.describe('T102 — jornada de onboarding (AC-T102-01)', () => {
  test('AC-T102-01 cadastro → empresa criada → conectar WhatsApp (QR fake) → "Conectada" → mensagem do contato aparece na fila em tempo real', async ({ page }) => {
    const id = uniq()
    const email = `dona-${id}@example.test`
    const password = `Senha-forte-${id}-9X`

    // 1) cadastro pela tela
    await page.goto('/register')
    await page.getByTestId('register-name').fill(`Dona ${id}`)
    await page.getByTestId('register-email').fill(email)
    await page.getByTestId('register-password').fill(password)
    await page.getByTestId('register-password-confirmation').fill(password)
    await page.getByTestId('register-submit').click()
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByTestId('login-message')).toBeVisible()

    // 2) login pela tela → home da empresa
    await page.getByTestId('login-email').fill(email)
    await page.getByTestId('login-password').fill(password)
    await page.getByTestId('login-submit').click()
    await expect(page).not.toHaveURL(/\/login/)

    // empresa criada no cadastro, com a nova usuária como dona
    const profile = await (await page.request.get('/api/auth/profile')).json()
    expect(profile.user.email).toBe(email)
    expect(profile.companies, 'cadastro não criou a empresa').toHaveLength(1)
    const company = profile.companies[0]
    expect(company.name ?? company.company?.name).toBeTruthy()

    // 3) nova conexão pela tela
    await trackSse(page)
    await page.goto('/connections')
    await expect(page.getByTestId('page-connections')).toBeVisible()
    await waitSseOpen(page)
    const connName = `WhatsApp ${id}`
    const newBtn = page.getByTestId('connections-new').or(page.getByTestId('connections-empty-new')).first()
    await newBtn.click()
    await page.getByTestId('connections-name-input').fill(connName)
    await page.getByTestId('connections-name-save').click()
    let conn: { id: string; session_id: string } | undefined
    await expect
      .poll(async () => {
        const body = await (await page.request.get('/api/connections')).json()
        conn = (body.items ?? body.connections ?? []).find((c: any) => c.name === connName)
        return conn?.id
      }, { timeout: 15_000 })
      .toBeTruthy()
    await expect(page.getByTestId(`connections-item-${conn!.id}`)).toBeVisible()
    await expect(page.getByTestId(`connections-item-status-${conn!.id}`)).toHaveAttribute('data-status', 'pending')

    // 4) Conectar: modal com o QR do fake
    await page.getByTestId(`connections-item-actions-${conn!.id}`).click()
    await page.getByTestId(`connections-action-connect-${conn!.id}`).click()
    const modal = page.getByTestId('connections-connect')
    await expect(modal).toBeVisible()
    await expect(page.getByTestId('connections-qr-image')).toHaveAttribute('data-qr', /^data:image\//)

    // 5) leitura do QR (fake) → sessão STABLE → "Conectada" sem recarregar
    await page.evaluate(() => ((window as any).__t102 = 'same-page'))
    await drive(page, conn!.session_id, { to: 'open', session_state: 'STABLE' })
    await expect(modal).toBeHidden()
    const status = page.getByTestId(`connections-item-status-${conn!.id}`)
    await expect(status).toHaveAttribute('data-status', 'connected')
    await expect(status).toContainText('Conectada')
    const api = (await (await page.request.get(`/api/connections/${conn!.id}`)).json()).connection
    expect(api.status).toBe('connected')
    expect(api.session_state).toBe('STABLE')

    // 6) fila de chats aberta; o contato manda mensagem e o chat aparece em tempo real
    await page.goto('/chats')
    await expect(page.getByTestId('chat-page')).toBeVisible()
    await waitSseOpen(page)
    await page.evaluate(() => ((window as any).__t102 = 'same-page'))
    await expect(chatItems(page)).toHaveCount(0)
    const phone = newPhone()
    const text = `Olá, quero saber dos produtos ${id}`
    await inbound(page, conn!.session_id, phone, { text, push_name: `Cliente ${id}` })
    const item = chatItems(page).filter({ hasText: text.slice(0, 20) })
    await expect(item).toHaveCount(1, { timeout: 20_000 })
    await expect(item).toContainText(`Cliente ${id}`)
    expect(await page.evaluate(() => (window as any).__t102), 'a página recarregou').toBe('same-page')
    await expect(page.getByTestId('chat-tab-count-waiting')).toHaveText('1')

    // abrir o chat mostra a mensagem recebida
    await item.click()
    await expect(page.getByTestId('chat-conversation')).toBeVisible()
    await expect(page.getByTestId('chat-conversation')).toContainText(text)
  })
})
