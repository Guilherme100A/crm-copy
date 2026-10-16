// Dashboard de atendimento (T65; 02 §3.3, §5): mesmo padrão da T55 (fuso de `companies.time_zone`, datas inclusivas,
// período anterior de mesma duração, cache de 5 min com `force_refresh`), com intervalo máximo de 92 dias (02 §5 #19).
// Base = chats com `opened_at` no período; "resposta humana" = 1ª mensagem `sender_type = 'user'` a partir da
// abertura (bot/IA/fluxo/sistema não contam, AC-T65-02). Fórmulas fechadas no README.md deste módulo.
import { and, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm'
import { chats, companies, connections, departments, DEFAULT_TIME_ZONE, users, type Database } from '@crm/db'
import { addDays, daysInclusive, isValidDate, previousRange, todayIn, trendOf, type Trend } from '../sales/calc'
import { DASHBOARD_CACHE_TTL_MS, DashboardQueryError, type DashboardCache } from '../sales/service'
import { attendanceDetail, attendanceKpis, ATTENDANCE_TREND_KPIS, INVERTED_KPIS, type AttendanceChatRow, type AttendanceDetail, type AttendanceKpis } from './calc'

/** Intervalo máximo do atendimento (02 §5 #19). */
export const ATTENDANCE_MAX_RANGE_DAYS = 92

export interface AttendanceFilters {
  start_date?: string
  end_date?: string
  connection_ids?: string[]
}

export type AttendanceBlock = AttendanceKpis &
  AttendanceDetail & {
    first_reply_since: string | null
    previous: AttendanceKpis
    trends: Record<(typeof ATTENDANCE_TREND_KPIS)[number], Trend>
    inverted_kpis: readonly string[]
  }

export interface AttendanceDashboardResult {
  range: { start_date: string; end_date: string; time_zone: string; granularity: 'hour' | 'day' }
  previous_range: { start_date: string; end_date: string }
  cached: boolean
  computed_at: string
  attendance: AttendanceBlock
}

export interface AttendanceDashboardServiceOptions {
  db: Database
  cache?: DashboardCache
  cacheTtlMs?: number
  now?: () => Date
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uniq = (a: string[] | undefined) => [...new Set((a ?? []).map((s) => s.trim()).filter(Boolean))].sort()

export class AttendanceDashboardService {
  constructor(private readonly opts: AttendanceDashboardServiceOptions) {}

  private now() {
    return this.opts.now?.() ?? new Date()
  }

  async timeZone(companyId: string): Promise<string> {
    const [c] = await this.opts.db.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId)).limit(1)
    return c?.tz || DEFAULT_TIME_ZONE
  }

  async get(companyId: string, filters: AttendanceFilters, o: { forceRefresh?: boolean } = {}): Promise<AttendanceDashboardResult> {
    const tz = await this.timeZone(companyId)
    const today = todayIn(tz, this.now())
    const start = filters.start_date ?? today
    const end = filters.end_date ?? today
    const connectionIds = uniq(filters.connection_ids)
    const errors: { path: string; message: string }[] = []
    if (!isValidDate(start)) errors.push({ path: 'start_date', message: 'Use YYYY-MM-DD' })
    if (!isValidDate(end)) errors.push({ path: 'end_date', message: 'Use YYYY-MM-DD' })
    if (!errors.length && end < start) errors.push({ path: 'end_date', message: 'O fim é antes do início' })
    if (!errors.length && daysInclusive(start, end) > ATTENDANCE_MAX_RANGE_DAYS) errors.push({ path: 'end_date', message: `Atendimento limitado a ${ATTENDANCE_MAX_RANGE_DAYS} dias` })
    if (connectionIds.some((id) => !UUID_RE.test(id))) errors.push({ path: 'connection_ids', message: 'Ids de conexão inválidos' })
    if (errors.length) throw new DashboardQueryError(errors)

    const prev = previousRange(start, end)
    const base = {
      range: { start_date: start, end_date: end, time_zone: tz, granularity: (start === end ? 'hour' : 'day') as 'hour' | 'day' },
      previous_range: prev,
    }
    const key = `crm:dashboard:attendance:v1:${companyId}:${start}:${end}:${tz}:c=${connectionIds.join(',')}`
    const cache = this.opts.cache
    if (cache && !o.forceRefresh) {
      const hit = await cache.get(key).catch(() => null)
      if (hit) {
        const parsed = JSON.parse(hit) as { computed_at: string; attendance: AttendanceBlock }
        return { ...base, cached: true, computed_at: parsed.computed_at, attendance: parsed.attendance }
      }
    }
    const [cur, before, since] = await Promise.all([
      this.rows(companyId, { start, end, tz }, connectionIds),
      this.rows(companyId, { start: prev.start_date, end: prev.end_date, tz }, connectionIds),
      this.firstReplySince(companyId, tz),
    ])
    const userIds = [...new Set(cur.flatMap((r) => [r.assignedUserId, r.firstReplyBy]).filter((x): x is string => Boolean(x)))]
    const names = await this.names(companyId, userIds)
    const kpis = attendanceKpis(cur)
    const previous = attendanceKpis(before)
    const trends = Object.fromEntries(ATTENDANCE_TREND_KPIS.map((k) => [k, trendOf(kpis[k], previous[k])])) as AttendanceBlock['trends']
    const attendance: AttendanceBlock = { ...kpis, first_reply_since: since, ...attendanceDetail(cur, { start, end }, names), previous, trends, inverted_kpis: INVERTED_KPIS }
    const computed_at = this.now().toISOString()
    if (cache) await cache.set(key, JSON.stringify({ computed_at, attendance }), this.opts.cacheTtlMs ?? DASHBOARD_CACHE_TTL_MS).catch(() => undefined)
    return { ...base, cached: false, computed_at, attendance }
  }

  /** Uma linha por chat aberto no período, com a 1ª resposta humana depois da abertura. */
  private async rows(companyId: string, range: { start: string; end: string; tz: string }, connectionIds: string[]): Promise<AttendanceChatRow[]> {
    const lo = sql`(${range.start}::date)::timestamp at time zone ${range.tz}`
    const hi = sql`(${addDays(range.end, 1)}::date)::timestamp at time zone ${range.tz}`
    const where: SQL[] = [eq(chats.companyId, companyId), gte(chats.openedAt, lo), lt(chats.openedAt, hi)]
    if (connectionIds.length) where.push(inArray(chats.connectionId, connectionIds))
    const local = sql`(${chats.openedAt} at time zone ${range.tz})`
    const result = await this.opts.db.execute(sql`
      select ${chats.id} as chat_id, ${chats.connectionId} as connection_id, ${chats.departmentId} as department_id,
             ${chats.assignedUserId} as assigned_user_id, ${chats.status} as status,
             to_char(${local}, 'YYYY-MM-DD') as day, to_char(${local}, 'YYYY-MM-DD"T"HH24:00') as hour_bucket,
             extract(dow from ${local})::int as weekday, extract(hour from ${local})::int as hour,
             extract(epoch from (fr.at - ${chats.openedAt}))::float8 as response_seconds, fr.user_id as first_reply_by
      from ${chats}
      left join lateral (
        select coalesce(m.sent_at, m.created_at) as at, m.sender_user_id as user_id
        from crm.messages m
        where m.chat_id = ${chats.id} and m.sender_type = 'user' and coalesce(m.sent_at, m.created_at) >= ${chats.openedAt}
        order by coalesce(m.sent_at, m.created_at) asc
        limit 1
      ) fr on true
      where ${and(...where)}`)
    return (result.rows as Record<string, unknown>[]).map((r) => ({
      chatId: String(r.chat_id),
      connectionId: (r.connection_id as string | null) ?? null,
      departmentId: (r.department_id as string | null) ?? null,
      assignedUserId: (r.assigned_user_id as string | null) ?? null,
      status: r.status as AttendanceChatRow['status'],
      day: String(r.day),
      hourBucket: String(r.hour_bucket),
      weekday: Number(r.weekday),
      hour: Number(r.hour),
      responseSeconds: r.response_seconds === null || r.response_seconds === undefined ? null : Math.max(0, Number(r.response_seconds)),
      firstReplyBy: (r.first_reply_by as string | null) ?? null,
    }))
  }

  /** Nomes dos usuários que aparecem nas linhas (atribuídos ou autores da 1ª resposta), departamentos e conexões. */
  private async names(companyId: string, userIds: string[]) {
    const [us, deps, conns] = await Promise.all([
      userIds.length ? this.opts.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : Promise.resolve([]),
      this.opts.db.select({ id: departments.id, name: departments.name, color: departments.color }).from(departments).where(eq(departments.companyId, companyId)),
      this.opts.db.select({ id: connections.id, name: connections.name }).from(connections).where(eq(connections.companyId, companyId)),
    ])
    return {
      users: new Map(us.map((u) => [u.id, u.name])),
      departments: new Map(deps.map((d) => [d.id, { name: d.name, color: d.color }])),
      connections: new Map(conns.map((c) => [c.id, c.name])),
    }
  }

  /** Data (no fuso) da 1ª resposta humana da empresa: desde quando a métrica existe. */
  private async firstReplySince(companyId: string, tz: string): Promise<string | null> {
    const r = await this.opts.db.execute(
      sql`select to_char(min(coalesce(m.sent_at, m.created_at)) at time zone ${tz}, 'YYYY-MM-DD') as d from crm.messages m where m.company_id = ${companyId} and m.sender_type = 'user'`,
    )
    return ((r.rows[0] as { d: string | null } | undefined)?.d ?? null) || null
  }
}

