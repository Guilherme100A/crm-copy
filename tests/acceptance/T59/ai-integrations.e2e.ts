// AC-T59-01..04 — chip "Créditos de IA" na sidebar (saldo, destaque low/exhausted, realtime e foco, sem compra), aba
// /settings?tab=ai_usage (cards, gráfico dia/feature, extrato filtrável, cotas com barra, vazio), hub de integrações
// (busca sem acentos, abas IA/Vendas/Rastreamento, Ativo/Inativo) e modal da chave de IA (segredo mascarado, Testar com
// latência/erro pelo probe FAKE do harness, edição com segredo em branco mantém o atual). Testids do brief T59
// ("Entrega do operário"). Carteira e cotas pela API da plataforma (platform@demo.test); uso de IA não tem rota de
// carga: page.route em /api/ai/usage e /api/ai/usage/summary. Só desktop (nenhum AC cita mobile).
import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test'
import { loginAs, resetSeed, SEED_PASSWORD, SEED_USERS } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'patch', path: string, data?: unknown) {
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

/** Contexto HTTP do `platform_admin` (cookie próprio, separado do navegador do owner). */
async function platform(request: APIRequestContext) {
  const res = await request.post('/api/auth/login', { data: { email: SEED_USERS.platformAdmin, password: SEED_PASSWORD }, headers: XRW })
  expect(res.status(), await res.text()).toBe(200)
  const call = async (method: 'post' | 'patch' | 'put', path: string, data: unknown) => {
    const r = await request[method](path, { data, headers: XRW })
    expect(r.status(), `${method.toUpperCase()} ${path}: ${await r.text()}`).toBeLessThan(300)
    return r.json()
  }
  return {
    topup: (cid: string, credits: number) => call('post', `/api/platform/companies/${cid}/ai/topups`, { credits, note: `e2e ${uniq()}` }),
    adjust: (cid: string, credits: number) => call('post', `/api/platform/companies/${cid}/ai/adjustments`, { credits, note: `e2e ${uniq()}` }),
    wallet: (cid: string, body: Record<string, number>) => call('patch', `/api/platform/companies/${cid}/ai/wallet`, body),
    quotas: (cid: string, quotas: unknown[]) => call('put', `/api/platform/companies/${cid}/ai/quotas`, { quotas }),
  }
}

/** Abre uma aba do hub (desktop) e espera o replace de `?tab=` assentar antes de olhar o conteúdo (lição da T53). */
async function openTab(page: Page, tab: string, testid: string, extra = '') {
  await page.goto(`/settings?tab=${tab}${extra}`)
  await expect(page).toHaveURL(new RegExp(`[?&]tab=${tab}(&|$)`))
  await expect(page.getByTestId(testid)).toBeVisible()
  await expect(page.getByTestId(`settings-tab-${tab}`)).toBeVisible()
}

const chip = (page: Page) => page.getByTestId('ai-wallet-chip')
const BUY = /compr|buy|purchase|adquir|recarregar/i

// ---------------------------------------------------------------- massa de uso de IA (page.route)
const DAY = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const USAGE = [
  { id: 'u-agent-1', created_at: DAY(0), feature: 'ai_agent', agent_id: null, provider: 'openai', model: 'gpt-4o-mini', kind: 'llm', input_tokens: 1200, output_tokens: 300, cost_micros: 900_000, credits: 40, status: 'charged', error_code: null },
  { id: 'u-flow-2', created_at: DAY(1), feature: 'flow_ai', agent_id: null, provider: 'anthropic', model: 'claude-x', kind: 'llm', input_tokens: 800, output_tokens: 200, cost_micros: 600_000, credits: 20, status: 'charged', error_code: null },
  { id: 'u-err-3', created_at: DAY(2), feature: 'flow_ai', agent_id: null, provider: 'anthropic', model: 'claude-x', kind: 'llm', input_tokens: 0, output_tokens: 0, cost_micros: 0, credits: 0, status: 'error', error_code: 'timeout' },
]
const charged = USAGE.filter((u) => u.status !== 'error')
const sumOf = (rows: typeof USAGE) => ({
  count: rows.length,
  input_tokens: rows.reduce((a, r) => a + r.input_tokens, 0),
  output_tokens: rows.reduce((a, r) => a + r.output_tokens, 0),
  cost_micros: rows.reduce((a, r) => a + r.cost_micros, 0),
  credits: rows.reduce((a, r) => a + r.credits, 0),
})
const groupBy = (key: (u: (typeof USAGE)[number]) => string) => {
  const m = new Map<string, typeof USAGE>()
  for (const u of charged) m.set(key(u), [...(m.get(key(u)) ?? []), u])
  return [...m].map(([k, rows]) => ({ key: k, ...sumOf(rows) }))
}

/** Intercepta extrato e resumo; devolve os pedidos para conferir os parâmetros enviados. */
async function mockUsage(page: Page) {
  const usageReqs: URL[] = []
  const summaryReqs: URL[] = []
  await page.route(/\/api\/ai\/usage(\/summary)?(\?|$)/, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/summary')) {
      summaryReqs.push(url)
      const g = url.searchParams.get('group_by') ?? 'day'
      const items =
        g === 'day'
          ? groupBy((u) => u.created_at.slice(0, 10))
          : g === 'model'
            ? groupBy((u) => `${u.provider}/${u.model}`)
            : groupBy((u) => u.feature ?? '')
      return route.fulfill({ json: { group_by: g, time_zone: 'America/Sao_Paulo', items } })
    }
    usageReqs.push(url)
    const p = url.searchParams
    let items = USAGE.filter((u) => (!p.get('feature') || u.feature === p.get('feature')) && (!p.get('provider') || u.provider === p.get('provider')) && (!p.get('status') || u.status === p.get('status')))
    items = items.slice(0, Number(p.get('limit') ?? 50))
    return route.fulfill({ json: { items, next_cursor: null } })
  })
  return { usageReqs, summaryReqs }
}

