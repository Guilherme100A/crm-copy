// Regras puras do grupo lógica (T41; 06 §3.6): condição (categorias, subtipos e os operadores coerentes com o tipo,
// réplica de `packages/core/src/flows/nodes/logic/rules.ts`), distribuidor (saídas com id estável e quantidades) e
// intervalo inteligente (tempo, data, faixas semanais).
import { CONDITION_CATEGORIES, SYSTEM_SUBTYPES, WEEKDAYS } from '@crm/shared/flows'
import { defineLocalRules, hasVariable, list, outputId, parseNumber, type Config, type FieldErrors } from './rules'

export type Category = (typeof CONDITION_CATEGORIES)[number]
export type SystemSubtype = (typeof SYSTEM_SUBTYPES)[number]
export type Weekday = (typeof WEEKDAYS)[number]

export { CONDITION_CATEGORIES, SYSTEM_SUBTYPES, WEEKDAYS }

// ---------------------------------------------------------------- condição

export const TEXT_OPERATORS = ['equal', 'different', 'contains', 'not_contains', 'starts_with', 'has_value', 'type'] as const
export const NUMERIC_OPERATORS = ['greater_than', 'less_than', 'greater_or_equal', 'less_or_equal', 'numeric_equal'] as const
const NUMERIC = new Set<string>(NUMERIC_OPERATORS)
const SAME_OR_NOT = ['equal', 'different'] as const

/** Campos do contato que o motor conhece na categoria `field` (todos de texto). */
export const CONTACT_FIELDS = ['name', 'phone', 'email'] as const
/** Tipos de resposta para o operador `type` (`vars.reply.type`). */
export const REPLY_TYPES = ['text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contact'] as const
export const ATTENDANCE_STATUSES = ['waiting', 'in_progress', 'resolved'] as const

/** Tipo do valor comparado: decide os operadores. `unknown` (campo personalizado, variável sem tipo) aceita os dois. */
export type ValueKind = 'text' | 'number' | 'unknown'

/**
 * Operadores coerentes com a categoria/subtipo (e com o tipo do valor, nos campos):
 * - etiqueta, dia da semana, atendimento e atendente: igual / diferente (nega);
 * - hora: igual (mesma hora), antes, depois; data: igual, diferente, antes, depois;
 * - janela de mensagem: sempre aberta no clone (Baileys);
 * - campos: texto (igual, diferente, contém, não contém, começa com, tem valor, tipo da resposta) e/ou numéricos.
 */
export function operatorsFor(category: string, subtype?: string, kind: ValueKind = 'unknown'): readonly string[] {
  switch (category) {
    case 'system':
      switch (subtype) {
        case 'time':
          return ['equal', 'before', 'after']
        case 'date':
          return ['equal', 'different', 'before', 'after']
        case 'message_window':
          return ['open']
        default:
          return SAME_OR_NOT
      }
    case 'attendance':
    case 'attendant':
      return SAME_OR_NOT
    case 'field':
      return TEXT_OPERATORS
    default:
      if (kind === 'number') return [...NUMERIC_OPERATORS, 'has_value']
      if (kind === 'text') return TEXT_OPERATORS
      return [...TEXT_OPERATORS, ...NUMERIC_OPERATORS]
  }
}

export const isNumericOperator = (op: unknown) => typeof op === 'string' && NUMERIC.has(op)
/** Operadores de campo que dispensam o valor. */
export const operatorNeedsValue = (op: unknown) => op !== 'has_value'

/** Tipo de valor da regra: variável global pelo tipo cadastrado; campos do contato são texto. */
export function valueKind(rule: Config, globals: readonly { name: string; type: string }[] = []): ValueKind {
  if (rule.category === 'field') return 'text'
  if (rule.category === 'global_variable') {
    const raw = typeof rule.fieldName === 'string' ? rule.fieldName.trim() : ''
    const g = globals.find((x) => x.name === raw || x.name === `g_${raw}`)
    return g?.type === 'number' ? 'number' : g?.type === 'text' ? 'text' : 'unknown'
  }
  return 'unknown'
}

