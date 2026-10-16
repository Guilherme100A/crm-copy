// Filtros e seleção em massa de contatos (T66; 05 §3.3–3.4) no formato do fio (snake_case), usados pela
// exportação e pelo manifesto da exclusão em massa. A semântica dos filtros é a da listagem (`contactFilterConditions`).
import { and, eq, gt, sql, type SQL } from 'drizzle-orm'
import { contacts } from '@crm/db'
import { contactFilterConditions, type ContactFilters } from '../contacts/service'

export const SELECTION_MODES = ['ids', 'all_except', 'filtered'] as const
export type SelectionMode = (typeof SELECTION_MODES)[number]

/** Seleção normalizada: modo, filtros e ids (alvos em `ids`, excluídos em `all_except`). */
export interface ContactSelection {
  mode: SelectionMode
  filters: ContactFilters
  ids: string[]
  exceptIds: string[]
}

export class SelectionError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'SelectionError'
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const MAX_SELECTION_IDS = 100_000

function idList(raw: unknown, path: string): string[] {
  if (raw === undefined || raw === null || raw === '') return []
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((v) => String(v).trim()).filter(Boolean)
  if (list.length > MAX_SELECTION_IDS) throw new SelectionError(path, `no máximo ${MAX_SELECTION_IDS} ids`)
  for (const id of list) if (!UUID_RE.test(id)) throw new SelectionError(path, `id inválido: ${id.slice(0, 40)}`)
  return [...new Set(list.map((id) => id.toLowerCase()))]
}

function text(raw: unknown, path: string, max: number): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new SelectionError(path, 'texto esperado')
  const v = raw.trim()
  if (v.length > max) throw new SelectionError(path, `no máximo ${max} caracteres`)
  return v || undefined
}

function day(raw: unknown, path: string, end: boolean): Date | undefined {
  const v = text(raw, path, 10)
  if (!v) return undefined
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new SelectionError(path, 'data inválida (AAAA-MM-DD)')
  const d = new Date(`${v}T00:00:00Z`)
  return end ? new Date(d.getTime() + 86_400_000) : d
}

/** Filtros do fio → `ContactFilters` (o `to` inclui o dia inteiro, como a listagem). */
export function parseContactFilters(raw: unknown, base = 'filters'): ContactFilters {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new SelectionError(base, 'objeto esperado')
  const f = raw as Record<string, unknown>
  const out: ContactFilters = {}
  const search = text(f.search, `${base}.search`, 200)
  if (search) out.search = search
  const labelIds = idList(f.label_ids, `${base}.label_ids`)
  if (labelIds.length) out.labelIds = labelIds
  const columnIds = idList(f.crm_column_ids, `${base}.crm_column_ids`)
  if (columnIds.length) out.crmColumnIds = columnIds
  const key = text(f.custom_field_key, `${base}.custom_field_key`, 255)
  if (key) out.customFieldKey = key
  const value = text(f.custom_field_value, `${base}.custom_field_value`, 500)
  if (value && key) out.customFieldValue = value
  const from = day(f.created_at_from, `${base}.created_at_from`, false)
  if (from) out.createdAtFrom = from
  const to = day(f.created_at_to, `${base}.created_at_to`, true)
  if (to) out.createdAtTo = to
  return out
}

/** `{ mode, ids|customer_ids, except_ids, filters }` → seleção validada. */
export function parseSelection(raw: Record<string, unknown>, allowed: readonly SelectionMode[] = SELECTION_MODES): ContactSelection {
  const mode = raw.mode ?? 'filtered'
  if (typeof mode !== 'string' || !(allowed as readonly string[]).includes(mode)) throw new SelectionError('mode', `use ${allowed.join(', ')}`)
  const ids = idList(raw.ids ?? raw.customer_ids ?? raw.contact_ids, 'ids')
  const exceptIds = idList(raw.except_ids, 'except_ids')
  if (mode === 'ids' && !ids.length) throw new SelectionError('ids', 'informe ao menos um id')
  return { mode: mode as SelectionMode, filters: mode === 'ids' ? {} : parseContactFilters(raw.filters), ids: mode === 'ids' ? ids : [], exceptIds: mode === 'all_except' ? exceptIds : [] }
}

/** Seleção → filtros do fio (para gravar no job e reconstruir no worker). */
export function selectionToJson(s: ContactSelection): Record<string, unknown> {
  const f = s.filters
  const filters: Record<string, unknown> = {}
  if (f.search) filters.search = f.search
  if (f.labelIds?.length) filters.label_ids = f.labelIds
  if (f.crmColumnIds?.length) filters.crm_column_ids = f.crmColumnIds
  if (f.customFieldKey) filters.custom_field_key = f.customFieldKey
  if (f.customFieldValue) filters.custom_field_value = f.customFieldValue
  if (f.createdAtFrom) filters.created_at_from = f.createdAtFrom.toISOString().slice(0, 10)
  if (f.createdAtTo) filters.created_at_to = new Date(f.createdAtTo.getTime() - 86_400_000).toISOString().slice(0, 10)
  return { mode: s.mode, filters, ids: s.ids, except_ids: s.exceptIds }
}

/** Condição SQL da seleção na empresa (`afterId`: keyset por id). */
export function selectionWhere(companyId: string, s: ContactSelection, afterId?: string | null): SQL {
  const conds: SQL[] = s.mode === 'ids' ? [eq(contacts.companyId, companyId), sql`${contacts.id} = any(${sql.param(s.ids)}::uuid[])`] : contactFilterConditions(companyId, s.filters)
  if (s.mode === 'all_except' && s.exceptIds.length) conds.push(sql`not (${contacts.id} = any(${sql.param(s.exceptIds)}::uuid[]))`)
  if (afterId) conds.push(gt(contacts.id, afterId))
  return and(...conds)!
}
