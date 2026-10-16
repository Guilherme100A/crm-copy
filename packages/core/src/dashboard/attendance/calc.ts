// Métricas de atendimento (T65; 02 §3.3, §5 itens 15, 19, 37–42): agregações puras sobre as linhas de chats do
// período (uma linha por chat aberto no período). Tudo sai da MESMA lista, então as somas batem (AC-T65-04):
// Σ departamentos = Σ conexões = Σ série = Σ heatmap = new_leads; Σ answered por atendente = attended_leads.
import { eachDay } from '../sales/calc'

/** Uma linha por chat aberto no período (fuso já aplicado em bucket/weekday/hour). */
export interface AttendanceChatRow {
  chatId: string
  connectionId: string | null
  departmentId: string | null
  assignedUserId: string | null
  status: 'waiting' | 'attending' | 'resolved'
  /** `YYYY-MM-DD` local da abertura. */
  day: string
  /** `YYYY-MM-DDTHH:00` local da abertura. */
  hourBucket: string
  /** 0 = domingo … 6 = sábado (dow do Postgres), no fuso da empresa. */
  weekday: number
  hour: number
  /** Segundos até a 1ª mensagem humana (`sender_type = user`) depois da abertura; null = sem resposta humana. */
  responseSeconds: number | null
  /** Autor da 1ª resposta humana (null se não houve ou se o usuário foi removido). */
  firstReplyBy: string | null
}

export interface AttendanceNames {
  users: Map<string, string>
  departments: Map<string, { name: string; color: string | null }>
  connections: Map<string, string>
}

export interface AttendanceKpis {
  new_leads: number
  attended_leads: number
  resolved_leads: number
  unanswered_chats: number
  response_time_seconds: number | null
}

export interface HeatCell {
  weekday: number
  hour: number
  count: number
}

export interface AttendanceDetail {
  attendance_over_time: { bucket_start: string; count: number }[]
  response_time_over_time: { bucket_start: string; average_seconds: number | null; count: number }[]
  attendance_by_weekday_hour: HeatCell[]
  peak: HeatCell | null
  peaks: HeatCell[]
  leads_by_status_chart: { connection_id: string | null; connection_name: string | null; new_leads: number; attended_leads: number; resolved_leads: number }[]
  leads_by_user: { user_id: string | null; user_name: string; answered_chats: number; attending_chats: number; resolved_chats: number; average_response_seconds: number | null }[]
  attendance_by_department: { department_id: string | null; department_name: string; color: string | null; chat_count: number }[]
}

export const NO_DEPARTMENT = 'Sem departamento'
export const REMOVED_USER = 'Usuário removido'
export const ATTENDANCE_TREND_KPIS = ['new_leads', 'attended_leads', 'resolved_leads', 'unanswered_chats', 'response_time_seconds'] as const
/** KPIs em que subir é ruim (a UI inverte a cor da tendência). */
export const INVERTED_KPIS = ['unanswered_chats', 'response_time_seconds'] as const

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)

export function attendanceKpis(rows: readonly AttendanceChatRow[]): AttendanceKpis {
  const answered = rows.filter((r) => r.responseSeconds !== null)
  return {
    new_leads: rows.length,
    attended_leads: answered.length,
    resolved_leads: rows.filter((r) => r.status === 'resolved').length,
    unanswered_chats: rows.length - answered.length,
    response_time_seconds: avg(answered.map((r) => r.responseSeconds!)),
  }
}

/** Buckets do período (hora com 1 dia, senão dia), vazios com zero. */
export function bucketsOf(start: string, end: string): { granularity: 'hour' | 'day'; buckets: string[] } {
  if (start === end) return { granularity: 'hour', buckets: Array.from({ length: 24 }, (_, h) => `${start}T${String(h).padStart(2, '0')}:00`) }
  return { granularity: 'day', buckets: eachDay(start, end) }
}

