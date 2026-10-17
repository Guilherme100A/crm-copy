// AC-T57-01/02 — editores de nó de lógica: Condição (regras all/any, as seis categorias do T41 e operadores coerentes
// com o tipo), Distribuidor (quantidade por saída, ids estáveis) e Intervalo Inteligente (tempo/data/semanal com
// validação de dias e horários). Salvar é bloqueado no editor enquanto há erro (ne-status=blocked, nada no servidor).
import { expect, test } from '@playwright/test'
import { loginAs, resetSeed } from '../helpers/e2e'
import { api, bundle, enabledOptionValues, offeredOperators, expectStatus, flowWithNode, openNode, optionValues, pollConfig, savedNode, uniq, waitSaved } from './support'

test.beforeEach(async ({ request }) => {
  await resetSeed(request)
})

const TEXT_OPS = ['equal', 'different', 'contains', 'not_contains', 'starts_with', 'has_value', 'type']
const NUMERIC_OPS = ['greater_than', 'less_than', 'greater_or_equal', 'less_or_equal', 'numeric_equal']

test.describe('T57 — Condição', () => {
  test('AC-T57-01 as seis categorias do T41 e, em cada uma, só os operadores coerentes com o tipo', async ({ page }) => {
    await loginAs(page, 'owner')
    await api(page, 'post', '/api/global-variables', { name: 'g_idade', type: 'number', value: '30' })
    await api(page, 'post', '/api/global-variables', { name: 'g_loja', type: 'text', value: 'Centro' })
    const team = ((await api(page, 'get', '/api/team')).items as any[]).map((m) => m.user_id as string)
    expect(team.length).toBeGreaterThan(0)

    const f = await flowWithNode(page, 'condition')
    const panel = await openNode(page, f.id)
    await expect(panel.getByTestId('ne-condition')).toBeVisible()
    const category = panel.getByTestId('ne-cond-0-category')
    const op = panel.getByTestId('ne-cond-0-operator')
    expect(await optionValues(category)).toEqual(['system', 'attendance', 'attendant', 'field', 'custom_field', 'global_variable'])
    expect(await optionValues(panel.getByTestId('ne-cond-rule-type'))).toEqual(['all', 'any'])

    // campo do contato: texto
    await expect(category).toHaveValue('field')
    expect(await optionValues(panel.getByTestId('ne-cond-0-field'))).toEqual(['name', 'phone', 'email'])
    expect(await offeredOperators(op)).toEqual(TEXT_OPS)

    // sistema: etiqueta / dia / hora / data / janela
    await category.selectOption('system')
    const subtype = panel.getByTestId('ne-cond-0-subtype')
    expect(await optionValues(subtype)).toEqual(['tag', 'weekday', 'time', 'date', 'message_window'])
    await expect(subtype).toHaveValue('tag')
    expect(await offeredOperators(op)).toEqual(['equal', 'different'])
    await expect(panel.getByTestId('ne-cond-0-tag')).toBeVisible()
    await subtype.selectOption('weekday')
    expect(await offeredOperators(op)).toEqual(['equal', 'different'])
    expect(await optionValues(panel.getByTestId('ne-cond-0-weekday'))).toHaveLength(7)
    await subtype.selectOption('time')
    expect(await offeredOperators(op)).toEqual(['equal', 'before', 'after'])
    expect(await optionValues(panel.getByTestId('ne-cond-0-time'))).toHaveLength(24)
    await subtype.selectOption('date')
    expect(await offeredOperators(op)).toEqual(['equal', 'different', 'before', 'after'])
    await expect(panel.getByTestId('ne-cond-0-date')).toHaveAttribute('type', 'date')
    await subtype.selectOption('message_window')
    await expect(op).toHaveCount(0)
    await expect(panel.getByTestId('ne-cond-0-window')).toBeVisible()

    // atendimento e atendente: igual / diferente
    await category.selectOption('attendance')
    expect(await offeredOperators(op)).toEqual(['equal', 'different'])
    expect(await optionValues(panel.getByTestId('ne-cond-0-attendance'))).toEqual(['waiting', 'in_progress', 'resolved'])
    await category.selectOption('attendant')
    expect(await offeredOperators(op)).toEqual(['equal', 'different'])
    for (const id of team) await expect(panel.getByTestId(`ne-cond-0-attendant-${id}`)).toBeVisible()

    // variável global: os operadores seguem o tipo cadastrado
    await category.selectOption('global_variable')
    await panel.getByTestId('ne-cond-0-field').fill('g_idade')
    await expect.poll(() => offeredOperators(op)).toEqual([...NUMERIC_OPS, 'has_value'])
    await panel.getByTestId('ne-cond-0-field').fill('g_loja')
    await expect.poll(() => offeredOperators(op)).toEqual(TEXT_OPS)

    // campo personalizado (sem tipo): texto e números
    await category.selectOption('custom_field')
    expect(await offeredOperators(op)).toEqual([...TEXT_OPS, ...NUMERIC_OPS])
  })

  test('AC-T57-01 monta regras "any" com etiqueta, campo numérico e atendimento; valor não numérico bloqueia salvar', async ({ page }) => {
    await loginAs(page, 'owner')
    const label = (await api(page, 'post', '/api/labels', { name: `VIP ${uniq()}`, color: '#22c55e' })).label
    const f = await flowWithNode(page, 'condition')
    const panel = await openNode(page, f.id)

    await panel.getByTestId('ne-cond-rule-type').selectOption('any')
    // regra 1: etiqueta da lista (grava nome + id)
    await panel.getByTestId('ne-cond-0-category').selectOption('system')
    await panel.getByTestId('ne-cond-0-tag').fill(label.name)
    await expectStatus(panel, 'saved')

    // regra 2: campo personalizado numérico
    await panel.getByTestId('ne-cond-add').click()
    await expect(panel.getByTestId('ne-cond-1')).toBeVisible()
    await panel.getByTestId('ne-cond-1-category').selectOption('custom_field')
    await panel.getByTestId('ne-cond-1-field').fill('idade')
    await panel.getByTestId('ne-cond-1-operator').selectOption('greater_than')
    await panel.getByTestId('ne-cond-1-value').fill('abc')
    await expect(panel.getByTestId('ne-error-conditions.1.value')).toBeVisible()
    await expectStatus(panel, 'blocked')
    await waitSaved(page)
    // bloqueado: o servidor continua com a última versão válida (só a etiqueta)
    const blocked = (await bundle(page, f.id)).nodes.find((n: any) => n.id === 'n1').actions[0].config
    expect(blocked.conditions).toHaveLength(1)
    await panel.getByTestId('ne-cond-1-value').fill('18')
    await expect(panel.getByTestId('ne-error-conditions.1.value')).toHaveCount(0)
    await expectStatus(panel, 'saved')

    // regra 3: atendimento diferente de resolvido
    await panel.getByTestId('ne-cond-add').click()
    await panel.getByTestId('ne-cond-2-category').selectOption('attendance')
    await panel.getByTestId('ne-cond-2-attendance').selectOption('resolved')
    await panel.getByTestId('ne-cond-2-operator').selectOption('different')
    await expectStatus(panel, 'saved')
    await expect(panel.getByTestId('ne-output-success')).toBeVisible()
    await expect(panel.getByTestId('ne-output-failure')).toBeVisible()

    await pollConfig(page, f.id, 'evaluate_condition').toMatchObject({
      ruleType: 'any',
      conditions: [
        { category: 'system', systemSubtype: 'tag', operator: 'equal', tagName: label.name, tagId: label.id },
        { category: 'custom_field', fieldName: 'idade', operator: 'greater_than' },
        { category: 'attendance', attendanceStatus: 'resolved', operator: 'different' },
      ],
    })
    const saved = (await savedNode(page, f.id)).actions[0].config
    expect(String(saved.conditions[1].value)).toBe('18')

    // recarregar mostra o que foi salvo
    await page.reload()
    const again = await openNode(page, f.id)
    await expect(again.getByTestId('ne-cond-rule-type')).toHaveValue('any')
    await expect(again.getByTestId('ne-cond-1-operator')).toHaveValue('greater_than')
    await expect(again.getByTestId('ne-cond-2-attendance')).toHaveValue('resolved')
  })

  test('AC-T57-01 operador incoerente com o tipo (etiqueta "contém") aparece como erro e bloqueia', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await flowWithNode(page, 'condition', [
      {
        id: 'a1',
        type: 'evaluate_condition',
        order: 0,
        config: { ruleType: 'all', conditions: [{ category: 'system', systemSubtype: 'tag', tagName: 'VIP', operator: 'contains' }] },
      },
    ])
    const panel = await openNode(page, f.id)
    await expect(panel.getByTestId('ne-error-conditions.0.operator')).toBeVisible()
    await expectStatus(panel, 'blocked')
    expect(await enabledOptionValues(panel.getByTestId('ne-cond-0-operator'))).toEqual(expect.arrayContaining(['equal', 'different']))
    await panel.getByTestId('ne-cond-0-operator').selectOption('different')
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'evaluate_condition').toMatchObject({ conditions: [{ operator: 'different', tagName: 'VIP' }] })
  })
})