// =================================================================================================== AC-T59-01
test.describe('T59 — chip de créditos de IA na sidebar', () => {
  test('AC-T59-01 chip mostra o saldo, destaque low/exhausted e não tem botão de compra; leva à aba de consumo', async ({ page, request }) => {
    await loginAs(page, 'owner')
    const cid = await companyId(page)
    const plat = await platform(request)

    // carteira nova: saldo 0 com overrun 0 → exhausted
    await page.goto('/settings?tab=accounts')
    await expect(chip(page)).toBeVisible()
    await expect(chip(page)).toHaveAttribute('data-status', 'exhausted')
    await expect(page.getByTestId('ai-wallet-chip-balance')).toHaveText('0')
    await expect(page.getByTestId('ai-wallet-chip-status')).toHaveText('Esgotado')
    await expect(chip(page)).toContainText('Créditos de IA')

    // sem compra: nenhum botão/link de compra no chip, e o chip é só um link para a aba de consumo
    await expect(chip(page).getByRole('button')).toHaveCount(0)
    await expect(chip(page)).not.toContainText(BUY)
    await expect(page.getByRole('button', { name: BUY })).toHaveCount(0)

    await plat.topup(cid, 750)
    await page.reload()
    await expect(chip(page)).toHaveAttribute('data-status', 'ok')
    await expect(page.getByTestId('ai-wallet-chip-balance')).toHaveText('750')
    await expect(page.getByTestId('ai-wallet-chip-status')).toHaveCount(0)

    await plat.wallet(cid, { low_threshold_credits: 1000 })
    await page.reload()
    await expect(chip(page)).toHaveAttribute('data-status', 'low')
    await expect(page.getByTestId('ai-wallet-chip-status')).toHaveText('Saldo baixo')

    await chip(page).click()
    await expect(page).toHaveURL(/[?&]tab=ai_usage(&|$)/)
    await expect(page.getByTestId('ai-usage')).toBeVisible()
    await expect(page.getByRole('button', { name: BUY })).toHaveCount(0)
  })

  test('AC-T59-01 atualiza ao vivo com ai_wallet.updated (sem recarregar nem reler a carteira)', async ({ page, request }) => {
    await loginAs(page, 'owner')
    const cid = await companyId(page)
    const plat = await platform(request)
    await plat.topup(cid, 300)

    await page.goto('/settings?tab=accounts')
    await expect(page.getByTestId('ai-wallet-chip-balance')).toHaveText('300')
    await expect(chip(page)).toHaveAttribute('data-status', 'ok')

    // daqui em diante a leitura HTTP da carteira devolve o valor velho: só o evento realtime pode mudar o chip
    const stale = await (await page.request.get('/api/ai/wallet')).json()
    let walletReads = 0
    await page.route(/\/api\/ai\/wallet(\?|$)/, (route) => {
      walletReads++
      return route.fulfill({ json: stale })
    })
    await page.waitForTimeout(1500) // SSE assentado (o chip já renderizou; a conexão abre junto com o shell)

    await plat.topup(cid, 900)
    await expect(page.getByTestId('ai-wallet-chip-balance')).toHaveText('1.200')
    await expect(chip(page)).toHaveAttribute('data-status', 'ok')

    // ajuste negativo até zerar → exhausted ao vivo
    await plat.adjust(cid, -1200)
    await expect(page.getByTestId('ai-wallet-chip-balance')).toHaveText('0')
    await expect(chip(page)).toHaveAttribute('data-status', 'exhausted')
    await expect(page.getByTestId('ai-wallet-chip-status')).toHaveText('Esgotado')
    expect(walletReads, 'o chip mudou por releitura HTTP, não pelo evento').toBe(0)
  })

  test('AC-T59-01 atualiza ao focar a janela', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.goto('/settings?tab=accounts')
    await expect(chip(page)).toHaveAttribute('data-status', 'exhausted')
    await expect(page.getByTestId('ai-wallet-chip-balance')).toHaveText('0')

    // a carteira muda "por fora" sem evento realtime (rota interceptada); só o foco da janela pode trazer o valor novo
    const real = await (await page.request.get('/api/ai/wallet')).json()
    const changed = { wallet: { ...real.wallet, balance_credits: 4321, status: 'ok' } }
    const reads: number[] = []
    await page.route(/\/api\/ai\/wallet(\?|$)/, (route) => {
      reads.push(Date.now())
      return route.fulfill({ json: changed })
    })
    await page.waitForTimeout(500)
    await expect(page.getByTestId('ai-wallet-chip-balance')).toHaveText('0')

    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByTestId('ai-wallet-chip-balance')).toHaveText('4.321')
    await expect(chip(page)).toHaveAttribute('data-status', 'ok')
    expect(reads.length).toBeGreaterThan(0)
  })

  test('AC-T59-01 member sem ai_usage.view não vê o chip nem a aba de consumo', async ({ page }) => {
    await loginAs(page, 'member')
    await page.goto('/settings')
    await expect(page.getByTestId('settings-tab-integrations')).toBeVisible()
    await expect(chip(page)).toHaveCount(0)
    await expect(page.getByTestId('settings-tab-ai_usage')).toHaveCount(0)
  })
})

