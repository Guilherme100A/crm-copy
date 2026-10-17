// Regras puras dos editores de nó da T57 (lógica, CRM e externos; 06 §3.6): ações padrão, validação pelo schema do
// T10 (`@crm/shared/flows`) com o erro levado ao campo, mais as regras do motor que a web não importa (`@crm/core`):
// operadores por tipo da condição (`nodes/logic/rules.ts`), números com vírgula ou ponto e os presets de IA
// (`nodes/external/handlers.ts`). Padrão copiado da T56 (`messaging/rules.ts`), sem importar de lá.
import { getActionSchema, WEEKDAYS, type FlowAction } from '@crm/shared/flows'
import { newId } from '../../canvas/model'

export type Config = Record<string, unknown>

// ---------------------------------------------------------------- ações

export const newAction = (type: string, config: Config, random?: () => number): FlowAction => ({ id: newId('a', random), type, order: 0, config })

/** `order` = posição na lista (o motor executa por `order`). */
export const withOrder = (actions: readonly FlowAction[]): FlowAction[] => actions.map((a, i) => (a.order === i ? a : { ...a, order: i }))

/** Garante uma ação de `types` (a primeira encontrada fica; senão entra `types[0]` com `config()` no início). */
export function ensureAction(actions: FlowAction[], types: readonly string[], config: () => Config): FlowAction[] {
  if (actions.some((a) => types.includes(a.type))) return actions
  return [newAction(types[0]!, config()), ...actions]
}

export const findAction = (actions: readonly FlowAction[], types: readonly string[]) => actions.find((a) => types.includes(a.type))

/** Troca o tipo da ação principal (ex.: adicionar ↔ remover etiquetas), com a config nova. */
export const switchAction = (actions: readonly FlowAction[], id: string, type: string, config: Config): FlowAction[] =>
  actions.map((a) => (a.id === id ? { ...a, type, config } : a))

/** Troca um campo; `undefined` remove a chave (o schema não vê `''` em campo opcional). */
export function setField(config: Config, key: string, value: unknown): Config {
  const next = { ...config }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/** Vários campos de uma vez (mesma regra do `setField`). */
export const setFields = (config: Config, patch: Config): Config => Object.entries(patch).reduce((c, [k, v]) => setField(c, k, v), config)

/** Texto digitado em campo opcional: vazio vira ausente. */
export const optional = (value: string): string | undefined => (value.trim() ? value : undefined)

/** Inteiro digitado (vazio/inválido → `undefined`). */
export function intOf(raw: string): number | undefined {
  if (!raw.trim()) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

export const str = (c: Config, k: string) => (typeof c[k] === 'string' ? (c[k] as string) : typeof c[k] === 'number' ? String(c[k]) : '')
export const num = (c: Config, k: string) => (typeof c[k] === 'number' ? String(c[k]) : '')
export const bool = (c: Config, k: string) => c[k] === true
export const list = (v: unknown): Config[] => (Array.isArray(v) ? v.filter((x): x is Config => !!x && typeof x === 'object' && !Array.isArray(x)) : [])
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Texto com variável `{nome}`: o valor só é conhecido na execução. */
export const hasVariable = (v: unknown) => typeof v === 'string' && /\{[^{}]+\}/.test(v)

/** `'1,5'`, `'1.234,56'`, `' 10 '`, `3` → número; vazio/inválido → `null` (réplica de `parseNumber` do motor). */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  let s = raw.trim().replace(/\s/g, '')
  if (!s) return null
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Valor "número ou variável": `'10'` → 10, `'{valor}'` fica texto, vazio → `undefined`. Texto inválido fica texto. */
export function numberOrTemplate(raw: string): number | string | undefined {
  if (!raw.trim()) return undefined
  if (hasVariable(raw)) return raw
  return parseNumber(raw) ?? raw
}

// ---------------------------------------------------------------- ids estáveis

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Id de saída (distribuidor) ou `output_key` (IA): gerado uma vez no cliente, sem `:` nem espaço, e nunca derivado do
 * índice — o handle `output:<id>` não muda ao reordenar ou remover outra saída, então as arestas não se perdem.
 */
export function outputId(taken: Iterable<string> = [], random: () => number = Math.random, prefix = 'o'): string {
  const used = new Set(taken)
  for (;;) {
    let s = ''
    for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length)]
    const id = `${prefix}_${s}`
    if (!used.has(id)) return id
  }
}

// ---------------------------------------------------------------- validação

export interface FieldError {
  /** Chave i18n em `node-editors-logic:errors.*`. */
  key: string
  vars?: Record<string, string | number>
}

/** Erros por caminho do campo (`request_url`, `conditions.0.fieldName`), o primeiro de cada um. */
export type FieldErrors = Record<string, FieldError>

