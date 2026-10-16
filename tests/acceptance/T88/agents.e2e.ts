// AC-T88-01..04 — agentes de IA (/agentes): abas Agentes|Vozes, filtros por status, busca, cota e modal de limite;
// editor com abas e erro do servidor no campo; seletor de modelo com provedores disponíveis/indisponíveis;
// publicar/pausar e estado das fontes de conhecimento por SSE.
// Contrato de data-testid combinado com o Torno; massa pela API (T39/T38/T52) e limite em companies.settings via psql.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page, type Request } from '@playwright/test'
import { expectNoHorizontalScroll, isMobile, loginAs, resetSeed } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'
import { dbUrl, sqlOk } from '../helpers/pg'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Modelo LLM do seed de preços (crm.llm_prices). */
const MODEL = 'gpt-6-luna'

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'patch' | 'delete', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

async function agent(page: Page, name: string, extra: Record<string, unknown> = {}) {
  return (await api(page, 'post', '/api/ai-agents', { name, ...extra })).agent as { id: string; name: string; status: string }
}

/** Chave BYOK da empresa (criar não chama o provedor). */
async function aiKey(page: Page, provider: string) {
  return (await api(page, 'post', '/api/ai-keys', { provider, name: `Chave ${uniq()}`, secret: `sk-fake-${uniq()}` })).key as { id: string }
}

/** Agente pronto para publicar: prompt e modelo de um provedor com chave. */
async function publishable(page: Page, name: string) {
  await aiKey(page, 'openai')
  return agent(page, name, { generated_prompt: 'Você é um atendente cordial.', model: { provider: 'openai', model: MODEL } })
}

/** Banco do harness deste worktree (test-results/e2e-server.json). */
function harnessDb(): string {
  const info = JSON.parse(readFileSync(join(process.cwd(), 'test-results', 'e2e-server.json'), 'utf8'))
  return dbUrl(info.database)
}

/** Empresa Demo do seed (empresa ativa do owner após o login). */
const demoCompany = (login: Any): string => login.companies.find((c: Any) => c.name === 'Empresa Demo').id

function setAgentLimit(company: string, limit: number) {
  sqlOk(
    harnessDb(),
    `UPDATE crm.companies SET settings = jsonb_set(coalesce(settings, '{}'::jsonb) || jsonb_build_object('limits', coalesce(settings->'limits', '{}'::jsonb)), '{limits,ai_agents}', to_jsonb(${Number(limit)}::int)) WHERE id = '${company}';`,
  )
}

const cards = (page: Page) => page.locator('[data-testid^="agents-card-"]').filter({ visible: true })

async function openList(page: Page) {
  await page.goto('/agentes')
  await expect(page.getByTestId('page-agents')).toBeVisible()
}

async function openEditor(page: Page, id: string) {
  await page.goto(`/agentes/${id}`)
  await expect(page.getByTestId('agent-editor')).toBeVisible()
}

async function openTab(page: Page, tab: string) {
  await page.getByTestId(`agent-tab-${tab}`).filter({ visible: true }).first().click()
  await expect(page.getByTestId(`agent-tab-${tab}`).filter({ visible: true }).first()).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId(`agent-panel-${tab}`)).toBeVisible()
}

