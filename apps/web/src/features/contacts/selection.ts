// Seleção em massa (05 §3.4): ids explícitos, ou "todos do filtro/da conta" com exclusões. Daqui saem a contagem
// efetiva, o corpo da exportação, o manifesto da exclusão em massa e o rascunho do disparo em massa.
import type { ApiFilters } from './filters'

export interface Selection {
  /** Todos do filtro atual (ou da conta, sem filtro), menos `except`. */
  all: boolean
  ids: ReadonlySet<string>
  except: ReadonlySet<string>
  /** Último checkbox clicado, base do Shift+clique. */
  anchor: string | null
}

export const emptySelection = (): Selection => ({ all: false, ids: new Set(), except: new Set(), anchor: null })

export const isSelected = (s: Selection, id: string) => (s.all ? !s.except.has(id) : s.ids.has(id))

function setMany(s: Selection, targets: readonly string[], value: boolean): Selection {
  if (s.all) {
    const except = new Set(s.except)
    for (const id of targets) {
      if (value) except.delete(id)
      else except.add(id)
    }
    return { ...s, except }
  }
  const ids = new Set(s.ids)
  for (const id of targets) {
    if (value) ids.add(id)
    else ids.delete(id)
  }
  return { ...s, ids }
}

/**
 * Clique no checkbox de `id`. Com Shift e uma âncora visível, aplica o novo valor a todo o intervalo entre a
 * âncora e `id` (na ordem exibida).
 */
export function toggle(s: Selection, id: string, order: readonly string[], shift = false): Selection {
  const value = !isSelected(s, id)
  let targets: readonly string[] = [id]
  if (shift && s.anchor && s.anchor !== id) {
    const a = order.indexOf(s.anchor)
    const b = order.indexOf(id)
    if (a >= 0 && b >= 0) targets = order.slice(Math.min(a, b), Math.max(a, b) + 1)
  }
  return { ...setMany(s, targets, value), anchor: id }
}

/** Marca (ou desmarca, se todos já estão) os visíveis. */
export function toggleVisible(s: Selection, visible: readonly string[]): Selection {
  const allOn = visible.length > 0 && visible.every((id) => isSelected(s, id))
  return setMany(s, visible, !allOn)
}

export const selectAll = (): Selection => ({ all: true, ids: new Set(), except: new Set(), anchor: null })

/**
 * Contagem efetiva: no modo todos, total do filtro − excluídos; senão, nº de ids. Total desconhecido (`null`)
 * usa o que já foi carregado (`loaded`) e marca como estimado.
 */
export function selectedCount(s: Selection, total: number | null, loaded: number): { n: number; estimated: boolean } {
  if (!s.all) return { n: s.ids.size, estimated: false }
  const base = total ?? loaded
  return { n: Math.max(0, base - s.except.size), estimated: total === null }
}

export const hasSelection = (s: Selection, total: number | null, loaded: number) => selectedCount(s, total, loaded).n > 0

/** Modo do fio: `ids` | `all_except`. */
export interface SelectionPayload {
  mode: 'ids' | 'all_except'
  ids: string[]
  except_ids: string[]
  filters: ApiFilters
}

export function toPayload(s: Selection, filters: ApiFilters): SelectionPayload {
  return s.all ? { mode: 'all_except', ids: [], except_ids: [...s.except], filters } : { mode: 'ids', ids: [...s.ids], except_ids: [], filters: {} }
}

/** Corpo de `POST /api/contacts/exports`: sem seleção exporta o filtro atual (`filtered`). */
export function exportBody(s: Selection | null, filters: ApiFilters, includeCustomFields: boolean): Record<string, unknown> {
  if (!s || (!s.all && s.ids.size === 0)) return { mode: 'filtered', filters, include_custom_fields: includeCustomFields }
  const p = toPayload(s, filters)
  return p.mode === 'ids' ? { mode: 'ids', ids: p.ids, include_custom_fields: includeCustomFields } : { mode: 'all_except', except_ids: p.except_ids, filters, include_custom_fields: includeCustomFields }
}

/** Manifesto da exclusão em massa (05 §3.7), enviado como arquivo `customers-bulk-delete-{ts}.json`. */
export function bulkDeleteManifest(s: Selection, filters: ApiFilters): Record<string, unknown> {
  const p = toPayload(s, filters)
  return p.mode === 'ids' ? { version: 1, mode: 'ids', filters: {}, ids: p.ids } : { version: 1, mode: 'all_except', filters, except_ids: p.except_ids }
}

/**
 * Rascunho levado ao wizard de disparo em massa (`/mass-dispatches`, T83) no state do router (05 §5 nº 22;
 * 10 §2: `openCreate` + seleção/filtros + contagem estimada). Leitura: `history.state.massDispatchDraft`.
 */
export interface MassDispatchDraft extends SelectionPayload {
  open_create: true
  count: number
}

export const MASS_DISPATCH_DRAFT_KEY = 'massDispatchDraft'

export function massDispatchDraft(s: Selection, filters: ApiFilters, count: number): MassDispatchDraft {
  return { open_create: true, ...toPayload(s, filters), count }
}