interface IssueLike {
  code?: string
  path: PropertyKey[]
  message: string
  origin?: string
  minimum?: number | bigint
  maximum?: number | bigint
}

// Mensagens próprias dos schemas do T10 (em pt) → chaves traduzidas.
const CUSTOM: Array<[RegExp, string]> = [
  [/31 dias/, 'maxWait'],
  [/ative ao menos um dia/, 'oneDay'],
  [/fim deve ser depois/, 'endAfterStart'],
  [/id repetido/, 'duplicateId'],
  [/nomes de saída repetidos/, 'duplicateOutput'],
  [/operação matemática/, 'mathNumber'],
  [/atendente/, 'attendant'],
  [/obrigat|escolha/, 'required'],
]

/** Mensagem de um issue do zod como chave de i18n. */
export function issueError(issue: IssueLike): FieldError {
  switch (issue.code) {
    case 'invalid_type':
      return { key: 'required' }
    case 'too_small':
      if (issue.origin === 'string') return { key: 'required' }
      if (issue.origin === 'array') return { key: 'minItems', vars: { min: Number(issue.minimum) } }
      return { key: 'min', vars: { min: Number(issue.minimum) } }
    case 'too_big':
      if (issue.origin === 'array') return { key: 'maxItems', vars: { max: Number(issue.maximum) } }
      if (issue.origin === 'string') return { key: 'maxLength', vars: { max: Number(issue.maximum) } }
      return { key: 'max', vars: { max: Number(issue.maximum) } }
    case 'invalid_format':
      return { key: /handle/.test(issue.message) ? 'handle' : 'format' }
    case 'invalid_value':
      return { key: 'required' }
    default: {
      const hit = CUSTOM.find(([re]) => re.test(issue.message))
      return hit ? { key: hit[1] } : { key: 'invalid' }
    }
  }
}

export const pathKey = (path: readonly PropertyKey[]) => path.filter((p) => typeof p !== 'symbol').join('.')

/** Regras do motor que o schema do T10 não cobre (operador coerente, número, JSON…), por tipo de ação. */
const LOCAL_RULES: Record<string, (c: Config) => FieldErrors> = {}

/** Registra regras locais de um tipo de ação (os módulos de regras de CRM/externos chamam no carregamento). */
export function defineLocalRules(type: string, rules: (c: Config) => FieldErrors) {
  LOCAL_RULES[type] = rules
}

/** Valida a config pelo schema do T10 e pelas regras locais; `{}` = válida. Ação sem schema não bloqueia. */
export function validateConfig(type: string, config: Config): FieldErrors {
  const out: FieldErrors = {}
  const result = getActionSchema(type)?.safeParse(config)
  if (result && !result.success) {
    for (const issue of result.error.issues as IssueLike[]) {
      const key = pathKey(issue.path)
      if (!(key in out)) out[key] = issueError(issue)
    }
  }
  for (const [k, v] of Object.entries(LOCAL_RULES[type]?.(config) ?? {})) if (!(k in out)) out[k] = v
  return out
}

/** Erros por id de ação (só as ações com erro). */
export function validateActions(actions: readonly FlowAction[]): Record<string, FieldErrors> {
  const out: Record<string, FieldErrors> = {}
  for (const a of actions) {
    const errs = validateConfig(a.type, a.config)
    if (Object.keys(errs).length) out[a.id] = errs
  }
  return out
}

export const hasErrors = (errors: Record<string, FieldErrors>) => Object.keys(errors).length > 0

/** Erros que começam por `prefix.` (ex.: os da regra `conditions.2`), com o caminho relativo. */
export function errorsUnder(errors: FieldErrors | undefined, prefix: string): FieldErrors {
  const out: FieldErrors = {}
  for (const [k, v] of Object.entries(errors ?? {})) if (k === prefix || k.startsWith(`${prefix}.`)) out[k === prefix ? '' : k.slice(prefix.length + 1)] = v
  return out
}

// ---------------------------------------------------------------- variáveis

/** Variáveis de 06 §3.9 oferecidas no seletor (contato e sistema); globais e campos vêm da API. */
export const CONTACT_VARIABLES = ['full_name', 'first_name', 'phone_number', 'email', 'created_at'] as const
export const SYSTEM_VARIABLES = ['attendant_name', 'user_email', 'instance_number', 'instance_name', 'hora', 'data', 'dia', 'saudacao', 'last_user_message'] as const

/** Insere `{nome}` no texto entre `start` e `end` (seleção); devolve o texto e a posição do cursor. */
export function insertVariable(value: string, name: string, start = value.length, end = start): { value: string; caret: number } {
  const token = `{${name}}`
  const a = Math.max(0, Math.min(start, value.length))
  const b = Math.max(a, Math.min(end, value.length))
  return { value: value.slice(0, a) + token + value.slice(b), caret: a + token.length }
}

export { WEEKDAYS }
