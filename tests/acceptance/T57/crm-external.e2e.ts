// AC-T57-03/04 — editores de nó de CRM (etiquetas, departamento, Kanban, agente de IA: listas reais da API, 403 → aviso)
// e externos (HTTP: método, URL com variável, headers, corpo, mapeamento; IA: provedor/modelo de model-options, chave
// BYOK, saídas condicionais). Nunca chama provedor de IA nem a URL do nó (o teste confere que nenhuma requisição sai).
import { expect, test, type Page } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { api, expectStatus, flowWithNode, openNode, optionValues, pollConfig, uniq } from './support'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

test.describe('T57 — nós de CRM', () => {
  test('AC-T57-03 etiquetas: lista real de /api/labels, grava NOMES (inclui nome novo) e alterna adicionar/remover', async ({ page }) => {
    await loginAs(page, 'owner')
    const a = (await api(page, 'post', '/api/labels', { name: `Cliente ${uniq()}`, color: '#22c55e' })).label
    const b = (await api(page, 'post', '/api/labels', { name: `Lead ${uniq()}`, color: '#ef4444' })).label
    const all = (await api(page, 'get', '/api/labels')).items as any[]
    const f = await flowWithNode(page, 'tags')
    const panel = await openNode(page, f.id)
    const select = panel.getByTestId('ne-tags-select')
    await expect(panel.getByTestId(`ne-tags-option-${a.id}`)).toBeAttached()
    await expect(panel.getByTestId(`ne-tags-option-${b.id}`)).toBeAttached()
    expect((await optionValues(select)).sort()).toEqual(all.map((l) => l.name).sort())

    await expectStatus(panel, 'blocked') // nenhuma etiqueta ainda
    await select.selectOption(a.name)
    await expect(panel.getByTestId(`ne-tags-chip-${a.name}`)).toBeVisible()
    await panel.getByTestId('ne-tags-new').fill('Recompra')
    await panel.getByTestId('ne-tags-new-add').click()
    await expect(panel.getByTestId('ne-tags-chip-Recompra-new')).toBeVisible()
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'add_tags').toMatchObject({ tags: [a.name, 'Recompra'] })

    await panel.getByTestId('ne-tags-mode').selectOption('remove_tags')
    await panel.getByTestId('ne-tags-remove-Recompra').click()
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'remove_tags').toMatchObject({ tags: [a.name] })
  })

  test('AC-T57-03 departamento, quadro/coluna e agente vêm da empresa; coluna‑meta pede valor', async ({ page }) => {
    await loginAs(page, 'owner')
    const dept = (await api(page, 'post', '/api/departments', { name: `Financeiro ${uniq()}`, color: '#3b82f6' })).department
    const crm = (await api(page, 'post', '/api/crms', { name: `Vendas ${uniq()}` })).crm
    await api(page, 'post', `/api/crms/${crm.id}/columns`, { name: 'Proposta', conversion_goal: false })
    const columns = (await api(page, 'get', `/api/crms/${crm.id}/columns`)).items as any[]
    const goal = columns.find((c) => c.conversion_goal)
    const plain = columns.find((c) => c.name === 'Proposta')
    expect(goal, 'quadro sem coluna‑meta').toBeTruthy()
    const agent = (await api(page, 'post', '/api/ai-agents', { name: `Agente ${uniq()}` })).agent

    // Departamento
    let f = await flowWithNode(page, 'department')
    let panel = await openNode(page, f.id)
    await expect(panel.getByTestId(`ne-dept-option-${dept.id}`)).toBeAttached()
    const depts = (await api(page, 'get', '/api/departments/all')).items as any[]
    expect((await optionValues(panel.getByTestId('ne-dept-select'))).sort()).toEqual(depts.map((d) => d.id).sort())
    await panel.getByTestId('ne-dept-select').selectOption(dept.id)
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'set_department').toMatchObject({ department_id: dept.id, department_name: dept.name })

    // Kanban: quadro → colunas do quadro; coluna comum sem valor, coluna‑meta com valor
    f = await flowWithNode(page, 'kanban')
    panel = await openNode(page, f.id)
    await expect(panel.getByTestId(`ne-kanban-board-option-${crm.id}`)).toBeAttached()
    await expect(panel.getByTestId('ne-kanban-column')).toBeDisabled()
    await panel.getByTestId('ne-kanban-board').selectOption(crm.id)
    await expect.poll(() => optionValues(panel.getByTestId('ne-kanban-column'))).toEqual(columns.map((c) => c.id))
    await expect(panel.getByTestId(`ne-kanban-column-option-${goal.id}`)).toContainText('meta')
    await panel.getByTestId('ne-kanban-column').selectOption(plain.id)
    await expect(panel.getByTestId('ne-kanban-value')).toHaveCount(0)
    await expectStatus(panel, 'saved')
    await panel.getByTestId('ne-kanban-column').selectOption(goal.id)
    await panel.getByTestId('ne-kanban-value').fill('199,90')
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'create_kanban_card').toMatchObject({ crm_id: crm.id, crm_column_id: goal.id, crm_column_conversion_goal: true, value: 199.9 })
    await panel.getByTestId('ne-kanban-mode').selectOption('remove_kanban_card')
    await expect(panel.getByTestId('ne-kanban-remove-notice')).toBeVisible()
    await pollConfig(page, f.id, 'remove_kanban_card').toMatchObject({ crm_id: crm.id })

    // Agente de IA
    f = await flowWithNode(page, 'ai_agent')
    panel = await openNode(page, f.id)
    await expect(panel.getByTestId(`ne-agent-option-${agent.id}`)).toBeAttached()
    const agents = (await api(page, 'get', '/api/ai-agents')).items as any[]
    expect((await optionValues(panel.getByTestId('ne-agent-select'))).sort()).toEqual(agents.map((x) => x.id).sort())
    await expectStatus(panel, 'blocked') // activate exige o agente
    await panel.getByTestId('ne-agent-select').selectOption(agent.id)
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'control_ai_agent').toMatchObject({ mode: 'activate', agent_id: agent.id })
    await panel.getByTestId('ne-agent-mode').selectOption('deactivate')
    await expect(panel.getByTestId('ne-agent-deactivate-notice')).toBeVisible()
    await pollConfig(page, f.id, 'control_ai_agent').toEqual({ mode: 'deactivate' })
  })

  test('AC-T57-03 lista sem permissão (403) mostra aviso e o editor continua utilizável', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.route('**/api/labels*', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden' } }) }))
    await page.route('**/api/departments/all*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found' } }) }))
    let f = await flowWithNode(page, 'tags')
    let panel = await openNode(page, f.id)
    await expect(panel.getByTestId('ne-list-denied-labels')).toBeVisible()
    await panel.getByTestId('ne-tags-new').fill('Manual')
    await panel.getByTestId('ne-tags-new-add').click()
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'add_tags').toMatchObject({ tags: ['Manual'] })

    f = await flowWithNode(page, 'department')
    panel = await openNode(page, f.id)
    await expect(panel.getByTestId('ne-list-denied-departments')).toBeVisible()
    await expect(panel.getByTestId('ne-dept-select')).toBeVisible()
  })
})