test.describe('T88 — lista de agentes', () => {
  test('AC-T88-01 abas Agentes e Vozes', async ({ page }) => {
    await loginAs(page, 'owner')
    await openList(page)
    await expect(page.getByTestId('agents-tab-agents')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('agents-tab-voices').click()
    await expect(page.getByTestId('agents-tab-voices')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('agents-voices-panel')).toBeVisible()
    await expect(page.getByTestId('agents-voices-empty').or(page.locator('[data-testid^="agents-voice-"]').filter({ visible: true })).first()).toBeVisible()
    await page.getByTestId('agents-tab-agents').click()
    await expect(page.getByTestId('agents-tab-agents')).toHaveAttribute('aria-selected', 'true')
    if (isMobile(page)) await expectNoHorizontalScroll(page)
  })

  test('AC-T88-01 filtros todos/ativos/rascunhos/pausados mostram só os agentes do status', async ({ page }) => {
    await loginAs(page, 'owner')
    const rascunho = await agent(page, `Rascunho ${uniq()}`)
    const ativo = await publishable(page, `Ativo ${uniq()}`)
    await api(page, 'post', `/api/ai-agents/${ativo.id}/publish`)
    const pausado = await agent(page, `Pausado ${uniq()}`, { generated_prompt: 'Prompt.', model: { provider: 'openai', model: MODEL } })
    await api(page, 'post', `/api/ai-agents/${pausado.id}/publish`)
    await api(page, 'post', `/api/ai-agents/${pausado.id}/pause`)
    await openList(page)

    const all = [rascunho, ativo, pausado]
    const expectOnly = async (shown: Array<{ id: string }>) => {
      for (const a of all) {
        const card = page.getByTestId(`agents-card-${a.id}`).filter({ visible: true })
        if (shown.includes(a)) await expect(card).toBeVisible()
        else await expect(card).toHaveCount(0)
      }
    }
    await expect(page.getByTestId('agents-filter-all')).toHaveAttribute('aria-pressed', 'true')
    await expectOnly(all)
    await expect(page.getByTestId(`agents-card-${ativo.id}`)).toHaveAttribute('data-status', 'active')
    await expect(page.getByTestId(`agents-card-${pausado.id}`)).toHaveAttribute('data-status', 'paused')
    await expect(page.getByTestId(`agents-card-${rascunho.id}`)).toHaveAttribute('data-status', 'draft')

    for (const [filter, shown] of [
      ['active', [ativo]],
      ['draft', [rascunho]],
      ['paused', [pausado]],
      ['all', all],
    ] as const) {
      await page.getByTestId(`agents-filter-${filter}`).click()
      await expect(page.getByTestId(`agents-filter-${filter}`)).toHaveAttribute('aria-pressed', 'true')
      await expectOnly([...shown])
    }
  })

  test('AC-T88-01 busca filtra os agentes pelo nome', async ({ page }) => {
    await loginAs(page, 'owner')
    const tag = uniq()
    const a = await agent(page, `Vendas ${tag}`)
    const b = await agent(page, `Suporte ${tag}`)
    await openList(page)
    await expect(page.getByTestId(`agents-card-${a.id}`).filter({ visible: true })).toBeVisible()
    await page.getByTestId('agents-search').fill(`Vendas ${tag}`)
    await expect(cards(page)).toHaveCount(1)
    await expect(page.getByTestId(`agents-card-${a.id}`).filter({ visible: true })).toBeVisible()
    await page.getByTestId('agents-search').fill(`nada-${tag}`)
    await expect(cards(page)).toHaveCount(0)
    await expect(page.getByTestId('agents-empty')).toBeVisible()
    await page.getByTestId('agents-search').fill('')
    await expect(page.getByTestId(`agents-card-${b.id}`).filter({ visible: true })).toBeVisible()
  })

  test('AC-T88-01 cota "N de M agentes" e limite atingido abre o modal em vez de criar', async ({ page }) => {
    const company = demoCompany(await loginAs(page, 'owner'))
    await agent(page, `Cota ${uniq()}`)
    const used = (await api(page, 'get', '/api/ai-agents')).quota.used as number
    // sem limite: só "N agentes"
    await openList(page)
    await expect(page.getByTestId('agents-quota')).toHaveText(new RegExp(`(^|\\D)${used} agentes`))
    await expect(page.getByTestId('agents-quota')).not.toContainText(' de ')
    setAgentLimit(company, used + 1)
    await openList(page)
    await expect(page.getByTestId('agents-quota')).toContainText(`${used} de ${used + 1} agentes`)

    // ainda cabe um: "Novo" não abre o modal
    await agent(page, `Ultimo ${uniq()}`)
    await page.reload()
    await expect(page.getByTestId('agents-quota')).toContainText(`${used + 1} de ${used + 1} agentes`)
    const creates: Request[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/ai-agents') creates.push(r)
    })
    await page.getByTestId('agents-new').filter({ visible: true }).first().click()
    await expect(page.getByTestId('agents-limit-modal')).toBeVisible()
    await expect(page).toHaveURL(/\/agentes\/?(\?|$)/)
    expect(creates).toHaveLength(0)
    expect((await api(page, 'get', '/api/ai-agents')).quota.used).toBe(used + 1)
  })
})

