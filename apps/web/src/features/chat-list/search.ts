// Filtros da lista de chats na URL (T69; spec 03 F01–F11; SPEC 3.11 search params tipados). A URL é a fonte da
// verdade: recarregar reaplica tudo. `toApiQuery` traduz para os parâmetros do `GET /api/chats` (T48/T50).
import { z } from 'zod'

export const CHAT_TABS = ['waiting', 'attending', 'resolved'] as const
export type ChatTab = (typeof CHAT_TABS)[number]

export const QUICK_FILTERS = ['unread', 'unanswered'] as const
export type QuickFilter = (typeof QUICK_FILTERS)[number]

export const CHAT_PAGE_SIZE = 15

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const optText = (max: number) => z.string().trim().max(max).optional().catch(undefined)
const optDate = z.string().regex(DATE_RE).optional().catch(undefined)
const optIds = z.array(z.string().trim().min(1).max(64)).max(100).optional().catch(undefined)
const uniq = (v: string[] | undefined) => (v?.length ? [...new Set(v)] : undefined)

export const chatSearchSchema = z.object({
  status: z.enum(CHAT_TABS).optional().catch(undefined),
  quick: z.enum(QUICK_FILTERS).optional().catch(undefined),
  search: optText(200),
  /** `me`, `none` ou um user_id. */
  assigned_to: optText(64),
  created_from: optDate,
  created_to: optDate,
  connection_ids: optIds,
  department_ids: optIds,
  label_ids: optIds,
  crm_id: optText(64),
})
export type ChatSearch = z.infer<typeof chatSearchSchema>

/** Campos do modal de filtros avançados. */
export const ADVANCED_KEYS = ['assigned_to', 'created_from', 'created_to', 'connection_ids', 'department_ids', 'label_ids', 'crm_id'] as const
export type AdvancedFilters = Pick<ChatSearch, (typeof ADVANCED_KEYS)[number]>

export const activeTab = (s: ChatSearch): ChatTab => s.status ?? 'waiting'

/** Quantos filtros avançados estão ativos (o período conta como um). */
export function advancedCount(s: ChatSearch): number {
  let n = 0
  if (s.assigned_to) n++
  if (s.created_from || s.created_to) n++
  if (s.crm_id) n++
  n += s.connection_ids?.length ?? 0
  n += s.department_ids?.length ?? 0
  n += s.label_ids?.length ?? 0
  return n
}

/** Remove chaves vazias (a URL fica limpa: `?status=attending` em vez de `?status=attending&search=`). */
export function cleanSearch(s: ChatSearch): ChatSearch {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out as ChatSearch
}

/** `YYYY-MM-DD` local → ISO do início (ou fim) do dia no fuso do navegador. */
export function dayBound(date: string, end: boolean): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const local = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0)
  return local.toISOString()
}

/** Período inválido (só uma das datas, ou fim antes do início) → chave do erro; `null` se ok. */
export function periodProblem(from?: string, to?: string): 'both' | 'order' | null {
  if (!from && !to) return null
  if (!from || !to) return 'both'
  return to < from ? 'order' : null
}

export type ApiQuery = Record<string, string | number | readonly string[] | undefined>

/** Parâmetros do `GET /api/chats` (sem `cursor`). */
export function toApiQuery(s: ChatSearch): ApiQuery {
  const q: ApiQuery = { status: activeTab(s), limit: CHAT_PAGE_SIZE }
  if (s.search) q.search = s.search
  if (s.quick === 'unread') q.read_status = 'unread'
  if (s.quick === 'unanswered') q.response_status = 'unanswered'
  if (s.assigned_to) q.assigned_to = s.assigned_to
  if (s.created_from && s.created_to && !periodProblem(s.created_from, s.created_to)) {
    q.created_from = dayBound(s.created_from, false)
    q.created_to = dayBound(s.created_to, true)
  }
  for (const key of ['connection_ids', 'department_ids', 'label_ids'] as const) {
    const ids = uniq(s[key])
    if (ids) q[key] = ids
  }
  if (s.crm_id) q.crm_id = s.crm_id
  return q
}