/** Falha o teste se o navegador tentar falar com host externo (URL do nó HTTP ou provedor de IA). */
function forbidExternal(page: Page) {
  const external: string[] = []
  page.on('request', (r) => {
    const host = new URL(r.url()).hostname
    if (!['127.0.0.1', 'localhost'].includes(host) && !r.url().startsWith('data:')) external.push(r.url())
  })
  return external
}

test.describe('T57 — nós externos', () => {
  test('AC-T57-04 HTTP: método, URL com variável, headers, corpo e mapeamento de resposta; linhas inválidas bloqueiam', async ({ page }) => {
    await loginAs(page, 'owner')
    const external = forbidExternal(page)
    const f = await flowWithNode(page, 'integration')
    const panel = await openNode(page, f.id)
    await expect(panel.getByTestId('ne-http')).toBeVisible()
    expect(await optionValues(panel.getByTestId('ne-http-method'))).toEqual(['GET', 'POST', 'PUT'])
    await panel.getByTestId('ne-http-method').selectOption('PUT')

    const url = panel.getByTestId('ne-http-url')
    await url.fill('ftp://api.exemplo.test/x')
    await expect(panel.getByTestId('ne-error-request_url')).toBeVisible()
    await expectStatus(panel, 'blocked')
    await url.fill('https://api.exemplo.test/leads?tel=')
    // insere a variável pelo seletor (no cursor, ao fim)
    await url.click()
    await url.press('End')
    const urlField = url.locator('xpath=..') // raiz do campo (rótulo + seletor de variável + input)
    await urlField.getByTestId('ne-var-picker').click()
    await urlField.getByTestId('ne-var-list').getByTestId('ne-var-phone_number').first().click() // pode vir no grupo contato e no de campos
    await expect(url).toHaveValue('https://api.exemplo.test/leads?tel={phone_number}')
    await expectStatus(panel, 'saved')

    // headers: nome repetido bloqueia
    await panel.getByTestId('ne-http-header-add').click()
    await panel.getByTestId('ne-http-header-0-key').fill('Authorization')
    await panel.getByTestId('ne-http-header-0-value').fill('Bearer {g_token}')
    await panel.getByTestId('ne-http-header-add').click()
    await panel.getByTestId('ne-http-header-1-key').fill('authorization')
    await panel.getByTestId('ne-http-header-1-value').fill('x')
    await expect(panel.getByTestId('ne-error-http-header-1-key')).toBeVisible()
    await expectStatus(panel, 'blocked')
    await panel.getByTestId('ne-http-header-1-key').fill('X-Origem')
    await expectStatus(panel, 'saved')

    await panel.getByTestId('ne-http-body').fill('{"telefone": "{phone_number}", "origem": "crm"}')
    await expect(panel.getByTestId('ne-http-body-warning')).toHaveCount(0)

    // mapeamento: caminho inválido bloqueia
    await panel.getByTestId('ne-http-map-add').click()
    await panel.getByTestId('ne-http-map-0-key').fill('status_pedido')
    await panel.getByTestId('ne-http-map-0-value').fill('data..status')
    await expect(panel.getByTestId('ne-error-http-map-0-value')).toBeVisible()
    await expectStatus(panel, 'blocked')
    await panel.getByTestId('ne-http-map-0-value').fill('data.status')
    await expectStatus(panel, 'saved')
    await expect(panel.getByTestId('ne-output-success')).toBeVisible()
    await expect(panel.getByTestId('ne-output-failure')).toBeVisible()

    await pollConfig(page, f.id, 'make_http_request').toMatchObject({
      request_method: 'PUT',
      request_url: 'https://api.exemplo.test/leads?tel={phone_number}',
      request_headers: { Authorization: 'Bearer {g_token}', 'X-Origem': 'x' },
      request_body: '{"telefone": "{phone_number}", "origem": "crm"}',
      response_mapping: { status_pedido: 'data.status' },
    })

    // GET não tem corpo
    await panel.getByTestId('ne-http-method').selectOption('GET')
    await expect(panel.getByTestId('ne-http-body')).toHaveCount(0)
    await expectStatus(panel, 'saved')
    await expect
      .poll(async () => {
        const node = (await api(page, 'get', `/api/flows/${f.id}/editor-bundle`)).definition.nodes.find((n: any) => n.id === 'n1')
        const c = node.actions[0].config
        return { method: c.request_method, body: 'request_body' in c }
      })
      .toEqual({ method: 'GET', body: false })
    expect(external, 'o editor não pode chamar a URL configurada').toEqual([])
  })

  test('AC-T57-04 IA: provedores e modelos de model-options (sem chave → desabilitado), modelo escolhido é gravado', async ({ page }) => {
    await loginAs(page, 'owner')
    const external = forbidExternal(page)
    // chave OpenAI da empresa (T38) → `openai` disponível; Google/OpenRouter seguem sem chave no harness
    await api(page, 'post', '/api/ai-keys', { provider: 'openai', name: `OpenAI ${uniq()}`, secret: `sk-fake-${uniq()}` })
    const opts = await api(page, 'get', '/api/ai-agents/model-options')
    const avail = new Map((opts.providers as any[]).map((p) => [p.provider, p.available]))
    const map: Record<string, string> = { gpt: 'openai', gemini: 'google', openrouter: 'openrouter', platform: 'openai' }

    const f = await flowWithNode(page, 'ai')
    const panel = await openNode(page, f.id)
    await expect(panel.getByTestId('ne-ai')).toBeVisible()
    const provider = panel.getByTestId('ne-ai-provider')
    expect(await optionValues(provider)).toEqual(['gpt', 'gemini', 'openrouter', 'platform'])
    const current = await provider.inputValue()
    for (const p of ['gpt', 'gemini', 'openrouter', 'platform']) {
      const opt = panel.getByTestId(`ne-ai-provider-${p}`)
      if (avail.get(map[p]!) === true || p === current) await expect(opt).not.toHaveAttribute('disabled')
      else {
        await expect(opt).toHaveAttribute('disabled')
        await expect(opt).toContainText('sem chave')
      }
    }
    // escolhe um provedor disponível do enum e um modelo do catálogo dele
    expect(avail.get('openai')).toBe(true)
    const usable = (['gpt', 'gemini', 'openrouter'] as const).find((p) => avail.get(map[p]!) === true)
    expect(usable).toBe('gpt')
    await provider.selectOption(usable!)
    const catalog = (opts.models as any[]).filter((m) => m.provider === map[usable!]).map((m) => m.model)
    expect(catalog.length).toBeGreaterThan(0)
    expect(await optionValues(panel.getByTestId('ne-ai-model'))).toEqual(catalog)
    await panel.getByTestId('ne-ai-model').selectOption(catalog[0])
    await panel.getByTestId('ne-ai-system-prompt').fill('Você é um assistente de vendas.')
    await panel.getByTestId('ne-ai-response-var').fill('resposta_ia')
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'ai_call').toMatchObject({ provider: usable, model: catalog[0], system_prompt: 'Você é um assistente de vendas.', response_variable: 'resposta_ia' })
    expect(external).toEqual([])
  })

  test('AC-T57-04 IA: provedor sem chave fica desabilitado e o atual mostra aviso (model-options controlado)', async ({ page }) => {
    await loginAs(page, 'owner')
    await page.route('**/api/ai-agents/model-options*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          providers: [
            { provider: 'openai', available: false },
            { provider: 'google', available: true },
            { provider: 'openrouter', available: false },
          ],
          models: [
            { provider: 'google', model: 'gemini-2.5-flash' },
            { provider: 'google', model: 'gemini-2.5-pro' },
            { provider: 'openai', model: 'gpt-4.1-mini' },
          ],
        }),
      }),
    )
    const f = await flowWithNode(page, 'ai', [{ id: 'a1', type: 'ai_call', order: 0, config: { provider: 'gpt', user_message: '{last_user_message}' } }])
    const panel = await openNode(page, f.id)
    await expect(panel.getByTestId('ne-ai-provider-unavailable')).toBeVisible()
    await expect(panel.getByTestId('ne-ai-provider-openrouter')).toHaveAttribute('disabled')
    await expect(panel.getByTestId('ne-ai-provider-platform')).toHaveAttribute('disabled')
    await expect(panel.getByTestId('ne-ai-provider-gemini')).not.toHaveAttribute('disabled')
    await panel.getByTestId('ne-ai-provider').selectOption('gemini')
    await expect(panel.getByTestId('ne-ai-provider-unavailable')).toHaveCount(0)
    expect(await optionValues(panel.getByTestId('ne-ai-model'))).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
    await panel.getByTestId('ne-ai-model').selectOption('gemini-2.5-pro')
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'ai_call').toMatchObject({ provider: 'gemini', model: 'gemini-2.5-pro' })
  })

  test('AC-T57-04 IA: chave BYOK de /api/ai-keys define o provedor; saídas condicionais com chave estável e saída padrão', async ({ page }) => {
    await loginAs(page, 'owner')
    const external = forbidExternal(page)
    const key = (await api(page, 'post', '/api/ai-keys', { provider: 'google', name: `Gemini ${uniq()}`, secret: 'AIza-teste-e2e-000000' })).key
    const f = await flowWithNode(page, 'ai')
    const panel = await openNode(page, f.id)

    await panel.getByTestId('ne-ai-key-source').selectOption('integration')
    await expect(panel.getByTestId(`ne-ai-key-option-${key.id}`)).toBeAttached()
    await panel.getByTestId('ne-ai-key').selectOption(key.id)
    await expect(panel.getByTestId('ne-ai-provider')).toHaveValue('gemini')
    await expect(panel.getByTestId('ne-ai-provider')).toBeDisabled()
    await expectStatus(panel, 'saved')

    // duas saídas condicionais
    await panel.getByTestId('ne-ai-output-add').click()
    await panel.getByTestId('ne-ai-output-add').click()
    const outs = panel.locator('[data-testid^="ne-ai-output-saida_"][data-testid$="-prompt"]')
    await expect(outs).toHaveCount(2)
    const keys = (await outs.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace(/^ne-ai-output-/, '').replace(/-prompt$/, '')))) as string[]
    for (const k of keys) expect(k).toMatch(/^saida_[a-z0-9]+$/)
    await expectStatus(panel, 'blocked') // prompts vazios
    await panel.getByTestId(`ne-ai-output-${keys[0]}-prompt`).fill('Cliente quer comprar')
    await panel.getByTestId(`ne-ai-output-${keys[1]}-prompt`).fill('Cliente quer suporte')
    await expectStatus(panel, 'saved')
    await expect(panel.getByTestId('ne-ai-fallback')).toContainText('outros')
    for (const h of [`output:${keys[0]}`, `output:${keys[1]}`, 'output:outros', 'failure']) await expect(panel.getByTestId(`ne-output-${h}`)).toBeVisible()

    await pollConfig(page, f.id, 'ai_call').toMatchObject({
      api_key_source: 'integration',
      ai_integration_id: key.id,
      provider: 'gemini',
      output_conditions: [
        { prompt: 'Cliente quer comprar', output_key: keys[0] },
        { prompt: 'Cliente quer suporte', output_key: keys[1] },
      ],
      fallback_output_key: 'outros',
    })

    // remover a 1ª não muda a chave da 2ª
    await panel.getByTestId(`ne-ai-output-${keys[0]}-remove`).click()
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'ai_call').toMatchObject({ output_conditions: [{ output_key: keys[1] }], fallback_output_key: 'outros' })
    expect(external).toEqual([])
  })

  test('AC-T57-04 IA: chave manual salva nunca aparece em texto', async ({ page }) => {
    await loginAs(page, 'owner')
    const secret = 'sk-segredo-e2e-123456'
    const f = await flowWithNode(page, 'ai', [
      { id: 'a1', type: 'ai_call', order: 0, config: { provider: 'gpt', api_key_source: 'manual', api_key: secret, user_message: '{last_user_message}' } },
    ])
    const panel = await openNode(page, f.id)
    const input = panel.getByTestId('ne-ai-manual-key')
    await expect(input).toHaveAttribute('type', 'password')
    await expect(input).toHaveValue('')
    expect(await page.content()).not.toContain(secret)
  })
})