/** Regra nova (ou ao trocar a categoria): só os campos da categoria, com o primeiro operador coerente. */
export function defaultRule(category: Category): Config {
  switch (category) {
    case 'system':
      return systemRule('tag')
    case 'attendance':
      return { category, attendanceStatus: 'waiting', operator: 'equal' }
    case 'attendant':
      return { category, user_ids: [], operator: 'equal' }
    case 'field':
      return { category, fieldName: 'name', operator: 'equal', value: '' }
    default:
      return { category, fieldName: '', operator: 'equal', value: '' }
  }
}

/** Regra de sistema do subtipo (troca de subtipo zera os campos do anterior). */
export function systemRule(subtype: SystemSubtype): Config {
  const base: Config = { category: 'system', systemSubtype: subtype, operator: operatorsFor('system', subtype)[0] }
  switch (subtype) {
    case 'tag':
      return { ...base, tagName: '' }
    case 'weekday':
      return { ...base, weekday: 'monday' }
    case 'time':
      return { ...base, operator: 'before', time: 12, timeMinute: 0 }
    case 'date':
      return { ...base, date: '' }
    default:
      return base
  }
}

/** Troca o operador; sem valor (`has_value`) a chave sai, e `type` começa em `text`. */
export function withOperator(rule: Config, operator: string): Config {
  const next: Config = { ...rule, operator }
  if (!operatorNeedsValue(operator)) delete next.value
  else if (operator === 'type' && !(REPLY_TYPES as readonly string[]).includes(String(rule.value ?? ''))) next.value = 'text'
  else if (rule.operator === 'type' && operator !== 'type') next.value = ''
  return next
}

export const defaultCondition = (): Config => ({ ruleType: 'all', conditions: [defaultRule('field')] })

/** Regras locais da condição (o schema do T10 não confere operador × tipo nem o valor). */
export function conditionLocalErrors(c: Config): FieldErrors {
  const out: FieldErrors = {}
  list(c.conditions).forEach((rule, i) => {
    const category = String(rule.category ?? '')
    const op = rule.operator
    const allowed = operatorsFor(category, typeof rule.systemSubtype === 'string' ? rule.systemSubtype : undefined)
    if (op !== undefined && !allowed.includes(String(op))) out[`conditions.${i}.operator`] = { key: 'operator' }
    if (!['field', 'custom_field', 'global_variable'].includes(category) || !operatorNeedsValue(op)) return
    const value = rule.value
    const empty = value === undefined || (typeof value === 'string' && !value.trim())
    if (empty) out[`conditions.${i}.value`] = { key: 'required' }
    else if (isNumericOperator(op) && !hasVariable(value) && parseNumber(value) === null) out[`conditions.${i}.value`] = { key: 'number' }
  })
  return out
}

defineLocalRules('evaluate_condition', conditionLocalErrors)

// ---------------------------------------------------------------- distribuidor

export interface DistOutput {
  id: string
  name?: string
  quantity?: number
}

export const distOutputs = (c: Config): DistOutput[] =>
  list(c.outputs).map((o) => ({
    id: String(o.id ?? ''),
    ...(typeof o.name === 'string' ? { name: o.name } : {}),
    ...(typeof o.quantity === 'number' ? { quantity: o.quantity } : {}),
  }))

/** Config inicial: duas saídas de quantidade 1 (ids gerados uma vez). */
export function defaultDistributor(names: (i: number) => string, random?: () => number): Config {
  const a = outputId([], random)
  const b = outputId([a], random)
  return { outputs: [{ id: a, name: names(1), quantity: 1 }, { id: b, name: names(2), quantity: 1 }], distribute_always_next: false, prevent_repetition: false }
}