test.describe('T57 — Distribuidor', () => {
  test('AC-T57-02 quantidade por saída muda a fatia; saída nova tem id estável; quantidade negativa bloqueia', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await flowWithNode(page, 'distributor')
    const panel = await openNode(page, f.id)
    await expect(panel.getByTestId('ne-distributor')).toBeVisible()
    const rows = panel.locator('[data-testid^="ne-dist-row-"]')
    await expect(rows).toHaveCount(2)
    // nó novo: o padrão (2 saídas) já é válido e é gravado
    await expectStatus(panel, 'saved')
    const ids = (await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice('ne-dist-row-'.length)))) as string[]
    for (const id of ids) expect(id).toMatch(/^[a-z]_[a-z0-9]+$/)
    const [a, b] = ids as [string, string]
    await expect(panel.getByTestId(`ne-dist-share-${a}`)).toHaveText('50%')

    await panel.getByTestId(`ne-dist-qty-${a}`).fill('3')
    await expect(panel.getByTestId(`ne-dist-share-${a}`)).toHaveText('75%')
    await expect(panel.getByTestId(`ne-dist-share-${b}`)).toHaveText('25%')
    await panel.getByTestId(`ne-dist-output-${b}`).fill('Equipe B')

    await panel.getByTestId('ne-dist-add').click()
    await expect(rows).toHaveCount(3)
    const c = ((await rows.nth(2).getAttribute('data-testid')) ?? '').slice('ne-dist-row-'.length)
    expect([a, b]).not.toContain(c)
    await panel.getByTestId(`ne-dist-qty-${c}`).fill('0')
    await expect(panel.getByTestId(`ne-dist-share-${c}`)).toHaveText('0%')
    await expect(panel.getByTestId(`ne-output-output:${c}`)).toBeVisible()

    await panel.getByTestId(`ne-dist-qty-${b}`).fill('-1')
    await expectStatus(panel, 'blocked')
    await expect(panel.getByTestId('ne-error-outputs.1.quantity')).toBeVisible()
    await panel.getByTestId(`ne-dist-qty-${b}`).fill('1')
    await expectStatus(panel, 'saved')
    await panel.getByTestId('ne-dist-prevent-repetition').check()

    await pollConfig(page, f.id, 'distribute_contacts').toMatchObject({
      outputs: [
        { id: a, quantity: 3 },
        { id: b, name: 'Equipe B', quantity: 1 },
        { id: c, quantity: 0 },
      ],
      prevent_repetition: true,
    })
  })

  test('AC-T57-02 remover uma saída não desliga a aresta de outra (id do handle não deriva do índice)', async ({ page }) => {
    await loginAs(page, 'owner')
    const config = { outputs: [{ id: 'o_aaa111', name: 'A', quantity: 1 }, { id: 'o_bbb222', name: 'B', quantity: 2 }, { id: 'o_ccc333', name: 'C', quantity: 1 }] }
    const f = await flowWithNode(page, 'distributor', [{ id: 'a1', type: 'distribute_contacts', order: 0, config }], 'n1', {
      nodes: [{ id: 'm1', type: 'message', name: 'Msg', position: { x: 700, y: 0 }, actions: [{ id: 'm1-a1', type: 'send_message', order: 0, config: { message_text: 'Olá' } }] }],
      edges: [{ id: 'e2', from: 'n1', handle: 'output:o_bbb222', to: 'm1' }],
    })
    const panel = await openNode(page, f.id)
    await panel.getByTestId('ne-dist-remove-o_aaa111').click()
    await expect(panel.getByTestId('ne-dist-row-o_aaa111')).toHaveCount(0)
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'distribute_contacts').toMatchObject({ outputs: [{ id: 'o_bbb222' }, { id: 'o_ccc333' }] })
    const def = await bundle(page, f.id)
    expect(def.edges.filter((e: any) => e.from === 'n1').map((e: any) => [e.handle, e.to])).toEqual([['output:o_bbb222', 'm1']])
    // com 2 saídas, remover fica desabilitado (mínimo do schema)
    await expect(panel.getByTestId('ne-dist-remove-o_bbb222')).toBeDisabled()
  })
})