// =================================================================================================== AC-T59-02
test.describe('T59 — aba de consumo de IA', () => {
  test('AC-T59-02 sem uso: "Nenhum uso de IA nesta empresa", cards de saldo e sem recarga, cotas vazias', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'ai_usage', 'ai-usage')
    await expect(page.getByTestId('ai-usage-empty')).toHaveText('Nenhum uso de IA nesta empresa')
    await expect(page.getByTestId('ai-usage-balance')).toHaveText('0')
    await expect(page.getByTestId('ai-usage-last-topup-none')).toBeVisible()
    await expect(page.getByTestId('ai-usage-card-period')).toBeVisible()
    await expect(page.getByTestId('ai-usage-quotas-empty')).toBeVisible()
    await expect(page.getByTestId('ai-usage-chart')).toHaveCount(0)
    await expect(page.getByTestId('ai-usage-statement')).toHaveCount(0)
    await expect(page.getByRole('button', { name: BUY })).toHaveCount(0)
  })

  test('AC-T59-02 cards (saldo, uso no período, última recarga), gráfico por dia/feature, extrato filtrável e cotas com barra', async ({ page, request }) => {
    await loginAs(page, 'owner')
    const cid = await companyId(page)
    const plat = await platform(request)
    await plat.topup(cid, 200)
    await plat.topup(cid, 750) // a última recarga é esta
    await plat.quotas(cid, [
      { period: 'day', max_credits: 50, max_tokens: 5000 },
      { period: 'month', max_credits: 3000, hard: false },
    ])
    const { usageReqs, summaryReqs } = await mockUsage(page)

    await openTab(page, 'ai_usage', 'ai-usage')
    await expect(page.getByTestId('ai-usage-empty')).toHaveCount(0)

    // cards
    await expect(page.getByTestId('ai-usage-balance')).toHaveText('950')
    await expect(page.getByTestId('ai-usage-last-topup')).toHaveText('+750')
    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).slice(0, 5)
    await expect(page.getByTestId('ai-usage-last-topup-date')).toContainText(today)
    await expect(page.getByTestId('ai-usage-period-credits')).toHaveText('60') // 40 + 20 (erro fica fora)
    await expect(page.getByTestId('ai-usage-period-detail')).toContainText('2')
    const featureSum = summaryReqs.find((u) => u.searchParams.get('group_by') === 'feature' && u.searchParams.get('from') && u.searchParams.get('to'))
    expect(featureSum, 'card do período pede o resumo com from/to').toBeTruthy()

    // período muda o intervalo pedido
    const before = summaryReqs.length
    await page.getByTestId('ai-usage-period').selectOption('7d')
    await expect.poll(() => summaryReqs.length).toBeGreaterThan(before)
    const r7 = summaryReqs.at(-1)!
    const days = (Date.parse(r7.searchParams.get('to')!) - Date.parse(r7.searchParams.get('from')!)) / 86_400_000
    expect(Math.round(days)).toBe(7)

    // gráfico por dia (3 dias com uso cobrado = 2: hoje e ontem) e por feature (ai_agent, flow_ai)
    const chart = page.getByTestId('ai-usage-chart')
    await expect(chart).toHaveAttribute('data-group', 'day')
    await expect(page.getByTestId('ai-usage-chart-bars')).toHaveAttribute('data-count', String(groupBy((u) => u.created_at.slice(0, 10)).length))
    await expect(chart.locator('.recharts-bar-rectangle').first()).toBeVisible()
    await page.getByTestId('ai-usage-chart-group-feature').click()
    await expect(chart).toHaveAttribute('data-group', 'feature')
    await expect(page.getByTestId('ai-usage-chart-bars')).toHaveAttribute('data-count', '2')
    await expect(chart).toContainText('Agente de IA')
    await expect(chart).toContainText('Bloco de IA do fluxo')
    await page.getByTestId('ai-usage-chart-group-day').click()
    await expect(chart).toHaveAttribute('data-group', 'day')

    // extrato: tudo, depois filtros (vão ao servidor como parâmetros)
    await expect(page.getByTestId('ai-usage-list')).toBeVisible()
    for (const u of USAGE) await expect(page.getByTestId(`ai-usage-item-${u.id}`)).toBeVisible()
    await expect(page.getByTestId('ai-usage-item-feature-u-agent-1')).toHaveText('Agente de IA')
    await expect(page.getByTestId('ai-usage-item-model-u-agent-1')).toContainText('openai/gpt-4o-mini')
    await expect(page.getByTestId('ai-usage-item-status-u-err-3')).toHaveText('Erro')
    await expect(page.getByTestId('ai-usage-item-credits-u-agent-1')).toHaveText('40')

    await page.getByTestId('ai-usage-filter-status').selectOption('error')
    await expect(page.getByTestId('ai-usage-item-u-err-3')).toBeVisible()
    await expect(page.getByTestId('ai-usage-item-u-agent-1')).toHaveCount(0)
    expect(usageReqs.some((u) => u.searchParams.get('status') === 'error')).toBe(true)
    await page.getByTestId('ai-usage-filter-status').selectOption('')

    await page.getByTestId('ai-usage-filter-provider').selectOption('openai')
    await expect(page.getByTestId('ai-usage-item-u-agent-1')).toBeVisible()
    await expect(page.getByTestId('ai-usage-item-u-flow-2')).toHaveCount(0)
    expect(usageReqs.some((u) => u.searchParams.get('provider') === 'openai')).toBe(true)
    await page.getByTestId('ai-usage-filter-provider').selectOption('')

    await page.getByTestId('ai-usage-filter-feature').selectOption('flow_ai')
    await expect(page.getByTestId('ai-usage-item-u-flow-2')).toBeVisible()
    await expect(page.getByTestId('ai-usage-item-u-agent-1')).toHaveCount(0)
    expect(usageReqs.some((u) => u.searchParams.get('feature') === 'flow_ai')).toBe(true)
    await page.getByTestId('ai-usage-filter-status').selectOption('refunded')
    await expect(page.getByTestId('ai-usage-list-empty')).toBeVisible()

    // cotas: barras de progresso com o uso somado do resumo (60 créditos, 2500 tokens)
    await expect(page.getByTestId('ai-usage-quota-day')).toBeVisible()
    await expect(page.getByTestId('ai-usage-quota-month')).toBeVisible()
    const dayCredits = page.getByTestId('ai-usage-quota-day-credits')
    await expect(dayCredits).toHaveAttribute('role', 'progressbar')
    await expect(dayCredits).toHaveAttribute('data-pct', '100')
    await expect(dayCredits).toHaveAttribute('data-over', 'true')
    await expect(page.getByTestId('ai-usage-quota-day-credits-text')).toHaveText('60 / 50')
    await expect(page.getByTestId('ai-usage-quota-day-tokens')).toHaveAttribute('data-pct', '50')
    await expect(page.getByTestId('ai-usage-quota-day-tokens')).toHaveAttribute('data-over', 'false')
    await expect(page.getByTestId('ai-usage-quota-day-tokens-text')).toHaveText('2.500 / 5.000')
    await expect(page.getByTestId('ai-usage-quota-month-credits')).toHaveAttribute('data-pct', '2')
    await expect(page.getByTestId('ai-usage-quota-month-credits-text')).toHaveText('60 / 3.000')
    await expect(page.getByTestId('ai-usage-quota-month-cost')).toHaveCount(0) // limite não definido = sem barra
    // uso da cota diária pedido desde o início do dia
    expect(summaryReqs.some((u) => u.searchParams.get('from') && !u.searchParams.get('to'))).toBe(true)
  })
})

