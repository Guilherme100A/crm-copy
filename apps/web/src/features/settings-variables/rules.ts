// Regras puras das variáveis globais (replicam `globalVariableName`/`NUMBER_VALUE_RE` de
// `packages/core/src/content/rules.ts`): o usuário digita só o sufixo; o prefixo `g_` é fixo na tela.
import type { VariableType } from './api'

export const PREFIX = 'g_'
export const NAME_MAX = 64
export const NUMBER_VALUE_RE = /^-?\d+(\.\d+)?$/

/** Tira o `g_` colado/digitado e os caracteres fora de `[A-Za-z0-9_]`. */
export function nameSuffix(raw: string): string {
  const s = raw.trim().replace(/[^A-Za-z0-9_]/g, '')
  return s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s
}

/** Nome exibido sem o prefixo (o servidor devolve com). */
export const stripPrefix = (name: string) => (name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name)

export type VariableIssue = 'name' | 'name_long' | 'number'

export function nameIssue(suffix: string): VariableIssue | null {
  if (!suffix) return 'name'
  if (PREFIX.length + suffix.length > NAME_MAX) return 'name_long'
  return null
}

/** Número: `10`, `-2.5`. Vazio é aceito (como no servidor). */
export function valueIssue(type: VariableType, value: string): VariableIssue | null {
  return type === 'number' && value.trim() !== '' && !NUMBER_VALUE_RE.test(value.trim()) ? 'number' : null
}
