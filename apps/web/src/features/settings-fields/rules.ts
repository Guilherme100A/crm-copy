// Regras puras do catálogo de campos (replicam `normalizeFieldKey` de `packages/core/src/custom-fields/service.ts`).
import type { CustomFieldDto } from './api'

export const KEY_MIN = 2
export const KEY_MAX = 255
const KEY_RE = /^[\p{L}\p{N}_\- ]+$/u

export type FieldsView = 'custom' | 'system'

export const normalizeKey = (raw: string) => raw.trim().toLowerCase()

export type KeyIssue = 'length' | 'chars' | 'reserved'

export function keyIssue(raw: string, systemKeys: ReadonlySet<string>): KeyIssue | null {
  const key = normalizeKey(raw)
  if (key.length < KEY_MIN || key.length > KEY_MAX) return 'length'
  if (!KEY_RE.test(key)) return 'chars'
  if (systemKeys.has(key)) return 'reserved'
  return null
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** Filtra pela aba (customizados × sistema) e pela busca local em chave e descrição. */
export function filterFields(items: readonly CustomFieldDto[], view: FieldsView, q: string): CustomFieldDto[] {
  const n = fold(q.trim())
  return items.filter(
    (f) => f.system === (view === 'system') && (!n || fold(f.key).includes(n) || fold(f.description ?? '').includes(n)),
  )
}
