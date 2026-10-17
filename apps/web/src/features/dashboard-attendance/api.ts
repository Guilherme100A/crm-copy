// `GET /api/dashboard/attendance` (T65; perm `dashboard.support`): KPIs, séries, mapa de calor, por conexão, por
// atendente e por departamento. Período > 92 dias → 422 (o cliente avisa antes de chamar). "Atualizar" = `force_refresh`.
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import type { Trend } from '@/features/dashboard/api'
import { api } from '@/lib/http'

export interface HeatCell {
  weekday: number
  hour: number
  count: number
}

export interface AttendanceUser {
  user_id: string | null
  user_name: string
  answered_chats: number
  attending_chats: number
  resolved_chats: number
  average_response_seconds: number | null
}

export interface AttendanceDepartment {
  department_id: string | null
  department_name: string
  color: string | null
  chat_count: number
}

export interface AttendanceKpis {
  new_leads: number
  attended_leads: number
  resolved_leads: number
  unanswered_chats: number
  response_time_seconds: number | null
}

export interface AttendanceBlock extends AttendanceKpis {
  first_reply_since: string | null
  previous: AttendanceKpis
  trends: Partial<Record<keyof AttendanceKpis, Trend>>
  inverted_kpis: readonly string[]
  attendance_over_time: { bucket_start: string; count: number }[]
  response_time_over_time: { bucket_start: string; average_seconds: number | null; count: number }[]
  attendance_by_weekday_hour: HeatCell[]
  peak: HeatCell | null
  peaks: HeatCell[]
  leads_by_status_chart: { connection_id: string | null; connection_name: string | null; new_leads: number; attended_leads: number; resolved_leads: number }[]
  leads_by_user: AttendanceUser[]
  attendance_by_department: AttendanceDepartment[]
}

export interface AttendanceResult {
  range: { start_date: string; end_date: string; time_zone: string; granularity: 'hour' | 'day' }
  previous_range: { start_date: string; end_date: string }
  cached: boolean
  computed_at: string
  attendance: AttendanceBlock
}

export const attendanceKey = ['dashboard', 'attendance'] as const
export const attendanceQuery = (params: Record<string, string>) =>
  queryOptions({
    queryKey: [...attendanceKey, params] as const,
    queryFn: () => api.get<AttendanceResult>('/api/dashboard/attendance', { query: params }),
    placeholderData: keepPreviousData,
    staleTime: 0,
    // O 422 do limite não melhora repetindo.
    retry: false,
  })

export const refreshAttendance = (params: Record<string, string>) => api.get<AttendanceResult>('/api/dashboard/attendance', { query: { ...params, force_refresh: '1' } })
