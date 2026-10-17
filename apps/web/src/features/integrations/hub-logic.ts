// Regras puras do hub de integrações (T59; 19 §2.2, §5.1): busca sem acentos, categoria do `?cat=`, contador de ativas
// por aba, navegação das abas pelo teclado e validação do formulário da chave de IA (réplica das regras do core T38:
// nome de 2 a 80 caracteres, segredo obrigatório só na criação e até 500).
import { DEFAULT_CATEGORY, INTEGRATION_CATEGORIES, type IntegrationCategory, type IntegrationRecord } from './catalog'

/** Minúsculas e sem acentos (`Integração` → `integracao`). */
export const normalizeText = (v: string) =>
  v
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** Algum dos campos contém o termo (normalizado)? Termo vazio casa tudo. */
export function matchesSearch(fields: readonly (string | null | undefined)[], term: string): boolean {
  const q = normalizeText(term.trim())
  if (!q) return true
  return fields.some((f) => !!f && normalizeText(f).includes(q))
}

export function parseCategory(raw: unknown): IntegrationCategory {
  return (INTEGRATION_CATEGORIES as readonly unknown[]).includes(raw) ? (raw as IntegrationCategory) : DEFAULT_CATEGORY
}

/** Registros ativos por categoria (contador das abas, 19 §2.2). */
export function activeCounts(records: readonly IntegrationRecord[]): Record<IntegrationCategory, number> {
  const out = Object.fromEntries(INTEGRATION_CATEGORIES.map((c) => [c, 0])) as Record<IntegrationCategory, number>
  for (const r of records) if (r.active) out[r.category] += 1
  return out
}

/** Aba seguinte pelas setas ←/→ (circular), Home e End; outras teclas → `null`. */
export function nextCategory(current: IntegrationCategory, key: string): IntegrationCategory | null {
  const list = INTEGRATION_CATEGORIES
  const i = list.indexOf(current)
  if (key === 'ArrowRight') return list[(i + 1) % list.length]!
  if (key === 'ArrowLeft') return list[(i - 1 + list.length) % list.length]!
  if (key === 'Home') return list[0]!
  if (key === 'End') return list[list.length - 1]!
  return null
}

export const AI_KEY_NAME_MIN = 2
export const AI_KEY_NAME_MAX = 80
export const AI_KEY_SECRET_MAX = 500

export type AiKeyFormErrors = { name?: 'nameLength'; secret?: 'secretRequired' | 'secretTooLong' }

export function validateAiKeyForm(input: { name: string; secret: string }, mode: 'create' | 'edit'): AiKeyFormErrors {
  const errors: AiKeyFormErrors = {}
  const name = input.name.trim()
  if (name.length < AI_KEY_NAME_MIN || name.length > AI_KEY_NAME_MAX) errors.name = 'nameLength'
  const secret = input.secret.trim()
  if (mode === 'create' && !secret) errors.secret = 'secretRequired'
  else if (secret.length > AI_KEY_SECRET_MAX) errors.secret = 'secretTooLong'
  return errors
}
