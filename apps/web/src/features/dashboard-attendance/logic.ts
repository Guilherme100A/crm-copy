// Regras puras da aba Atendimento (T87; 02 §5.19, §5.37–5.42): limite de 92 dias (replicado do core, a web só importa
// `@crm/shared`), tempos `s / min / min s / h / h min`, tendência invertida nos KPIs em que menor é melhor, mapa de
// calor dia×hora com pico(s), agrupamento de fatias em "Outros" e ordenação da tabela por atendente (nulos no fim).
import { HttpError } from '@/lib/http'
import { DASH, MINUS } from '@/features/dashboard/format'
import { rangeDays, type Period } from '@/features/dashboard/search'
import type { AttendanceBlock, AttendanceUser, HeatCell } from './api'

/** Igual a `ATTENDANCE_MAX_RANGE_DAYS` do core (T65): acima disso a API responde 422. */
export const ATTENDANCE_MAX_DAYS = 92

export const tooLong = (p: Period): boolean => rangeDays(p.start_date, p.end_date) > ATTENDANCE_MAX_DAYS

/** O 422 do limite de 92 dias (`fields[].path === 'end_date'`), tratado como o mesmo aviso do cliente. */
export function isRangeError(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 422) return false
  const fields = (err.details as { fields?: { path?: string }[] } | undefined)?.fields
  return Array.isArray(fields) && fields.some((f) => f?.path === 'end_date')
}

/** 45 → `45 s`; 330 → `5 min 30 s`; 300 → `5 min`; 7200 → `2 h`; 8100 → `2 h 15 min`; null → `—`. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return DASH
  const total = Math.round(seconds)
  if (total < 60) return `${total} s`
  if (total < 3600) {
    const m = Math.floor(total / 60)
    const s = total % 60
    return s ? `${m} min ${s} s` : `${m} min`
  }
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

export const KPI_KEYS = ['new_leads', 'attended_leads', 'resolved_leads', 'response_time_seconds', 'unanswered_chats'] as const
export type AttendanceKpi = (typeof KPI_KEYS)[number]

export function formatKpi(key: AttendanceKpi, value: number | null | undefined): string {
  if (key === 'response_time_seconds') return formatDuration(value)
  return value === null || value === undefined ? DASH : new Intl.NumberFormat('pt-BR').format(value)
}

export interface TrendView {
  direction: 'up' | 'down' | 'neutral'
  good: boolean | null
  label: string
}

/** Tendência do KPI; nos `inverted_kpis` (sem resposta, tempo de resposta) subir é ruim. */
export function trendOf(block: Pick<AttendanceBlock, 'trends' | 'inverted_kpis'>, key: AttendanceKpi): TrendView {
  const trend = block.trends[key]
  if (!trend || trend.direction === 'neutral' || trend.delta_pct === null) return { direction: 'neutral', good: null, label: DASH }
  const up = trend.direction === 'up'
  const good = block.inverted_kpis.includes(key) ? !up : up
  const abs = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(trend.delta_pct))
  return { direction: trend.direction, good, label: `${up ? '+' : MINUS}${abs}%` }
}

/** Grade 7×24 (0 = domingo), com zero onde a API não mandou célula. */
export function heatGrid(cells: readonly HeatCell[]): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  for (const c of cells) if (c.weekday >= 0 && c.weekday < 7 && c.hour >= 0 && c.hour < 24) grid[c.weekday]![c.hour] = c.count
  return grid
}

/** Picos destacados: os `peaks` da API (empates) ou, sem eles, as células com o maior valor (> 0). */
export function peakCells(block: Pick<AttendanceBlock, 'peak' | 'peaks' | 'attendance_by_weekday_hour'>): HeatCell[] {
  if (block.peaks?.length) return block.peaks
  if (block.peak) return [block.peak]
  const max = Math.max(0, ...block.attendance_by_weekday_hour.map((c) => c.count))
  return max > 0 ? block.attendance_by_weekday_hour.filter((c) => c.count === max) : []
}

/** Nível de 0 a 4 da célula (0 = vazio). */
export const heatLevel = (count: number, max: number): number => (count <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4)))

/** Máximo de fatias numa pizza antes de agrupar o resto em "Outros". */
export const MAX_SLICES = 6

export interface Slice {
  key: string
  label: string
  value: number
  color: string | null
  others?: boolean
}

/** Ordena por valor (desc) e, acima de `limit` fatias, mantém `limit − 1` e soma o resto em "Outros". */
export function groupSlices(rows: readonly Slice[], othersLabel: string, limit = MAX_SLICES): Slice[] {
  const sorted = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
  if (sorted.length <= limit) return sorted
  const head = sorted.slice(0, limit - 1)
  const rest = sorted.slice(limit - 1)
  return [...head, { key: 'others', label: othersLabel, value: rest.reduce((n, r) => n + r.value, 0), color: null, others: true }]
}

export const USER_SORT_KEYS = ['name', 'answered', 'attending', 'resolved', 'time'] as const
export type UserSortKey = (typeof USER_SORT_KEYS)[number]
export type SortDir = 'asc' | 'desc'

const userValue = (u: AttendanceUser, key: UserSortKey): string | number | null => {
  switch (key) {
    case 'name':
      return u.user_name
    case 'answered':
      return u.answered_chats
    case 'attending':
      return u.attending_chats
    case 'resolved':
      return u.resolved_chats
    default:
      return u.average_response_seconds
  }
}

/** Ordena a tabela por atendente; nulos (tempo sem resposta) sempre no fim, nos dois sentidos. */
export function sortUsers(rows: readonly AttendanceUser[], key: UserSortKey, dir: SortDir): AttendanceUser[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const va = userValue(a, key)
    const vb = userValue(b, key)
    if (va === null || vb === null) return va === vb ? a.user_name.localeCompare(b.user_name) : va === null ? 1 : -1
    const cmp = typeof va === 'string' ? va.localeCompare(String(vb), 'pt-BR', { sensitivity: 'base' }) : va - (vb as number)
    return cmp * sign || a.user_name.localeCompare(b.user_name)
  })
}

/** Primeiro clique: nome em ordem crescente, números do maior para o menor; clicar de novo inverte. */
export function nextSort(current: { key: UserSortKey; dir: SortDir }, key: UserSortKey): { key: UserSortKey; dir: SortDir } {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'name' || key === 'time' ? 'asc' : 'desc' }
}

/** Parâmetros do `GET /api/dashboard/attendance`. */
export function attendanceParams(period: Period, connectionIds: readonly string[]): Record<string, string> {
  const q: Record<string, string> = { start_date: period.start_date, end_date: period.end_date }
  if (connectionIds.length) q.connection_ids = [...new Set(connectionIds)].join(',')
  return q
}

/** Rótulo do balde: `13:00` (por hora) ou `09/03` (por dia). */
export const bucketLabel = (bucket: string, granularity: 'hour' | 'day') => (granularity === 'hour' ? bucket.slice(11, 16) : `${bucket.slice(8, 10)}/${bucket.slice(5, 7)}`)
