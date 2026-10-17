// AC-T92-01..04 — laboratório dos agentes na UI: "Teste ao vivo" (FakeLlm do harness), criação assistida com estágios
// por SSE e banner "revise antes de publicar", aba Vozes (amostras, prévia, manter, excluir) e ditado (FakeStt).
// Contrato de data-testid: spec/reports/T92-entrega.md. Nenhum provedor real: LLM = FakeLlm (/__e2e/llm/script),
// STT = FakeStt do harness, vozes = FakeElevenLabsVoices local, leitura de site sem DNS.
import { expect, test, type Page } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { XRW } from '../helpers/chats-e2e'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const MODEL = 'gpt-6-luna'
/** Texto padrão do FakeStt do harness (scripts/e2e/api.ts). */
const STT_TEXT = 'Texto ditado pelo teste de voz.'
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function api(page: Page, method: 'get' | 'post' | 'patch' | 'delete', path: string, data?: unknown) {
  const res = method === 'get' ? await page.request.get(path) : await page.request[method](path, { data: data ?? {}, headers: XRW })
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeLessThan(300)
  return res.json()
}

/** Saldo de IA para a Empresa Demo (platform admin → topup) e volta logado como owner. */
async function ownerWithCredits(page: Page, credits = 1000) {
  const owner = await loginAs(page, 'owner')
  const company = owner.companies.find((c: Any) => c.name === 'Empresa Demo').id as string
  await loginAs(page, 'platformAdmin')
  await api(page, 'post', `/api/platform/companies/${company}/ai/topups`, { credits, note: `e2e T92 ${uniq()}` })
  await loginAs(page, 'owner')
  return company
}

const aiKey = (page: Page, provider: string) =>
  api(page, 'post', '/api/ai-keys', { provider, name: `Chave ${uniq()}`, secret: `sk-fake-${uniq()}` })

const SKILL_HUMAN = {
  enabled: true,
  when_text: 'quando o cliente pedir para falar com um humano',
  action_type: 'transfer_human',
  action_params: {},
  schedule_mode: 'now',
  silence_amount: 1,
  silence_unit: 'days',
}

async function labAgent(page: Page) {
  await aiKey(page, 'openai')
  return (
    await api(page, 'post', '/api/ai-agents', {
      name: `Lab ${uniq()}`,
      generated_prompt: 'Você é um atendente cordial.',
      model: { provider: 'openai', model: MODEL },
      collection_fields: [{ key: 'nome', label: 'Nome', enabled: true }],
      skills: [SKILL_HUMAN],
    })
  ).agent as { id: string; name: string }
}

const llmScript = (page: Page, steps: unknown[]) => api(page, 'post', '/__e2e/llm/script', { replace: true, steps })

async function openEditor(page: Page, id: string) {
  await page.goto(`/agentes/${id}`)
  await expect(page.getByTestId('agent-editor')).toBeVisible()
}

async function openVoicesTab(page: Page) {
  await page.goto('/agentes?tab=voices')
  await expect(page.getByTestId('agents-voices-panel')).toBeVisible()
}

const mp3 = (name: string) => ({ name, mimeType: 'audio/mpeg', buffer: Buffer.from(`ID3 fake mp3 ${name} ${'x'.repeat(256)}`) })
const wav = (name: string) => ({ name, mimeType: 'audio/wav', buffer: Buffer.from(`RIFF fake wav ${name} ${'x'.repeat(256)}`) })
const voiceRows = (page: Page) => page.locator('[data-testid^="agents-voice-"]').filter({ visible: true })