// =================================================================================================== AC-T59-03
async function createKey(page: Page, body: { provider: string; name: string; secret: string; active?: boolean }) {
  return (await api(page, 'post', '/api/ai-keys', body)).key as { id: string; hint: string; name: string }
}

test.describe('T59 — hub de integrações', () => {
  test('AC-T59-03 abas IA/Vendas/Rastreamento (?cat=) com catálogo de IA e vazios das outras categorias', async ({ page }) => {
    await loginAs(page, 'owner')
    await openTab(page, 'integrations', 'integrations-hub')
    const hub = page.getByTestId('integrations-hub')
    await expect(hub).toHaveAttribute('data-cat', 'ai')
    await expect(page.getByTestId('integrations-cat-ai')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('integrations-cat-ai')).toContainText('IA')
    await expect(page.getByTestId('integrations-cat-sales')).toContainText('Vendas')
    await expect(page.getByTestId('integrations-cat-tracking')).toContainText('Rastreamento')
    for (const p of ['anthropic', 'openai', 'google', 'openrouter', 'elevenlabs', 'groq'])
      await expect(page.getByTestId(`integrations-catalog-${p}`)).toBeVisible()
    await expect(page.getByTestId('integrations-records-empty')).toBeVisible()

    await page.getByTestId('integrations-cat-sales').click()
    await expect(page).toHaveURL(/[?&]cat=sales(&|$)/)
    await expect(hub).toHaveAttribute('data-cat', 'sales')
    await expect(page.getByTestId('integrations-cat-sales')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('integrations-cat-ai')).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByTestId('integrations-empty-category')).toContainText('Vendas')
    await expect(page.getByTestId('integrations-catalog-openai')).toHaveCount(0)

    await page.getByTestId('integrations-cat-tracking').click()
    await expect(page).toHaveURL(/[?&]cat=tracking(&|$)/)
    await expect(page.getByTestId('integrations-empty-category')).toContainText('Rastreamento')

    // a categoria vem da URL (link direto/recarga) e o tab continua sendo integrations
    await page.goto('/settings?tab=integrations&cat=sales')
    await expect(page).toHaveURL(/[?&]tab=integrations(&|$)/)
    await expect(hub).toHaveAttribute('data-cat', 'sales')
    await page.getByTestId('integrations-cat-ai').click()
    await expect(page).toHaveURL(/[?&]cat=ai(&|$)/)
    await expect(page.getByTestId('integrations-catalog-openai')).toBeVisible()
  })

  test('AC-T59-03 busca ignora acentos (nos dois sentidos) e mostra o vazio de busca', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const k = await createKey(page, { provider: 'openai', name: `Integração ${tag}`, secret: `sk-${tag}-okay` })
    await openTab(page, 'integrations', 'integrations-hub')
    const search = page.getByTestId('integrations-search')
    await expect(page.getByTestId(`integrations-record-${k.id}`)).toBeVisible()

    // termo sem acento casa texto com acento ("Síntese de voz" do ElevenLabs; "Integração" do registro)
    await search.fill('sintese')
    await expect(page.getByTestId('integrations-catalog-elevenlabs')).toBeVisible()
    await expect(page.getByTestId('integrations-catalog-openai')).toHaveCount(0)
    await search.fill(`integracao ${tag}`)
    await expect(page.getByTestId(`integrations-record-${k.id}`)).toBeVisible()

    // termo com acento/maiúsculas casa texto sem acento ("Groq", "Gemini")
    await search.fill('GRÓQ')
    await expect(page.getByTestId('integrations-catalog-groq')).toBeVisible()
    await expect(page.getByTestId('integrations-catalog-google')).toHaveCount(0)
    await search.fill('gêmini')
    await expect(page.getByTestId('integrations-catalog-google')).toBeVisible()
    await expect(page.getByTestId('integrations-catalog-groq')).toHaveCount(0)

    await search.fill(`zzz${tag}`)
    await expect(page.getByTestId('integrations-empty-search')).toContainText(`zzz${tag}`)
    await search.fill('')
    await expect(page.getByTestId('integrations-catalog-openai')).toBeVisible()
  })

  test('AC-T59-03 status Ativo/Inativo por chave configurada e contador de ativas na aba', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const on = await createKey(page, { provider: 'openai', name: `Ligada ${tag}`, secret: `sk-${tag}-on1` })
    const off = await createKey(page, { provider: 'anthropic', name: `Desligada ${tag}`, secret: `sk-${tag}-off2`, active: false })
    await openTab(page, 'integrations', 'integrations-hub')

    await expect(page.getByTestId(`integrations-record-title-${on.id}`)).toHaveText(`Ligada ${tag}`)
    await expect(page.getByTestId(`integrations-record-status-${on.id}`)).toHaveText('Ativo')
    await expect(page.getByTestId(`integrations-record-status-${on.id}`)).toHaveAttribute('data-status', 'active')
    await expect(page.getByTestId(`integrations-record-status-${off.id}`)).toHaveText('Inativo')
    await expect(page.getByTestId(`integrations-record-status-${off.id}`)).toHaveAttribute('data-status', 'inactive')
    await expect(page.getByTestId('integrations-cat-count-ai')).toHaveText('1')
    await expect(page.getByTestId('integrations-cat-count-sales')).toHaveText('0')

    // ativar pela edição muda o status e o contador
    await page.getByTestId(`integrations-record-edit-${off.id}`).click()
    await expect(page.getByTestId('ai-key-editor')).toHaveAttribute('data-mode', 'edit')
    await expect(page.getByTestId('ai-key-active')).not.toBeChecked()
    await page.getByTestId('ai-key-active').check()
    await page.getByTestId('ai-key-save').click()
    await expect(page.getByTestId('ai-key-editor')).toHaveCount(0)
    await expect(page.getByTestId(`integrations-record-status-${off.id}`)).toHaveText('Ativo')
    await expect(page.getByTestId('integrations-cat-count-ai')).toHaveText('2')
  })
})

