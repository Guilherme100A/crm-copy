// Filtros do dashboard na URL (T78; 02 §5.7–5.14): aba, preset de período (datas no fuso da EMPRESA), personalizado,
// conexões, produtos e grupo aplicado. `periodOf` traduz para `start_date`/`end_date` da T55 (inclusivos, ≤ 366 dias).
import { z } from 'zod'

export const PRESETS = ['today', 'yesterday', '7d', '30d', 'month', 'custom'] as const
export type Preset = (typeof PRESETS)[number]

export const DASHBOARD_TABS = ['sales', 'attendance'] as const
export type DashboardTab = (typeof DASHBOARD_TABS)[number]

export const MAX_RANGE_DAYS = 366

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const optDate = z.string().regex(DATE_RE).optional().catch(undefined)
const optIds = z.array(z.string().trim().min(1).max(64)).max(500).optional().catch(undefined)

export const dashboardSearchSchema = z.object({
  tab: z.enum(DASHBOARD_TABS).optional().catch(undefined),
  preset: z.enum(PRESETS).optional().catch(undefined),
  start_date: optDate,
  end_date: optDate,
  connection_ids: optIds,
  product_ids: optIds,
  group: z.string().trim().min(1).max(64).optional().catch(undefined),
})
export type DashboardSearch = z.infer<typeof dashboardSearchSchema>

/** `YYYY-MM-DD` de `now` no fuso `tz`. */
export function todayIn(tz: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Hora (0–23) de `now` no fuso `tz`. */
export function hourIn(tz: string, now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now)
  return Number(h) % 24
}

/** Soma dias a uma data civil `YYYY-MM-DD` (sem fuso). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

/** Dias do intervalo inclusivo. */
export function rangeDays(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)
  return Math.round(ms / 86_400_000) + 1
}

export interface Period {
  start_date: string
  end_date: string
}

export type PeriodProblem = 'incomplete' | 'inverted' | 'too_long'

export function customProblem(start: string | undefined, end: string | undefined): PeriodProblem | null {
  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) return 'incomplete'
  if (end < start) return 'inverted'
  if (rangeDays(start, end) > MAX_RANGE_DAYS) return 'too_long'
  return null
}

/** Período do preset no fuso da empresa (7 dias = hoje−6..hoje). Personalizado inválido cai em hoje. */
export function periodOf(s: Pick<DashboardSearch, 'preset' | 'start_date' | 'end_date'>, tz: string, now: Date = new Date()): Period {
  const today = todayIn(tz, now)
  switch (s.preset ?? 'today') {
    case 'yesterday': {
      const y = addDays(today, -1)
      return { start_date: y, end_date: y }
    }
    case '7d':
      return { start_date: addDays(today, -6), end_date: today }
    case '30d':
      return { start_date: addDays(today, -29), end_date: today }
    case 'month':
      return { start_date: `${today.slice(0, 8)}01`, end_date: today }
    case 'custom':
      if (!customProblem(s.start_date, s.end_date)) return { start_date: s.start_date!, end_date: s.end_date! }
      return { start_date: today, end_date: today }
    default:
      return { start_date: today, end_date: today }
  }
}

/** Parâmetros do `GET /api/dashboard`. */
export function dashboardQueryOf(s: DashboardSearch, tz: string, now?: Date): Record<string, string> {
  const p = periodOf(s, tz, now)
  const q: Record<string, string> = { start_date: p.start_date, end_date: p.end_date }
  if (s.connection_ids?.length) q.connection_ids = [...new Set(s.connection_ids)].join(',')
  if (s.product_ids?.length) q.product_ids = [...new Set(s.product_ids)].join(',')
  return q
}

/** Aba efetiva: sem `dashboard.sales` sempre Atendimento (AC-T78-04). */
export const tabOf = (s: Pick<DashboardSearch, 'tab'>, canSales: boolean): DashboardTab => (canSales ? (s.tab ?? 'sales') : 'attendance')

/** Remove chaves vazias. */
export function cleanSearch(s: DashboardSearch): DashboardSearch {
  const out: DashboardSearch = {}
  if (s.tab) out.tab = s.tab
  if (s.preset && s.preset !== 'today') out.preset = s.preset
  if (s.preset === 'custom') {
    if (s.start_date) out.start_date = s.start_date
    if (s.end_date) out.end_date = s.end_date
  }
  if (s.connection_ids?.length) out.connection_ids = [...new Set(s.connection_ids)]
  if (s.product_ids?.length) out.product_ids = [...new Set(s.product_ids)]
  if (s.group) out.group = s.group
  return out
}

/** Saudação pela hora local da empresa (02 §5.1): < 12 bom dia, < 18 boa tarde, senão boa noite. */
export const greetingKey = (hour: number): 'morning' | 'afternoon' | 'evening' => (hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening')

/** Primeiro nome do usuário, ou a parte local do e-mail. */
export function displayName(user: { name?: string | null; email?: string | null }): string {
  const name = user.name?.trim()
  if (name) return name.split(/\s+/)[0]!
  return (user.email ?? '').split('@')[0] ?? ''
}