// ---------------------------------------------------------------- AC-T92-01
test.describe('T92 — teste ao vivo', () => {
  test('AC-T92-01 conversa com o agente pelo roteiro do FakeLlm e mostra habilidades, campos e créditos', async ({ page }) => {
    await ownerWithCredits(page)
    const agent = await labAgent(page)
    await llmScript(page, [
      {
        kind: 'tool-calls',
        calls: [
          { name: 'fill_field', input: { key: 'nome', value: 'Ana' } },
          { name: 'transfer_human', input: { reason: 'cliente pediu humano' } },
        ],
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      { kind: 'text', text: 'Oi, Ana! Vou te passar para uma pessoa.', usage: { inputTokens: 120, outputTokens: 15 } },
    ])
    await openEditor(page, agent.id)
    await page.getByTestId('agent-lab-open').click()
    const panel = page.getByTestId('agent-lab-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('agent-lab-empty')).toBeVisible()

    // Enter envia
    const input = panel.getByTestId('agent-lab-input')
    await input.fill('Sou a Ana, quero falar com uma pessoa')
    await input.press('Enter')

    const bubbles = panel.getByTestId('agent-lab-bubble')
    await expect(bubbles).toHaveCount(2)
    await expect(panel.locator('[data-testid="agent-lab-bubble"][data-role="user"]')).toContainText('Sou a Ana')
    const agentBubble = panel.locator('[data-testid="agent-lab-bubble"][data-role="agent"]').last()
    await expect(agentBubble).toContainText('Oi, Ana!')
    await expect(panel.getByTestId('agent-lab-error')).toHaveCount(0)

    // habilidade disparada
    await expect(agentBubble.getByTestId('agent-lab-skill-transfer_human')).toBeVisible()
    await expect(agentBubble.getByTestId('agent-lab-handoff')).toBeVisible()
    // campo preenchido (na resposta e no bloco de campos coletados)
    await expect(agentBubble.getByTestId('agent-lab-filled-nome')).toContainText('Ana')
    await expect(panel.getByTestId('agent-lab-field-nome')).toContainText('Ana')
    // créditos: por mensagem e acumulado, e uso diário de testes
    await expect(agentBubble.getByTestId('agent-lab-msg-credits')).toBeVisible()
    const credits = Number(await panel.getByTestId('agent-lab-credits').getAttribute('data-credits'))
    expect(credits).toBeGreaterThan(0)
    await expect(panel.getByTestId('agent-lab-eval')).toHaveAttribute('data-used', '1')
    expect(Number(await panel.getByTestId('agent-lab-eval').getAttribute('data-limit'))).toBeGreaterThan(1)

    // o LLM consumiu exatamente o roteiro (nada foi para provedor real)
    const llm = await api(page, 'get', '/__e2e/llm/script')
    expect(llm.remaining).toBe(0)

    // Limpar conversa zera o painel
    await panel.getByTestId('agent-lab-clear').click()
    await expect(panel.getByTestId('agent-lab-empty')).toBeVisible()
    await expect(panel.getByTestId('agent-lab-bubble')).toHaveCount(0)
    await panel.getByTestId('agent-lab-close').click()
    await expect(page.getByTestId('agent-lab-panel')).toHaveCount(0)
  })

  test('AC-T92-01 sem saldo a resposta vira bolha de erro', async ({ page }) => {
    await loginAs(page, 'owner')
    const agent = await labAgent(page)
    await llmScript(page, [{ kind: 'text', text: 'não deveria aparecer' }])
    await openEditor(page, agent.id)
    await page.getByTestId('agent-lab-open').click()
    const panel = page.getByTestId('agent-lab-panel')
    await panel.getByTestId('agent-lab-input').fill('Olá')
    await panel.getByTestId('agent-lab-send').click()
    await expect(panel.getByTestId('agent-lab-error')).toBeVisible()
    await expect(panel.locator('[data-testid="agent-lab-bubble"][data-role="agent"]')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------- AC-T92-02
const COMPOSED = {
  name: 'Agente Escola Sol',
  role: 'Atendente comercial',
  purpose: 'Vender os cursos da Escola Sol.',
  audience: 'Adultos interessados em cursos de idiomas.',
  personality: 'casual',
  primary_goal: 'sell',
  example_messages: 'Oi! Quer conhecer nossos cursos?',
  business_rules: 'Não dar desconto acima de 10%.',
  never_talk_about: 'Política.',
}

test.describe('T92 — criação assistida', () => {
  test('AC-T92-02 estágios chegam pelo SSE (polling bloqueado), avisos aparecem e o agente abre com o banner de revisão', async ({ page }) => {
    await ownerWithCredits(page)
    await aiKey(page, 'openai')
    await llmScript(page, [{ kind: 'output', value: COMPOSED, usage: { inputTokens: 300, outputTokens: 200 } }])

    // Bloqueia o polling de GET /api/ai-agents/runs/:id: só o SSE pode levar o run ao fim.
    let polled = 0
    await page.route(/\/api\/ai-agents\/runs\/(?!estimate)[^/?]+(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      polled++
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BLOCKED', message: 'polling bloqueado no teste' } }) })
    })

    await page.goto('/agentes')
    await expect(page.getByTestId('page-agents')).toBeVisible()
    await page.getByTestId('agent-lab-assisted-open').click()
    const dialog = page.getByTestId('agent-lab-assisted-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('agent-lab-assisted-pitch').fill('Escola Sol: cursos de idiomas para adultos, aulas online e presenciais.')
    await dialog.getByTestId('agent-lab-assisted-site').fill('https://escola-sol.example')
    await dialog.getByTestId('agent-lab-assisted-estimate-btn').click()
    await expect(dialog.getByTestId('agent-lab-assisted-estimate')).toHaveAttribute('data-enough', 'true')
    await dialog.getByTestId('agent-lab-assisted-start').click()

    const run = dialog.getByTestId('agent-lab-assisted-run')
    await expect(run).toBeVisible()
    await expect(run).toHaveAttribute('data-status', 'completed')
    for (const s of ['extract', 'compose', 'persist']) await expect(dialog.getByTestId(`agent-lab-assisted-stage-${s}`)).toHaveAttribute('data-state', 'done')
    await expect(dialog.getByTestId('agent-lab-assisted-warning-site_unread')).toBeVisible()

    // abre o agente criado com o banner "revise antes de publicar"
    await expect(page).toHaveURL(/\/agentes\/[0-9a-f-]{36}(\?.*)?$/)
    const agentId = new URL(page.url()).pathname.split('/').pop()!
    await expect(page.getByTestId('agent-editor')).toBeVisible()
    const banner = page.getByTestId('agent-lab-review-banner')
    await expect(banner).toBeVisible()
    await expect(banner.getByTestId('agent-lab-review-warning-site_unread')).toBeVisible()
    expect(new URL(page.url()).search).toBe('')
    const created = (await api(page, 'get', `/api/ai-agents/${agentId}`)).agent
    expect(created.name).toBe(COMPOSED.name)
    expect(created.status).toBe('draft')
    test.info().annotations.push({ type: 'polling bloqueado', description: String(polled) })

    // "Entendi" tira o banner sem mudar a URL
    await banner.getByTestId('agent-lab-review-dismiss').click()
    await expect(page.getByTestId('agent-lab-review-banner')).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/agentes/${agentId}$`))
  })

  test('AC-T92-02 caminho normal (SSE + polling) mostra estágios concluídos e o banner', async ({ page }) => {
    await ownerWithCredits(page)
    await aiKey(page, 'openai')
    await llmScript(page, [{ kind: 'output', value: { ...COMPOSED, name: 'Agente Padaria' } }])
    await page.goto('/agentes')
    await page.getByTestId('agent-lab-assisted-open').click()
    const dialog = page.getByTestId('agent-lab-assisted-dialog')
    await dialog.getByTestId('agent-lab-assisted-pitch').fill('Padaria artesanal com entregas no bairro todas as manhãs.')
    await dialog.getByTestId('agent-lab-assisted-start').click()
    await expect(dialog.getByTestId('agent-lab-assisted-stage-persist')).toHaveAttribute('data-state', 'done')
    await expect(page).toHaveURL(/\/agentes\/[0-9a-f-]{36}$/)
    await expect(page.getByTestId('agent-lab-review-banner')).toBeVisible()
    await expect(page.getByTestId('agent-name')).toHaveValue('Agente Padaria')
  })

  test('AC-T92-02 sem saldo a estimativa bloqueia a criação', async ({ page }) => {
    await loginAs(page, 'owner')
    await aiKey(page, 'openai')
    await page.goto('/agentes')
    await page.getByTestId('agent-lab-assisted-open').click()
    const dialog = page.getByTestId('agent-lab-assisted-dialog')
    await dialog.getByTestId('agent-lab-assisted-pitch').fill('Loja de roupas com atendimento pelo WhatsApp.')
    await dialog.getByTestId('agent-lab-assisted-estimate-btn').click()
    await expect(dialog.getByTestId('agent-lab-assisted-estimate')).toHaveAttribute('data-enough', 'false')
    await expect(dialog.getByTestId('agent-lab-assisted-insufficient')).toBeVisible()
    await expect(dialog.getByTestId('agent-lab-assisted-start')).toBeDisabled()
  })
})

// ---------------------------------------------------------------- AC-T92-03
test.describe('T92 — vozes', () => {
  test('AC-T92-03 envia amostras, ouve a prévia, mantém e exclui a voz', async ({ page }) => {
    await ownerWithCredits(page)
    await aiKey(page, 'elevenlabs')
    await openVoicesTab(page)
    await expect(voiceRows(page)).toHaveCount(0)

    await page.getByTestId('agent-voices-new').click()
    const form = page.getByTestId('agent-voices-form')
    const name = `Voz ${uniq()}`
    await form.getByTestId('agent-voices-name').fill(name)
    await form.getByTestId('agent-voices-language').selectOption('pt')
    await form.getByTestId('agent-voices-files').setInputFiles([mp3('amostra-1.mp3'), wav('amostra-2.wav')])
    await expect(form.getByTestId('agent-voices-sample-0')).toContainText('amostra-1.mp3')
    await expect(form.getByTestId('agent-voices-sample-1')).toContainText('amostra-2.wav')
    await form.getByTestId('agent-voices-submit').click()
    await expect(page.getByTestId('agent-voices-form')).toHaveCount(0)

    await expect(voiceRows(page)).toHaveCount(1)
    const voices = (await api(page, 'get', '/api/ai-voices')).items
    const voice = (voices as Any[]).find((v) => v.name === name)
    expect(voice, JSON.stringify(voices)).toBeTruthy()
    expect(voice.samples_count).toBe(2)
    const row = page.getByTestId(`agents-voice-${voice.id}`)
    await expect(row).toHaveAttribute('data-status', 'pending')

    // prévia: áudio carregado no <audio> com controles
    const previewRes = page.waitForResponse((r) => r.url().includes(`/api/ai-voices/${voice.id}/preview`))
    await page.getByTestId(`agent-voices-preview-${voice.id}`).click()
    const pr = await previewRes
    expect(pr.status()).toBe(200)
    expect(pr.headers()['content-type']).toMatch(/^audio\//)
    const audio = page.getByTestId(`agent-voices-audio-${voice.id}`)
    await expect(audio).toBeVisible()
    await expect(audio).toHaveAttribute('src', /^blob:/)

    // manter
    await page.getByTestId(`agent-voices-keep-${voice.id}`).click()
    await expect(row).toHaveAttribute('data-status', 'kept')
    await expect(page.getByTestId(`agent-voices-keep-${voice.id}`)).toHaveCount(0)

    // excluir (diálogo com aviso) → some da lista
    await page.getByTestId(`agent-voices-delete-${voice.id}`).click()
    const dlg = page.getByTestId('agent-voices-delete-dialog')
    await expect(dlg).toBeVisible()
    await expect(dlg.getByTestId('agent-voices-delete-warning')).toBeVisible()
    await dlg.getByTestId('agent-voices-delete-confirm').click()
    await expect(page.getByTestId(`agents-voice-${voice.id}`)).toHaveCount(0)
    await expect(page.getByTestId('agent-voices-deleted')).toBeVisible()
  })

  test('AC-T92-03 descartar voz em uso avisa os agentes afetados', async ({ page }) => {
    await ownerWithCredits(page)
    await aiKey(page, 'elevenlabs')
    await openVoicesTab(page)
    await page.getByTestId('agent-voices-new').click()
    const form = page.getByTestId('agent-voices-form')
    const name = `Voz ${uniq()}`
    await form.getByTestId('agent-voices-name').fill(name)
    await form.getByTestId('agent-voices-language').selectOption('es')
    await form.getByTestId('agent-voices-files').setInputFiles([mp3('a.mp3')])
    await form.getByTestId('agent-voices-submit').click()
    await expect(voiceRows(page)).toHaveCount(1)
    const list = await api(page, 'get', '/api/ai-voices')
    const voice = (list.items as Any[]).find((v) => v.name === name)
    expect(voice.language).toBe('es')

    const agent = (await api(page, 'post', '/api/ai-agents', { name: `Com voz ${uniq()}` })).agent
    await api(page, 'patch', `/api/ai-agents/${agent.id}`, { settings: { audio_voice: voice.provider_voice_id } })

    await page.getByTestId(`agent-voices-delete-${voice.id}`).click()
    await page.getByTestId('agent-voices-delete-dialog').getByTestId('agent-voices-delete-confirm').click()
    const toast = page.getByTestId('agent-voices-removed-from-agents')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText(agent.name)
    await expect(page.getByTestId(`agents-voice-${voice.id}`)).toHaveCount(0)
  })

  test('AC-T92-03 mais de 3 amostras é recusado na hora (máx. 3 anexadas)', async ({ page }) => {
    await loginAs(page, 'owner')
    await aiKey(page, 'elevenlabs')
    await openVoicesTab(page)
    await page.getByTestId('agent-voices-new').click()
    const form = page.getByTestId('agent-voices-form')
    await form.getByTestId('agent-voices-files').setInputFiles([mp3('1.mp3'), mp3('2.mp3'), mp3('3.mp3'), mp3('4.mp3')])
    await expect(form.getByTestId('agent-voices-error')).toBeVisible()
    await expect(form.locator('[data-testid^="agent-voices-sample-"]:not([data-testid*="remove"])')).toHaveCount(3)
  })
})

// ---------------------------------------------------------------- AC-T92-04
test.describe('T92 — ditado', () => {
  test('AC-T92-04 ditado nas instruções insere a transcrição do FakeStt e deixa o agente para salvar', async ({ page }) => {
    await ownerWithCredits(page)
    const agent = (await api(page, 'post', '/api/ai-agents', { name: `Ditado ${uniq()}`, purpose: 'Atender clientes.' })).agent
    await openEditor(page, agent.id)
    await page.getByTestId('agent-tab-instructions').filter({ visible: true }).first().click()
    const purpose = page.getByTestId('agent-purpose')
    await expect(purpose).toBeVisible()
    const before = await purpose.inputValue()
    await expect(page.getByTestId('agent-save')).toBeDisabled()

    const tr = page.waitForResponse((r) => r.url().includes('/api/ai-agents/transcriptions') && r.request().method() === 'POST')
    await page
      .getByTestId('agent-lab-dictate-purpose-file')
      .setInputFiles({ name: 'ditado.webm', mimeType: 'audio/webm', buffer: Buffer.from('fake webm audio '.repeat(32)) })
    const res = await tr
    expect(res.status()).toBe(200)
    expect((await res.json()).text).toBe(STT_TEXT)
    await expect(purpose).toHaveValue(before ? `${before} ${STT_TEXT}` : STT_TEXT)
    await expect(page.getByTestId('agent-save')).toBeEnabled()

    // salvar persiste o texto ditado
    await page.getByTestId('agent-save').click()
    await expect(page.getByTestId('agent-save')).toBeDisabled()
    const saved = (await api(page, 'get', `/api/ai-agents/${agent.id}`)).agent
    expect(JSON.stringify(saved)).toContain(STT_TEXT)
  })

  test('AC-T92-04 ditado também funciona em outro campo das instruções (regras do negócio)', async ({ page }) => {
    await ownerWithCredits(page)
    const agent = (await api(page, 'post', '/api/ai-agents', { name: `Ditado ${uniq()}` })).agent
    await openEditor(page, agent.id)
    await page.getByTestId('agent-tab-instructions').filter({ visible: true }).first().click()
    await page
      .getByTestId('agent-lab-dictate-business-rules-file')
      .setInputFiles({ name: 'regra.webm', mimeType: 'audio/webm', buffer: Buffer.from('fake '.repeat(64)) })
    await expect(page.getByTestId('agent-business-rules')).toHaveValue(new RegExp(STT_TEXT.replace(/\./g, '\\.')))
  })
})
