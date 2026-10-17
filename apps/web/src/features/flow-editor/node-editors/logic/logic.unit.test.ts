import { CONDITION_OPERATORS, nodeHandles, type FlowAction } from '@crm/shared/flows'
import { describe, expect, it } from 'vitest'
import { translate, LOCALES } from '@/i18n/core'
import { getNodeEditor } from '../registry'
import { nodeEditors as crmEditors } from '../crm'
import { nodeEditors as externalEditors } from '../external'
import { nodeEditors as logicEditors } from '.'
import {
  addDistOutput,
  ATTENDANCE_STATUSES,
  CONDITION_CATEGORIES,
  conditionLocalErrors,
  defaultCondition,
  defaultDistributor,
  defaultInterval,
  defaultRule,
  defaultWeekly,
  distOutputs,
  distShares,
  isPastLocal,
  NUMERIC_OPERATORS,
  operatorsFor,
  patchDay,
  patchDistOutput,
  REPLY_TYPES,
  removeDistOutput,
  SYSTEM_SUBTYPES,
  systemRule,
  TEXT_OPERATORS,
  valueKind,
  WEEKDAYS,
  withOperator,
  withScheduleType,
} from './logic-rules'
import { ensureAction, errorsUnder, hasVariable, insertVariable, issueError, numberOrTemplate, outputId, parseNumber, setField, validateActions, validateConfig } from './rules'

const seq = (...xs: number[]) => {
  let i = 0
  return () => xs[i++ % xs.length]!
}
const ruleOk = (rule: Record<string, unknown>, ruleType = 'all') => validateConfig('evaluate_condition', { ruleType, conditions: [rule] })

describe('registro dos editores da T57 (glob dos grupos)', () => {
  it('lógica, CRM e externos exportam `nodeEditors` e o registry os carrega', () => {
    expect(Object.keys(logicEditors).sort()).toEqual(['condition', 'connection_flow', 'distributor', 'smart_interval'])
    expect(Object.keys(crmEditors).sort()).toEqual(['ai_agent', 'chat_controller', 'department', 'kanban', 'manipulator', 'tags'])
    expect(Object.keys(externalEditors).sort()).toEqual(['ai', 'integration', 'pixel'])
    for (const type of [...Object.keys(logicEditors), ...Object.keys(crmEditors), ...Object.keys(externalEditors)]) expect(getNodeEditor(type), type).not.toBeNull()
    // Pagamento e Venda aprovada são da T114.
    expect(crmEditors).not.toHaveProperty('approved_sale')
    expect(externalEditors).not.toHaveProperty('payment')
  })

  it('nó novo (vazio) ganha a ação principal uma vez só', () => {
    const once = ensureAction([], ['evaluate_condition'], defaultCondition)
    expect(once).toHaveLength(1)
    expect(ensureAction(once, ['evaluate_condition'], defaultCondition)).toBe(once)
  })
})