test.describe('T57 — Intervalo inteligente', () => {
  test('AC-T57-02 semanal: fim antes do início e nenhum dia ativo bloqueiam; faixas válidas são gravadas', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await flowWithNode(page, 'smart_interval')
    const panel = await openNode(page, f.id)
    await expect(panel.getByTestId('ne-interval')).toBeVisible()
    await expectStatus(panel, 'saved') // padrão: 1 hora
    await pollConfig(page, f.id, 'smart_interval').toMatchObject({ schedule_type: 'time', interval_value: 1, interval_unit: 'hours' })

    await panel.getByTestId('ne-interval-type').selectOption('weekly')
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    for (const d of days) await expect(panel.getByTestId(`ne-interval-day-${d}-enabled`)).toBeVisible()
    await expectStatus(panel, 'saved')

    // segunda: fim antes do início
    await panel.getByTestId('ne-interval-day-monday-start').fill('10:00')
    await panel.getByTestId('ne-interval-day-monday-end').fill('09:00')
    await expect(panel.locator('[data-testid^="ne-error-weekly_schedule.monday"]')).toBeVisible()
    await expectStatus(panel, 'blocked')
    await panel.getByTestId('ne-interval-day-monday-end').fill('12:30')
    await expect(panel.locator('[data-testid^="ne-error-weekly_schedule.monday"]')).toHaveCount(0)
    await expectStatus(panel, 'saved')

    // nenhum dia ativo
    for (const d of days) await panel.getByTestId(`ne-interval-day-${d}-enabled`).setChecked(false)
    await expect(panel.getByTestId('ne-error-weekly_schedule')).toBeVisible()
    await expectStatus(panel, 'blocked')
    // dia desligado não edita horário
    await expect(panel.getByTestId('ne-interval-day-saturday-start')).toBeDisabled()
    await panel.getByTestId('ne-interval-day-monday-enabled').check()
    await panel.getByTestId('ne-interval-day-saturday-enabled').check()
    await panel.getByTestId('ne-interval-day-saturday-start').fill('09:00')
    await panel.getByTestId('ne-interval-day-saturday-end').fill('13:00')
    await expectStatus(panel, 'saved')

    await pollConfig(page, f.id, 'smart_interval').toMatchObject({
      schedule_type: 'weekly',
      weekly_schedule: {
        monday: { enabled: true, start_time: '10:00', end_time: '12:30' },
        tuesday: { enabled: false },
        saturday: { enabled: true, start_time: '09:00', end_time: '13:00' },
        sunday: { enabled: false },
      },
    })
  })

  test('AC-T57-02 por tempo: acima de 31 dias e zero bloqueiam; por data exige a data', async ({ page }) => {
    await loginAs(page, 'owner')
    const f = await flowWithNode(page, 'smart_interval')
    const panel = await openNode(page, f.id)
    await expectStatus(panel, 'saved')
    await panel.getByTestId('ne-interval-unit').selectOption('days')
    await panel.getByTestId('ne-interval-value').fill('32')
    await expect(panel.getByTestId('ne-error-interval_value')).toBeVisible()
    await expectStatus(panel, 'blocked')
    await panel.getByTestId('ne-interval-value').fill('0')
    await expectStatus(panel, 'blocked')
    await panel.getByTestId('ne-interval-value').fill('31')
    await expectStatus(panel, 'saved')
    await pollConfig(page, f.id, 'smart_interval').toMatchObject({ schedule_type: 'time', interval_value: 31, interval_unit: 'days' })

    await panel.getByTestId('ne-interval-type').selectOption('date')
    await expect(panel.getByTestId('ne-error-scheduled_date')).toBeVisible()
    await expectStatus(panel, 'blocked')
    await panel.getByTestId('ne-interval-date').fill('2099-12-24T09:30')
    await expectStatus(panel, 'saved')
    await expect(panel.getByTestId('ne-interval-date-past')).toHaveCount(0)
    await pollConfig(page, f.id, 'smart_interval').toMatchObject({ schedule_type: 'date', scheduled_date: expect.stringMatching(/^2099-12-24T09:30/) })
  })
})
