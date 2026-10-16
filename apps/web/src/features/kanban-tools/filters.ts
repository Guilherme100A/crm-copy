// Filtros do quadro na URL (T76; 04 §5.20–5.24): etapa, etiquetas (OU; lista, como em /chats), responsável
// (`me`/`none`/user) e atualizado de/até (datas locais `YYYY-MM-DD`). `toApiFilters` traduz para os parâmetros da T50
// (início/fim do dia local em ISO), usados nos cards, nas estatísticas e na exportação.
import { z } from 'zod'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const optText = (max: number) => z.string().trim().min(1).max(max).optional().catch(undefined)
const optDate = z.string().regex(DATE_RE).optional().catch(undefined)

export const boardSearchSchema = z.object({
  column_id: optText(64),
  label_ids: z.array(z.string().trim().min(1).max(64)).max(100).optional().catch(undefined),
  /** `me`, `none` ou um user_id. */
  assigned_to: optText(64),
  updated_from: optDate,
  updated_to: optDate,
})
export type BoardSearch = z.infer<typeof boardSearchSchema>

/** Parâmetros aceitos pelo `GET /api/crms/:id/cards|stats` e pelo export `kanban_cards`. */
export interface ApiFilters {
  column_id?: string
  label_ids?: string[]
  assigned_to?: string
  updated_from?: string
  updated_to?: string
}

export const labelIdsOf = (s: Pick<BoardSearch, 'label_ids'>): string[] => [...new Set(s.label_ids ?? [])]

/** Data local `YYYY-MM-DD` → ISO do início (ou fim) do dia no fuso do navegador. */
export function localDayToIso(day: string, end = false): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0)).toISOString()
}

export function toApiFilters(s: BoardSearch): ApiFilters {
  const out: ApiFilters = {}
  if (s.column_id) out.column_id = s.column_id
  const labels = labelIdsOf(s)
  if (labels.length) out.label_ids = labels
  if (s.assigned_to) out.assigned_to = s.assigned_to
  if (s.updated_from) out.updated_from = localDayToIso(s.updated_from)
  if (s.updated_to) out.updated_to = localDayToIso(s.updated_to, true)
  return out
}

/** Query string da T50 (`label_ids=a,b`). */
export function toQuery(f: ApiFilters): Record<string, string> {
  const q: Record<string, string> = {}
  for (const [k, v] of Object.entries(f)) if (v !== undefined) q[k] = Array.isArray(v) ? v.join(',') : v
  return q
}

/** Remove chaves vazias (a URL fica limpa ao limpar filtros). */
export function cleanSearch(s: BoardSearch): BoardSearch {
  const out: BoardSearch = {}
  if (s.column_id) out.column_id = s.column_id
  const labels = labelIdsOf(s)
  if (labels.length) out.label_ids = labels
  if (s.assigned_to) out.assigned_to = s.assigned_to
  if (s.updated_from) out.updated_from = s.updated_from
  if (s.updated_to) out.updated_to = s.updated_to
  return out
}

export function toggleLabel(s: BoardSearch, id: string): BoardSearch {
  const cur = labelIdsOf(s)
  return cleanSearch({ ...s, label_ids: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
}

/** Quantos filtros estão ativos (o período conta como um). */
export function activeFilterCount(s: BoardSearch): number {
  return [s.column_id, s.label_ids?.length, s.assigned_to, s.updated_from || s.updated_to].filter(Boolean).length
}