describe('AC-T57-01 condição: regras all/any, todas as categorias de T41 e operadores coerentes com o tipo', () => {
  it('cada categoria/subtipo oferece só os operadores que o motor avalia', () => {
    expect(operatorsFor('system', 'tag')).toEqual(['equal', 'different'])
    expect(operatorsFor('system', 'weekday')).toEqual(['equal', 'different'])
    expect(operatorsFor('system', 'time')).toEqual(['equal', 'before', 'after'])
    expect(operatorsFor('system', 'date')).toEqual(['equal', 'different', 'before', 'after'])
    expect(operatorsFor('system', 'message_window')).toEqual(['open'])
    expect(operatorsFor('attendance')).toEqual(['equal', 'different'])
    expect(operatorsFor('attendant')).toEqual(['equal', 'different'])
    expect(operatorsFor('field')).toEqual(TEXT_OPERATORS)
    expect(operatorsFor('custom_field')).toEqual([...TEXT_OPERATORS, ...NUMERIC_OPERATORS])
    expect(operatorsFor('global_variable', undefined, 'number')).toEqual([...NUMERIC_OPERATORS, 'has_value'])
    expect(operatorsFor('global_variable', undefined, 'text')).toEqual(TEXT_OPERATORS)
    // Todo operador oferecido existe no schema do T10.
    for (const cat of CONDITION_CATEGORIES)
      for (const sub of [undefined, ...SYSTEM_SUBTYPES]) for (const op of operatorsFor(cat, sub)) expect(CONDITION_OPERATORS as readonly string[]).toContain(op)
  })

  it('o tipo da variável global decide os operadores (número × texto)', () => {
    const globals = [
      { name: 'g_pontos', type: 'number' },
      { name: 'g_plano', type: 'text' },
    ]
    expect(valueKind({ category: 'global_variable', fieldName: 'g_pontos' }, globals)).toBe('number')
    expect(valueKind({ category: 'global_variable', fieldName: 'plano' }, globals)).toBe('text')
    expect(valueKind({ category: 'global_variable', fieldName: 'outra' }, globals)).toBe('unknown')
    expect(valueKind({ category: 'field', fieldName: 'email' })).toBe('text')
  })

  it('monta uma regra válida de cada categoria e subtipo, em `all` e `any`', () => {
    const rules = [
      { ...systemRule('tag'), tagName: 'VIP' },
      { ...systemRule('weekday') },
      { ...systemRule('time') },
      { ...systemRule('date'), date: '2026-12-24' },
      systemRule('message_window'),
      ...ATTENDANCE_STATUSES.map((s) => ({ ...defaultRule('attendance'), attendanceStatus: s })),
      { ...defaultRule('attendant'), user_ids: ['u1'] },
      { ...defaultRule('field'), value: 'Ana' },
      { ...defaultRule('custom_field'), fieldName: 'plano', value: 'ouro' },
      { ...defaultRule('global_variable'), fieldName: 'g_pontos', operator: 'greater_than', value: '10,5' },
    ]
    for (const ruleType of ['all', 'any']) expect(validateConfig('evaluate_condition', { ruleType, conditions: rules }), ruleType).toEqual({})
  })

  it('campos obrigatórios por categoria vão para o caminho da regra', () => {
    expect(ruleOk({ ...systemRule('tag') })).toHaveProperty(['conditions.0.tagName'], { key: 'required' })
    expect(ruleOk({ ...systemRule('date') })).toHaveProperty(['conditions.0.date'])
    expect(ruleOk(defaultRule('attendant'))).toHaveProperty(['conditions.0.user_ids'], { key: 'attendant' })
    expect(ruleOk(defaultRule('custom_field'))).toHaveProperty(['conditions.0.fieldName'], { key: 'required' })
    expect(validateConfig('evaluate_condition', { ruleType: 'all', conditions: [] })).toHaveProperty('conditions', { key: 'minItems', vars: { min: 1 } })
  })

  it('operador incoerente, valor vazio e valor não numérico em operador numérico bloqueiam', () => {
    expect(ruleOk({ ...systemRule('tag'), tagName: 'x', operator: 'contains' })).toHaveProperty(['conditions.0.operator'], { key: 'operator' })
    expect(ruleOk({ category: 'field', fieldName: 'name', operator: 'greater_than', value: '1' })).toHaveProperty(['conditions.0.operator'], { key: 'operator' })
    expect(ruleOk({ category: 'field', fieldName: 'name', operator: 'equal', value: ' ' })).toHaveProperty(['conditions.0.value'], { key: 'required' })
    expect(ruleOk({ category: 'custom_field', fieldName: 'idade', operator: 'less_than', value: 'dez' })).toHaveProperty(['conditions.0.value'], { key: 'number' })
    // Variável e número com vírgula valem; `has_value` dispensa valor.
    expect(ruleOk({ category: 'custom_field', fieldName: 'idade', operator: 'less_than', value: '{g_limite}' })).toEqual({})
    expect(ruleOk({ category: 'custom_field', fieldName: 'idade', operator: 'less_or_equal', value: '1.234,5' })).toEqual({})
    expect(ruleOk({ category: 'custom_field', fieldName: 'idade', operator: 'has_value' })).toEqual({})
    expect(conditionLocalErrors({ conditions: [{ category: 'attendance', attendanceStatus: 'waiting', operator: 'different' }] })).toEqual({})
  })

  it('trocar operador ajusta o valor (sem valor em has_value; tipo da resposta começa em texto)', () => {
    const r = { category: 'custom_field', fieldName: 'x', operator: 'equal', value: 'a' }
    expect(withOperator(r, 'has_value')).not.toHaveProperty('value')
    expect(withOperator(r, 'type')).toMatchObject({ operator: 'type', value: 'text' })
    expect(REPLY_TYPES).toContain(withOperator(r, 'type').value)
    expect(withOperator({ ...r, operator: 'type', value: 'image' }, 'contains')).toMatchObject({ value: '' })
  })

  it('trocar a categoria ou o subtipo zera os campos do anterior', () => {
    expect(defaultRule('attendance')).toEqual({ category: 'attendance', attendanceStatus: 'waiting', operator: 'equal' })
    expect(systemRule('weekday')).toEqual({ category: 'system', systemSubtype: 'weekday', operator: 'equal', weekday: 'monday' })
    expect(systemRule('time')).toMatchObject({ operator: 'before', time: 12, timeMinute: 0 })
  })

  it('errorsUnder recorta os erros de uma regra', () => {
    expect(errorsUnder({ 'conditions.1.value': { key: 'required' }, 'conditions.10.x': { key: 'invalid' }, ruleType: { key: 'required' } }, 'conditions.1')).toEqual({ value: { key: 'required' } })
  })
})

