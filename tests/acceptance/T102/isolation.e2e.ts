// AC-T102-06 (Playwright desktop, harness da T17): por URL, a dona da empresa B não vê nenhum dado da empresa A.
// A = empresa do seed (owner@demo.test) com conexão, chat, contato, fluxo, funil, agente e webhook marcados; B = conta
// nova (cadastro). B abre as telas de listagem e as URLs de detalhe com os ids de A: nenhum texto da página e nenhuma
// resposta de /api/** carregada pela página contém o marcador ou os ids de A. A varredura da API e do SSE está em
// isolation.test.ts.
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from '@playwright/test'
import { resetSeed, SEED_PASSWORD, SEED_USERS } from '../helpers/e2e'
import { inbound, newPhone, XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

async function post(ctx: APIRequestContext, path: string, data: unknown) {
  const res = await ctx.post(path, { data, headers: XRW })
  return { status: res.status(), body: await res.json().catch(() => ({})) }
}

/** Dados de A (empresa do seed) com o marcador; devolve os ids criados. */
async function seedA(baseURL: string, mark: string) {
  const ctx = await pwRequest.newContext({ baseURL })
  try {
    const login = await ctx.post('/api/auth/login', { data: { email: SEED_USERS.owner, password: SEED_PASSWORD }, headers: XRW })
    expect(login.status(), await login.text()).toBe(200)
    const ids: Record<string, string> = { company: (await login.json()).companies[0].id }
    const conn = await post(ctx, '/api/connections', { name: `Conexão ${mark}` })
    expect(conn.status).toBe(201)
    ids.connection = conn.body.connection.id
    const phone = newPhone()
    // inbound pelo harness com o contexto de A (a rota /__e2e não depende de sessão)
    const page = { request: ctx } as unknown as Page
    await inbound(page, conn.body.connection.session_id, phone, { text: `Mensagem ${mark}`, push_name: `Cliente ${mark}` })
    await expect
      .poll(async () => (ids.chat = (await (await ctx.get(`/api/chats?search=${phone.slice(-8)}`)).json()).items?.[0]?.id), { timeout: 15_000 })
      .toBeTruthy()
    const contact = await post(ctx, '/api/contacts', { name: `Contato ${mark}`, phone_e164: `+${newPhone()}` })
    if (contact.status === 201) ids.contact = contact.body.contact.id
    const flow = await post(ctx, '/api/flows', { name: `Fluxo ${mark}` })
    expect(flow.status).toBe(201)
    ids.flow = (flow.body.flow ?? flow.body).id
    const crm = await post(ctx, '/api/crms', { name: `Funil ${mark}` })
    expect(crm.status).toBe(201)
    ids.crm = crm.body.crm.id
    const agent = await post(ctx, '/api/ai-agents', { name: `Agente ${mark}`, generated_prompt: `Prompt ${mark}`, model: { provider: 'openai', model: 'gpt-4o-mini' }, skills: [] })
    if (agent.status === 201) ids.agent = agent.body.agent.id
    const wh = await post(ctx, '/api/inbound-webhooks', { name: `Webhook ${mark}` })
    if (wh.status === 201) ids.webhook = wh.body.webhook.id
    return ids
  } finally {
    await ctx.dispose()
  }
}

/** Conta nova (empresa B) logada no contexto da página. */
async function loginAsNewCompany(page: Page) {
  const id = uniq()
  const email = `b-${id}@example.test`
  const password = `Senha-forte-${id}-9X`
  const reg = await page.request.post('/api/auth/register', { data: { name: `Dona B ${id}`, email, password, password_confirmation: password }, headers: XRW })
  expect(reg.status(), await reg.text()).toBeLessThan(300)
  const login = await page.request.post('/api/auth/login', { data: { email, password }, headers: XRW })
  expect(login.status(), await login.text()).toBe(200)
  return (await login.json()).companies[0].id as string
}

test.describe('T102 — isolamento por URL (AC-T102-06)', () => {
  test('AC-T102-06 a dona da empresa B não vê dados da empresa A nas telas nem pelas URLs com ids de A', async ({ page, baseURL }) => {
    const mark = `segredoA${uniq()}`
    const a = await seedA(baseURL!, mark)
    const companyB = await loginAsNewCompany(page)
    expect(companyB).not.toBe(a.company)
    const secrets = [mark, ...Object.values(a)].map((s) => s.toLowerCase())

    // toda resposta de /api/** carregada pelas telas de B
    const leaks: string[] = []
    page.on('response', async (res) => {
      const url = new URL(res.url())
      if (!url.pathname.startsWith('/api/') || url.pathname === '/api/events') return
      const text = (await res.text().catch(() => '')).toLowerCase()
      const pathIds = url.pathname.toLowerCase()
      for (const s of secrets) if (text.includes(s) && !pathIds.includes(s)) leaks.push(`${res.request().method()} ${url.pathname} → ${res.status()} contém ${s}`)
    })

    const urls = [
      '/welcome',
      '/chats',
      '/customers',
      '/flows',
      '/crms',
      '/agentes',
      '/connections',
      '/settings/inbound-webhooks',
      `/chats/${a.chat}`,
      `/flows/${a.flow}`,
      `/crms/${a.crm}`,
      ...(a.agent ? [`/agentes/${a.agent}`] : []),
      ...(a.webhook ? [`/settings/inbound-webhooks/${a.webhook}`] : []),
      `/chats?search=${mark}`,
      `/customers?search=${mark}`,
    ]
    for (const url of urls) {
      await page.goto(url)
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(500)
      const text = (await page.evaluate(() => document.body.innerText)).toLowerCase()
      expect(text.includes(mark.toLowerCase()), `${url}: a tela mostra dado de A`).toBe(false)
      for (const [k, v] of Object.entries(a)) if (k !== 'company') expect(text.includes(v.toLowerCase()) && !url.includes(v), `${url}: id de A (${k}) na tela`).toBe(false)
    }
    // a conversa de A não abre para B
    await page.goto(`/chats/${a.chat}`)
    await page.waitForLoadState('networkidle').catch(() => {})
    await expect(page.getByTestId('chat-conversation-name')).not.toContainText(mark)
    expect(leaks, 'respostas da API com dados de A').toEqual([])

    // B forçando a empresa de A pelo cabeçalho: 404
    const forced = await page.request.get('/api/chats', { headers: { 'x-company-id': a.company } })
    expect(forced.status()).toBe(404)
    expect((await forced.text()).toLowerCase()).not.toContain(mark.toLowerCase())
  })
})