// =================================================================================================== AC-T59-04
test.describe('T59 — modal da chave de IA', () => {
  test('AC-T59-04 criar pelo catálogo: segredo mascarado (password) e nunca exibido depois; só o hint', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const secret = `sk-live-${tag}-segredo-9z8y`
    await openTab(page, 'integrations', 'integrations-hub')
    await page.getByTestId('integrations-catalog-configure-openai').click()
    const editor = page.getByTestId('ai-key-editor')
    await expect(editor).toHaveAttribute('data-mode', 'create')
    await expect(page.getByTestId('ai-key-provider')).toHaveValue('openai')

    // validação no cliente
    await page.getByTestId('ai-key-save').click()
    await expect(page.getByTestId('ai-key-name-error')).toBeVisible()
    await expect(page.getByTestId('ai-key-secret-error')).toBeVisible()

    await page.getByTestId('ai-key-name').fill(`Produção ${tag}`)
    await expect(page.getByTestId('ai-key-secret')).toHaveAttribute('type', 'password')
    await page.getByTestId('ai-key-secret').fill(secret)
    await page.getByTestId('ai-key-save').click()
    await expect(editor).toHaveCount(0)

    const key = ((await api(page, 'get', '/api/ai-keys')).items as any[]).find((k) => k.name === `Produção ${tag}`)
    expect(key).toBeTruthy()
    const card = page.getByTestId(`integrations-record-${key.id}`)
    await expect(card).toContainText(key.hint)
    await expect(page.locator('body')).not.toContainText(secret)

    // na edição o campo vem vazio, mascarado, com o hint no placeholder
    await page.getByTestId(`integrations-record-edit-${key.id}`).click()
    await expect(page.getByTestId('ai-key-provider')).toBeDisabled()
    await expect(page.getByTestId('ai-key-secret')).toHaveAttribute('type', 'password')
    await expect(page.getByTestId('ai-key-secret')).toHaveValue('')
    await expect(page.getByTestId('ai-key-secret')).toHaveAttribute('placeholder', key.hint)
    expect(await page.content()).not.toContain(secret)
  })

  test('AC-T59-04 "Testar" mostra a latência (ok) ou o erro (falha) do probe fake', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const ok = await createKey(page, { provider: 'openai', name: `Boa ${tag}`, secret: `sk-${tag}-okay` })
    const bad = await createKey(page, { provider: 'groq', name: `Ruim ${tag}`, secret: `sk-${tag}-fail` })
    await openTab(page, 'integrations', 'integrations-hub')

    await page.getByTestId(`integrations-record-edit-${ok.id}`).click()
    await page.getByTestId('ai-key-test').click()
    await expect(page.getByTestId('ai-key-test-result')).toHaveAttribute('data-ok', 'true')
    await expect(page.getByTestId('ai-key-test-result')).toHaveText(/Conexão OK em \d+ ms/)
    const ms = Number((await page.getByTestId('ai-key-test-result').textContent())!.match(/(\d+) ms/)![1])
    expect(ms).toBeGreaterThanOrEqual(80)
    await page.getByTestId('ai-key-cancel').click()

    await page.getByTestId(`integrations-record-edit-${bad.id}`).click()
    await page.getByTestId('ai-key-test').click()
    await expect(page.getByTestId('ai-key-test-result')).toHaveAttribute('data-ok', 'false')
    await expect(page.getByTestId('ai-key-test-result')).toHaveText('Falha no teste: HTTP 401')
    await expect(page.getByTestId('ai-key-test-result')).not.toContainText(`sk-${tag}`)
    await page.getByTestId('ai-key-cancel').click()

    // atalho Testar no card
    await page.getByTestId(`integrations-record-test-${bad.id}`).click()
    await expect(page.getByTestId(`integrations-record-test-result-${bad.id}`)).toHaveText('Falha no teste: HTTP 401')
    await page.getByTestId(`integrations-record-test-${ok.id}`).click()
    await expect(page.getByTestId(`integrations-record-test-result-${ok.id}`)).toHaveText(/Conexão OK em \d+ ms/)
  })

  test('AC-T59-04 editar com segredo em branco mantém o atual; preenchido troca', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const k = await createKey(page, { provider: 'openai', name: `Velha ${tag}`, secret: `sk-${tag}-fail` })
    await openTab(page, 'integrations', 'integrations-hub')

    // edita só o nome: o PATCH não leva `secret` e a chave continua a mesma (o teste segue falhando, hint igual)
    await page.getByTestId(`integrations-record-edit-${k.id}`).click()
    await page.getByTestId('ai-key-name').fill(`Renomeada ${tag}`)
    const patch = page.waitForRequest((r: Request) => ['PATCH', 'PUT'].includes(r.method()) && r.url().includes(`/api/ai-keys/${k.id}`))
    await page.getByTestId('ai-key-save').click()
    const body = (await patch).postDataJSON()
    expect(body.name).toBe(`Renomeada ${tag}`)
    expect(body.secret ?? '').toBe('')
    await expect(page.getByTestId('ai-key-editor')).toHaveCount(0)
    await expect(page.getByTestId(`integrations-record-title-${k.id}`)).toHaveText(`Renomeada ${tag}`)
    const after = (await api(page, 'get', `/api/ai-keys/${k.id}`)).key
    expect(after.hint).toBe(k.hint)

    await page.getByTestId(`integrations-record-edit-${k.id}`).click()
    await expect(page.getByTestId('ai-key-secret')).toHaveValue('')
    await page.getByTestId('ai-key-test').click()
    await expect(page.getByTestId('ai-key-test-result')).toHaveText('Falha no teste: HTTP 401')

    // segredo preenchido troca a chave: o teste passa e o hint muda
    await page.getByTestId('ai-key-secret').fill(`sk-${tag}-nova-okay`)
    await page.getByTestId('ai-key-save').click()
    await expect(page.getByTestId('ai-key-editor')).toHaveCount(0)
    const swapped = (await api(page, 'get', `/api/ai-keys/${k.id}`)).key
    expect(swapped.hint).not.toBe(k.hint)
    await page.getByTestId(`integrations-record-test-${k.id}`).click()
    await expect(page.getByTestId(`integrations-record-test-result-${k.id}`)).toHaveText(/Conexão OK em \d+ ms/)
  })
})