describe('AC-T57-02 distribuidor: quantidades por saída com ids estáveis', () => {
  it('nasce com 2 saídas válidas e ids sem `:` nem espaço', () => {
    const c = defaultDistributor((n) => `Saída ${n}`, seq(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7))
    const outs = distOutputs(c)
    expect(outs).toHaveLength(2)
    for (const o of outs) expect(o.id).toMatch(/^o_[a-z0-9]{6}$/)
    expect(new Set(outs.map((o) => o.id)).size).toBe(2)
    expect(validateConfig('distribute_contacts', c)).toEqual({})
  })

  it('adicionar/remover/renomear não muda o id (e o handle) das outras saídas', () => {
    let c = defaultDistributor((n) => `S${n}`)
    const [a, b] = distOutputs(c).map((o) => o.id)
    c = addDistOutput(c, 'S3')
    const third = distOutputs(c)[2]!.id
    expect([a, b]).not.toContain(third)
    c = removeDistOutput(c, a!)
    c = patchDistOutput(c, b!, { name: 'Vendas', quantity: 3 })
    expect(distOutputs(c).map((o) => o.id)).toEqual([b, third])
    const node = { type: 'distributor', actions: [{ id: 'a1', type: 'distribute_contacts', order: 0, config: c }] as FlowAction[] }
    expect(nodeHandles(node)).toEqual([`output:${b}`, `output:${third}`])
  })

  it('quantidade inteira ≥ 0; menos de 2 saídas bloqueia', () => {
    let c = defaultDistributor((n) => `S${n}`)
    const [a] = distOutputs(c).map((o) => o.id)
    expect(validateConfig('distribute_contacts', patchDistOutput(c, a!, { quantity: -1 }))).toHaveProperty(['outputs.0.quantity'])
    expect(patchDistOutput(c, a!, { quantity: undefined }).outputs).toEqual([expect.not.objectContaining({ quantity: expect.anything() }), expect.anything()])
    c = removeDistOutput(c, a!)
    expect(validateConfig('distribute_contacts', c)).toHaveProperty('outputs', { key: 'minItems', vars: { min: 2 } })
  })

  it('a fatia em % segue o motor (ausente = 1, 0 = nunca, todas 0 = iguais)', () => {
    expect(distShares([{ id: 'a', quantity: 3 }, { id: 'b', quantity: 1 }])).toEqual({ a: 75, b: 25 })
    expect(distShares([{ id: 'a' }, { id: 'b', quantity: 0 }])).toEqual({ a: 100, b: 0 })
    expect(distShares([{ id: 'a', quantity: 0 }, { id: 'b', quantity: 0 }, { id: 'c', quantity: 0 }])).toEqual({ a: 33.3, b: 33.3, c: 33.3 })
  })

  it('outputId nunca repete um id já usado', () => {
    expect(outputId(['o_aaaaaa'], seq(0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5))).toBe('o_ssssss')
  })
})

describe('AC-T57-02 intervalo inteligente: valida horários e dias', () => {
  it('padrão (1 hora) é válido; mais de 31 dias bloqueia', () => {
    expect(validateConfig('smart_interval', defaultInterval())).toEqual({})
    expect(validateConfig('smart_interval', { schedule_type: 'time', interval_value: 32, interval_unit: 'days' })).toHaveProperty('interval_value', { key: 'maxWait' })
    expect(validateConfig('smart_interval', { schedule_type: 'time', interval_unit: 'days' })).toHaveProperty('interval_value', { key: 'required' })
    expect(validateConfig('smart_interval', { schedule_type: 'time', interval_value: 0 })).toHaveProperty('interval_value')
  })

  it('data marcada é obrigatória; data no passado só avisa', () => {
    expect(validateConfig('smart_interval', { schedule_type: 'date' })).toHaveProperty('scheduled_date', { key: 'required' })
    expect(validateConfig('smart_interval', { schedule_type: 'date', scheduled_date: '2026-10-20T09:30' })).toEqual({})
    const now = new Date(2026, 9, 16, 12, 0)
    expect(isPastLocal('2026-10-16T11:59', now)).toBe(true)
    expect(isPastLocal('2026-10-16T12:01', now)).toBe(false)
    expect(isPastLocal('', now)).toBe(false)
  })

  it('semanal: grade padrão válida, ≥ 1 dia ativo, fim depois do início e HH:MM', () => {
    let c = withScheduleType(defaultInterval(), 'weekly')
    expect(Object.keys(c.weekly_schedule as object)).toEqual([...WEEKDAYS])
    expect(validateConfig('smart_interval', c)).toEqual({})
    expect(defaultWeekly().saturday.enabled).toBe(false)
    c = patchDay(c, 'monday', { start_time: '18:00', end_time: '09:00' })
    expect(validateConfig('smart_interval', c)).toHaveProperty(['weekly_schedule.monday'], { key: 'endAfterStart' })
    c = patchDay(c, 'monday', { start_time: '25:00', end_time: '26:00' })
    expect(validateConfig('smart_interval', c)).toHaveProperty(['weekly_schedule.monday.start_time'], { key: 'format' })
    let off = withScheduleType(defaultInterval(), 'weekly')
    for (const d of WEEKDAYS) off = patchDay(off, d, { enabled: false })
    expect(validateConfig('smart_interval', off)).toHaveProperty('weekly_schedule', { key: 'oneDay' })
    // Dia desligado com fim antes do início não bloqueia.
    expect(validateConfig('smart_interval', patchDay(patchDay(off, 'friday', { enabled: true }), 'sunday', { start_time: '20:00', end_time: '10:00' }))).toEqual({})
  })

  it('trocar o tipo não perde o que foi digitado', () => {
    const c = withScheduleType(withScheduleType({ schedule_type: 'time', interval_value: 5, interval_unit: 'days' }, 'date'), 'time')
    expect(c).toMatchObject({ schedule_type: 'time', interval_value: 5, interval_unit: 'days' })
  })
})