test.describe('T88 — editor', () => {
  test('AC-T88-02 editor tem as abas Foto, Instruções, Habilidades, Conhecimento, Coleta de dados e Configurações', async ({ page }) => {
    await loginAs(page, 'owner')
    const a = await agent(page, `Abas ${uniq()}`)
    await openEditor(page, a.id)
    const labels: Record<string, RegExp> = {
      photo: /Foto/,
      instructions: /Instruções/,
      skills: /Habilidades/,
      knowledge: /Conhecimento/,
      collection: /Coleta de dados/,
      settings: /Configurações/,
    }
    for (const [tab, label] of Object.entries(labels)) {
      await expect(page.getByTestId(`agent-tab-${tab}`).filter({ visible: true }).first()).toHaveText(label)
      await openTab(page, tab)
    }
    if (isMobile(page)) await expectNoHorizontalScroll(page)
  })

  test('AC-T88-02 salvar grava pela API e o erro do servidor aparece no campo', async ({ page }) => {
    await loginAs(page, 'owner')
    const a = await agent(page, `Salvar ${uniq()}`)
    await openEditor(page, a.id)
    await openTab(page, 'photo')

    // salvar de verdade
    const novo = `Renomeado ${uniq()}`
    await page.getByTestId('agent-name').fill(novo)
    const save = page.waitForRequest((r) => ['PATCH', 'PUT'].includes(r.method()) && new URL(r.url()).pathname === `/api/ai-agents/${a.id}`)
    await page.getByTestId('agent-save').filter({ visible: true }).first().click()
    expect((await (await save).response())?.status()).toBe(200)
    await expect.poll(async () => (await api(page, 'get', `/api/ai-agents/${a.id}`)).agent.name).toBe(novo)

    // erro de validação do servidor vai para o campo
    await page.route(`**/api/ai-agents/${a.id}`, (route) =>
      ['PATCH', 'PUT'].includes(route.request().method())
        ? route.fulfill({
            status: 422,
            json: { error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos', details: { fields: [{ path: 'name', message: 'Nome já usado por outro agente' }] } } },
          })
        : route.fallback(),
    )
    await page.getByTestId('agent-name').fill(`Outro ${uniq()}`)
    await page.getByTestId('agent-save').filter({ visible: true }).first().click()
    await expect(page.getByTestId('agent-field-error-name')).toHaveText(/Nome já usado por outro agente/)
    await expect(page.getByTestId('agent-name')).toHaveAttribute('aria-invalid', 'true')
  })

  test('AC-T88-02 erro do servidor em campo de outra aba leva o editor até a aba do campo', async ({ page }) => {
    await loginAs(page, 'owner')
    const a = await agent(page, `OutraAba ${uniq()}`)
    await openEditor(page, a.id)
    await openTab(page, 'photo')
    await page.route(`**/api/ai-agents/${a.id}`, (route) =>
      ['PATCH', 'PUT'].includes(route.request().method())
        ? route.fulfill({
            status: 422,
            json: { error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos', details: { fields: [{ path: 'settings.buffer_seconds', message: 'Entre 0 e 120 segundos' }] } } },
          })
        : route.fallback(),
    )
    await page.getByTestId('agent-name').fill(`Mudou ${uniq()}`)
    await page.getByTestId('agent-save').filter({ visible: true }).first().click()
    await expect(page.getByTestId('agent-tab-settings').filter({ visible: true }).first()).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('agent-field-error-settings.buffer_seconds').filter({ visible: true }).first()).toHaveText(/Entre 0 e 120 segundos/)
  })

  test('AC-T88-03 seletor de modelo marca disponíveis (com chave) e indisponíveis', async ({ page }) => {
    await loginAs(page, 'owner')
    await aiKey(page, 'openai')
    const a = await agent(page, `Modelo ${uniq()}`)
    await openEditor(page, a.id)
    await openTab(page, 'settings')
    await page.getByTestId('agent-model-select').click()
    await expect(page.getByTestId('agent-model-options')).toBeVisible()
    const options = page.locator('[data-testid="agent-model-option"]').filter({ visible: true })
    await expect(options.first()).toBeVisible()

    const openai = options.and(page.locator('[data-provider="openai"]'))
    const anthropic = options.and(page.locator('[data-provider="anthropic"]'))
    await expect(openai.first()).toBeVisible()
    await expect(anthropic.first()).toBeVisible()
    for (const opt of await openai.all()) await expect(opt).toHaveAttribute('data-available', 'true')
    for (const opt of await anthropic.all()) {
      await expect(opt).toHaveAttribute('data-available', 'false')
      await expect(opt).toHaveAttribute('aria-disabled', 'true')
      await expect(opt).toContainText('sem chave')
    }
    // os modelos vêm do catálogo de preços: os do seed estão na lista
    await expect(options.and(page.locator(`[data-model="${MODEL}"]`))).toHaveCount(1)
    await expect(options.and(page.locator('[data-model="claude-haiku-5-5"]'))).toHaveCount(1)
    // clicar num indisponível não muda a escolha
    await anthropic.first().click({ force: true })
    if (!(await page.getByTestId('agent-model-options').isVisible())) await page.getByTestId('agent-model-select').click()

    // escolher um modelo disponível e salvar grava provider/model
    const chosen = openai.first()
    const model = (await chosen.getAttribute('data-model'))!
    await chosen.click()
    const save = page.waitForRequest((r) => ['PATCH', 'PUT'].includes(r.method()) && new URL(r.url()).pathname === `/api/ai-agents/${a.id}`)
    await page.getByTestId('agent-save').filter({ visible: true }).first().click()
    await save
    await expect.poll(async () => (await api(page, 'get', `/api/ai-agents/${a.id}`)).agent.model).toEqual({ provider: 'openai', model })
  })
})

test.describe('T88 — status e conhecimento', () => {
  test('AC-T88-04 Publicar e Pausar refletem o status', async ({ page }) => {
    await loginAs(page, 'owner')
    const a = await publishable(page, `Publicar ${uniq()}`)
    await openEditor(page, a.id)
    await expect(page.getByTestId('agent-status')).toHaveAttribute('data-status', 'draft')

    await page.getByTestId('agent-publish').filter({ visible: true }).first().click()
    await expect(page.getByTestId('agent-status')).toHaveAttribute('data-status', 'active')
    await expect.poll(async () => (await api(page, 'get', `/api/ai-agents/${a.id}`)).agent.status).toBe('active')
    await expect(page.getByTestId('agent-pause').filter({ visible: true }).first()).toBeVisible()
    await expect(page.getByTestId('agent-publish').filter({ visible: true })).toHaveCount(0)

    await page.getByTestId('agent-pause').filter({ visible: true }).first().click()
    await expect(page.getByTestId('agent-status')).toHaveAttribute('data-status', 'paused')
    await expect.poll(async () => (await api(page, 'get', `/api/ai-agents/${a.id}`)).agent.status).toBe('paused')
    await expect(page.getByTestId('agent-pause').filter({ visible: true })).toHaveCount(0)

    // publicar de novo a partir de pausado
    await page.getByTestId('agent-publish').filter({ visible: true }).first().click()
    await expect(page.getByTestId('agent-status')).toHaveAttribute('data-status', 'active')
  })

  test('AC-T88-04 publicar sem prompt mostra o erro do servidor e mantém rascunho', async ({ page }) => {
    await loginAs(page, 'owner')
    await aiKey(page, 'openai')
    const a = await agent(page, `SemPrompt ${uniq()}`, { model: { provider: 'openai', model: MODEL } })
    await openEditor(page, a.id)
    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/ai-agents/${a.id}/publish`)
    await page.getByTestId('agent-publish').filter({ visible: true }).first().click()
    expect((await (await post).response())?.status()).toBeGreaterThanOrEqual(400)
    await expect(page.getByTestId('agent-field-error-generated_prompt').filter({ visible: true }).first()).toBeVisible()
    await expect(page.getByTestId('agent-status')).toHaveAttribute('data-status', 'draft')
  })

  test('AC-T88-04 fonte de conhecimento sai de pending pelo SSE, sem recarregar', async ({ page }) => {
    await loginAs(page, 'owner')
    const a = await agent(page, `Conhecimento ${uniq()}`)
    await openEditor(page, a.id)
    await openTab(page, 'knowledge')
    let reloads = 0
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) reloads++
    })

    const title = `Política ${uniq()}`
    await page.getByTestId('agent-knowledge-add-text').filter({ visible: true }).first().click()
    await page.getByTestId('agent-knowledge-text-title').fill(title)
    await page.getByTestId('agent-knowledge-text-body').fill('Trocas em até 7 dias com nota fiscal. Entregamos em todo o Brasil.')
    const post = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/ai-agents/${a.id}/knowledge-sources`)
    await page.getByTestId('agent-knowledge-text-save').click()
    const res = await (await post).response()
    expect(res?.status()).toBe(201)
    const sid = (await res!.json()).source.id as string
    const row = page.getByTestId(`agent-knowledge-source-${sid}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toHaveAttribute('data-status', /pending|ready/)
    await expect(row).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
    expect(reloads).toBe(0)
    expect((await api(page, 'get', `/api/ai-agents/${a.id}/knowledge-sources/${sid}`)).source.status).toBe('ready')
  })

  test('AC-T88-04 fonte que falha aparece como failed pelo SSE', async ({ page }) => {
    await loginAs(page, 'owner')
    const a = await agent(page, `Falha ${uniq()}`)
    await openEditor(page, a.id)
    await openTab(page, 'knowledge')
    let reloads = 0
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) reloads++
    })
    // URL bloqueada (SSRF) falha sem sair para a rede
    const created = await api(page, 'post', `/api/ai-agents/${a.id}/knowledge-sources`, { kind: 'site', url: 'http://127.0.0.1:9/x' })
    const sid = created.source.id as string
    const row = page.getByTestId(`agent-knowledge-source-${sid}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toHaveAttribute('data-status', 'failed', { timeout: 30_000 })
    expect(reloads).toBe(0)
  })
})