/** Nova saída com id inédito (nunca o índice). */
export function addDistOutput(c: Config, name: string, random?: () => number): Config {
  const outputs = distOutputs(c)
  return { ...c, outputs: [...outputs, { id: outputId(outputs.map((o) => o.id), random), name, quantity: 1 }] }
}

export const removeDistOutput = (c: Config, id: string): Config => ({ ...c, outputs: distOutputs(c).filter((o) => o.id !== id) })

export function patchDistOutput(c: Config, id: string, patch: Partial<Omit<DistOutput, 'id'>>): Config {
  return {
    ...c,
    outputs: distOutputs(c).map((o) => {
      if (o.id !== id) return o
      const next: DistOutput = { ...o, ...patch }
      if (patch.quantity === undefined && 'quantity' in patch) delete next.quantity
      return next
    }),
  }
}

/** Fatia de cada saída em % como o motor: quantidade ausente = 1, 0 = nunca; todas 0 = partes iguais. */
export function distShares(outputs: readonly DistOutput[]): Record<string, number> {
  const qty = (o: DistOutput) => Math.max(0, o.quantity ?? 1)
  const total = outputs.reduce((s, o) => s + qty(o), 0)
  const share = (o: DistOutput) => (total > 0 ? qty(o) / total : 1 / outputs.length)
  return Object.fromEntries(outputs.map((o) => [o.id, Math.round(share(o) * 1000) / 10]))
}

// ---------------------------------------------------------------- intervalo inteligente

export const SCHEDULE_TYPES = ['time', 'date', 'weekly'] as const
export const INTERVAL_UNITS = ['minutes', 'hours', 'days'] as const

export interface DaySchedule {
  enabled: boolean
  start_time: string
  end_time: string
}

/** Segunda a sexta 08:00–18:00; fim de semana desligado (todos os dias presentes, como o schema pede). */
export function defaultWeekly(): Record<Weekday, DaySchedule> {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, { enabled: d !== 'saturday' && d !== 'sunday', start_time: '08:00', end_time: '18:00' }])) as Record<Weekday, DaySchedule>
}

export const defaultInterval = (): Config => ({ schedule_type: 'time', interval_value: 1, interval_unit: 'hours' })

/** Troca o tipo; os campos dos outros tipos ficam (voltar não perde o que foi digitado). Semanal ganha a grade padrão. */
export function withScheduleType(c: Config, type: (typeof SCHEDULE_TYPES)[number]): Config {
  const next: Config = { ...c, schedule_type: type }
  if (type === 'weekly' && (!c.weekly_schedule || typeof c.weekly_schedule !== 'object')) next.weekly_schedule = defaultWeekly()
  if (type === 'time' && next.interval_unit === undefined) next.interval_unit = 'hours'
  return next
}

export function weeklyOf(c: Config): Record<Weekday, DaySchedule> {
  const base = defaultWeekly()
  const raw = (c.weekly_schedule && typeof c.weekly_schedule === 'object' ? c.weekly_schedule : {}) as Record<string, Partial<DaySchedule>>
  for (const d of WEEKDAYS) {
    const r = raw[d]
    if (r) base[d] = { enabled: r.enabled === true, start_time: r.start_time ?? base[d].start_time, end_time: r.end_time ?? base[d].end_time }
    else base[d] = { ...base[d], enabled: false }
  }
  return base
}

export const patchDay = (c: Config, day: Weekday, patch: Partial<DaySchedule>): Config => {
  const weekly = weeklyOf(c)
  return { ...c, weekly_schedule: { ...weekly, [day]: { ...weekly[day], ...patch } } }
}

/** `YYYY-MM-DDTHH:MM` (local da empresa) já passou? Aviso, não bloqueio: o motor confere na execução. */
export function isPastLocal(value: string, now: Date = new Date()): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim())
  if (!m) return false
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  return at.getTime() < now.getTime()
}