describe('peças comuns (validação bloqueante, números, variáveis)', () => {
  it('validateActions só lista as ações com erro (o rascunho com erro não vai ao autosave)', () => {
    const ok: FlowAction = { id: 'a1', type: 'smart_interval', order: 0, config: defaultInterval() }
    const bad: FlowAction = { id: 'a2', type: 'execute_flow', order: 1, config: { target_flow_id: '' } }
    expect(validateActions([ok, bad])).toEqual({ a2: { target_flow_id: { key: 'required' } } })
    expect(validateActions([ok, { ...bad, config: { target_flow_id: 'f1', target_flow_name: 'Pós-venda' } }])).toEqual({})
  })

  it('parseNumber replica o motor; numberOrTemplate guarda variável como texto', () => {
    expect(parseNumber('1.234,56')).toBe(1234.56)
    expect(parseNumber(' 10 ')).toBe(10)
    expect(parseNumber('abc')).toBeNull()
    expect(numberOrTemplate('19,9')).toBe(19.9)
    expect(numberOrTemplate('{venda.valor}')).toBe('{venda.valor}')
    expect(numberOrTemplate('')).toBeUndefined()
    expect(hasVariable('a {x} b')).toBe(true)
  })

  it('issueError traduz os códigos do zod e as mensagens do T10', () => {
    expect(issueError({ code: 'too_big', origin: 'string', maximum: 200, path: [], message: '' })).toEqual({ key: 'maxLength', vars: { max: 200 } })
    expect(issueError({ code: 'invalid_format', path: [], message: 'id inválido para handle' })).toEqual({ key: 'handle' })
    expect(issueError({ code: 'custom', path: [], message: 'nomes de saída repetidos' })).toEqual({ key: 'duplicateOutput' })
    expect(issueError({ code: 'custom', path: [], message: 'algo novo' })).toEqual({ key: 'invalid' })
  })

  it('insertVariable e setField', () => {
    expect(insertVariable('Oi !', 'first_name', 3)).toEqual({ value: 'Oi {first_name}!', caret: 15 })
    expect(setField({ a: 1 }, 'a', undefined)).toEqual({})
  })
})

describe('i18n: textos dos editores nas 3 línguas', () => {
  const NS = 'node-editors-logic'
  const keys = [
    ...CONDITION_CATEGORIES.map((v) => `cond.categories.${v}`),
    ...SYSTEM_SUBTYPES.map((v) => `cond.subtypes.${v}`),
    ...CONDITION_OPERATORS.map((v) => `cond.operators.${v}`),
    ...REPLY_TYPES.map((v) => `cond.replyTypes.${v}`),
    ...ATTENDANCE_STATUSES.map((v) => `cond.attendanceStatuses.${v}`),
    ...WEEKDAYS.map((v) => `weekdays.${v}`),
    ...['time', 'date', 'weekly'].map((v) => `interval.types.${v}`),
    ...['success', 'failure', 'source'].map((v) => `outputs.handles.${v}`),
    ...['labels', 'departments', 'boards', 'columns', 'agents', 'team', 'flows', 'customFields', 'globals', 'aiKeys', 'models', 'pixels'].map((v) => `lists.names.${v}`),
    ...['required', 'operator', 'number', 'maxWait', 'oneDay', 'endAfterStart', 'duplicateOutput', 'mathNumber', 'goalOnly', 'duplicateName', 'variableName', 'path', 'url', 'handle'].map((v) => `errors.${v}`),
  ]
  it.each(LOCALES)('%s tem todas as chaves dinâmicas', (locale) => {
    for (const k of keys) expect(translate(locale, k, undefined, NS), `${locale}:${k}`).not.toBe(k)
  })
})
