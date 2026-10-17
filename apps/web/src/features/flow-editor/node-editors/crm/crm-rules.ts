// Regras puras do grupo CRM (T63; 06 §3.6): etiquetas pelo NOME (o motor procura sem caixa e cria no `add`), status do
// chat, departamento, Kanban (valor só com coluna-meta), Manipulador (conta exige número) e Agente de IA.
import { CHAT_STATUS_VALUES } from '@crm/shared/flows'
import { defineLocalRules, hasVariable, parseNumber, setField, setFields, type Config, type FieldErrors } from '../logic/rules'

export { CHAT_STATUS_VALUES }

// ---------------------------------------------------------------- etiquetas

export const TAG_ACTIONS = ['add_tags', 'remove_tags'] as const
export type TagAction = (typeof TAG_ACTIONS)[number]

export const tagConfig = (type: TagAction, tags: string[] = []): Config => ({ action: type === 'add_tags' ? 'add' : 'remove', tags })

/** Acrescenta o nome (aparado), sem repetir — a comparação ignora caixa, como o motor. */
export function addTag(tags: readonly string[], name: string): string[] {
  const n = name.trim()
  if (!n || tags.some((t) => t.trim().toLowerCase() === n.toLowerCase())) return [...tags]
  return [...tags, n]
}

export const removeTag = (tags: readonly string[], name: string): string[] => tags.filter((t) => t !== name)

/** Nome digitado que não existe na lista da empresa: no `add` o motor cria a etiqueta; no `remove` não há o que tirar. */
export const isNewTag = (name: string, labels: readonly { name: string }[]) => !labels.some((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase())

// ---------------------------------------------------------------- Kanban

export const KANBAN_ACTIONS = ['create_kanban_card', 'remove_kanban_card'] as const
export type KanbanAction = (typeof KANBAN_ACTIONS)[number]

/** Troca de modo: o quadro fica; remover só pede o quadro. */
export function kanbanConfig(type: KanbanAction, from: Config): Config {
  const board = { crm_id: typeof from.crm_id === 'string' ? from.crm_id : '', ...(typeof from.crm_name === 'string' ? { crm_name: from.crm_name } : {}) }
  return type === 'create_kanban_card' ? { ...board, crm_column_id: '' } : board
}

/** Outro quadro: a coluna (e o valor da meta) zeram. */
export const withBoard = (c: Config, board: { id: string; name?: string | undefined }, creating: boolean): Config => {
  let next = setFields(c, { crm_id: board.id, crm_name: board.name })
  if (creating) next = setFields(next, { crm_column_id: '', crm_column_name: undefined, crm_column_conversion_goal: undefined, value: undefined })
  return next
}

/** Coluna escolhida: marca se é meta de conversão; sem meta o valor sai (o schema só aceita valor na meta). */
export function withColumn(c: Config, column: { id: string; name?: string | undefined; conversion_goal?: boolean | undefined }): Config {
  let next = setFields(c, { crm_column_id: column.id, crm_column_name: column.name, crm_column_conversion_goal: column.conversion_goal ? true : undefined })
  if (!column.conversion_goal) next = setField(next, 'value', undefined)
  return next
}

defineLocalRules('create_kanban_card', (c): FieldErrors => {
  if (c.value === undefined || c.crm_column_conversion_goal === true) return {}
  return { value: { key: 'goalOnly' } }
})

// ---------------------------------------------------------------- Manipulador

export const MANIPULATOR_ACTIONS = ['set_contact_custom_field', 'set_created_at'] as const
export type ManipulatorAction = (typeof MANIPULATOR_ACTIONS)[number]
export const OPERATIONS = ['set_value', 'add', 'subtract', 'multiply', 'divide'] as const
export const VALUE_TYPES = ['text', 'number'] as const

export const manipulatorConfig = (type: ManipulatorAction): Config =>
  type === 'set_contact_custom_field' ? { field_name: '', operation: 'set_value', value_type: 'text', value: '' } : { operation: 'set_value', value: '' }

/** Operação matemática força `value_type: number` (o schema recusa conta com texto). */
export function withOperation(c: Config, operation: (typeof OPERATIONS)[number]): Config {
  const next: Config = { ...c, operation }
  if (operation !== 'set_value') next.value_type = 'number'
  return next
}

/** Valor digitado: número quando o tipo é número e o texto é número (vírgula ou ponto); variável fica texto. */
export function manipulatorValue(raw: string, valueType: unknown): string | number {
  if (valueType !== 'number' || hasVariable(raw)) return raw
  return parseNumber(raw) ?? raw
}

defineLocalRules('set_contact_custom_field', (c): FieldErrors => {
  const v = c.value
  if (c.value_type !== 'number' && c.operation === 'set_value') return typeof v === 'string' && !v.trim() ? { value: { key: 'required' } } : {}
  if (typeof v === 'number') return {}
  if (typeof v !== 'string' || !v.trim()) return { value: { key: 'required' } }
  return hasVariable(v) || parseNumber(v) !== null ? {} : { value: { key: 'number' } }
})

// ---------------------------------------------------------------- Agente de IA

export const AGENT_MODES = ['activate', 'deactivate'] as const

/** Remover o agente não precisa do id; entregar exige (o schema confere). */
export const withAgentMode = (c: Config, mode: (typeof AGENT_MODES)[number]): Config => (mode === 'deactivate' ? { mode } : { ...c, mode })