export function attendanceDetail(rows: readonly AttendanceChatRow[], range: { start: string; end: string }, names: AttendanceNames): AttendanceDetail {
  const { granularity, buckets } = bucketsOf(range.start, range.end)
  const keyOf = (r: AttendanceChatRow) => (granularity === 'hour' ? r.hourBucket : r.day)

  const perBucket = new Map<string, AttendanceChatRow[]>(buckets.map((b) => [b, []]))
  for (const r of rows) perBucket.get(keyOf(r))?.push(r)

  const cells = new Map<string, HeatCell>()
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) cells.set(`${w}:${h}`, { weekday: w, hour: h, count: 0 })
  for (const r of rows) cells.get(`${r.weekday}:${r.hour}`)!.count += 1
  const heat = [...cells.values()]
  const max = Math.max(0, ...heat.map((c) => c.count))
  const peaks = max > 0 ? heat.filter((c) => c.count === max) : []

  const group = <K>(key: (r: AttendanceChatRow) => K) => {
    const m = new Map<K, AttendanceChatRow[]>()
    for (const r of rows) {
      const k = key(r)
      m.set(k, [...(m.get(k) ?? []), r])
    }
    return m
  }

  const byConnection = [...group((r) => r.connectionId)].map(([id, rs]) => {
    const k = attendanceKpis(rs)
    return { connection_id: id, connection_name: id ? (names.connections.get(id) ?? null) : null, new_leads: k.new_leads, attended_leads: k.attended_leads, resolved_leads: k.resolved_leads }
  })
  byConnection.sort((a, b) => b.new_leads - a.new_leads || (a.connection_name ?? '').localeCompare(b.connection_name ?? '', 'pt-BR'))

  // Atendente: "Atendidos"/tempo = 1ªs respostas escritas por ele; "Em atendimento"/"Resolvidos" = chats do período
  // atribuídos a ele agora (02 §3.3).
  const users = new Map<string | null, { answered: number[]; attending: number; resolved: number }>()
  const slot = (id: string | null) => {
    if (!users.has(id)) users.set(id, { answered: [], attending: 0, resolved: 0 })
    return users.get(id)!
  }
  for (const r of rows) {
    if (r.responseSeconds !== null) slot(r.firstReplyBy && names.users.has(r.firstReplyBy) ? r.firstReplyBy : null).answered.push(r.responseSeconds)
    if (r.assignedUserId && r.status === 'attending') slot(r.assignedUserId).attending += 1
    if (r.assignedUserId && r.status === 'resolved') slot(r.assignedUserId).resolved += 1
  }
  const byUser = [...users]
    .map(([id, u]) => ({
      user_id: id,
      user_name: id ? (names.users.get(id) ?? REMOVED_USER) : REMOVED_USER,
      answered_chats: u.answered.length,
      attending_chats: u.attending,
      resolved_chats: u.resolved,
      average_response_seconds: avg(u.answered),
    }))
    .filter((u) => u.answered_chats + u.attending_chats + u.resolved_chats > 0)
    .sort((a, b) => a.user_name.localeCompare(b.user_name, 'pt-BR'))

  const byDepartment = [...group((r) => (r.departmentId && names.departments.has(r.departmentId) ? r.departmentId : null))]
    .map(([id, rs]) => ({
      department_id: id,
      department_name: id ? names.departments.get(id)!.name : NO_DEPARTMENT,
      color: id ? names.departments.get(id)!.color : null,
      chat_count: rs.length,
    }))
    // Mais chats primeiro; no empate, "Sem departamento" por último e os demais por nome.
    .sort((a, b) => b.chat_count - a.chat_count || Number(a.department_id === null) - Number(b.department_id === null) || a.department_name.localeCompare(b.department_name, 'pt-BR'))

  return {
    attendance_over_time: buckets.map((b) => ({ bucket_start: b, count: perBucket.get(b)!.length })),
    response_time_over_time: buckets.map((b) => {
      const answered = perBucket.get(b)!.filter((r) => r.responseSeconds !== null)
      return { bucket_start: b, average_seconds: avg(answered.map((r) => r.responseSeconds!)), count: answered.length }
    }),
    attendance_by_weekday_hour: heat,
    peak: peaks[0] ?? null,
    peaks,
    leads_by_status_chart: byConnection,
    leads_by_user: byUser,
    attendance_by_department: byDepartment,
  }
}
