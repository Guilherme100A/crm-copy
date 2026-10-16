import { describe, expect, it } from 'vitest'
import { attendanceDetail, attendanceKpis, bucketsOf, NO_DEPARTMENT, REMOVED_USER, type AttendanceChatRow } from './calc'

const row = (over: Partial<AttendanceChatRow>): AttendanceChatRow => ({
  chatId: Math.random().toString(36),
  connectionId: 'c1',
  departmentId: null,
  assignedUserId: null,
  status: 'waiting',
  day: '2026-06-01',
  hourBucket: '2026-06-01T10:00',
  weekday: 1,
  hour: 10,
  responseSeconds: null,
  firstReplyBy: null,
  ...over,
})
const names = {
  users: new Map([
    ['u1', 'Bruno'],
    ['u2', 'Ana'],
  ]),
  departments: new Map([['d1', { name: 'Vendas', color: '#FF0000' }]]),
  connections: new Map([
    ['c1', 'Principal'],
    ['c2', 'Suporte'],
  ]),
}

describe('attendanceKpis', () => {
  it('novos, atendidos (resposta humana), resolvidos, sem resposta e média arredondada só dos atendidos', () => {
    const rows = [row({ responseSeconds: 60 }), row({ responseSeconds: 121, status: 'resolved' }), row({ status: 'resolved' }), row({})]
    expect(attendanceKpis(rows)).toEqual({ new_leads: 4, attended_leads: 2, resolved_leads: 2, unanswered_chats: 2, response_time_seconds: 91 })
    expect(attendanceKpis([]).response_time_seconds).toBeNull()
  })
})

describe('attendanceDetail', () => {
  const rows = [
    row({ connectionId: 'c1', departmentId: 'd1', assignedUserId: 'u1', status: 'attending', responseSeconds: 30, firstReplyBy: 'u1', weekday: 1, hour: 10 }),
    row({ connectionId: 'c1', departmentId: 'd1', assignedUserId: 'u2', status: 'resolved', responseSeconds: 90, firstReplyBy: 'u1', weekday: 1, hour: 10, day: '2026-06-02', hourBucket: '2026-06-02T10:00' }),
    row({ connectionId: 'c2', assignedUserId: 'u2', status: 'resolved', responseSeconds: 10, firstReplyBy: 'gone', weekday: 3, hour: 22, day: '2026-06-03', hourBucket: '2026-06-03T22:00' }),
    row({ connectionId: 'c2', weekday: 3, hour: 22, day: '2026-06-03', hourBucket: '2026-06-03T22:00' }),
  ]
  const d = attendanceDetail(rows, { start: '2026-06-01', end: '2026-06-03' }, names)
  const k = attendanceKpis(rows)

  it('somas batem com a visão geral (AC-T65-04)', () => {
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
    expect(sum(d.attendance_over_time.map((b) => b.count))).toBe(k.new_leads)
    expect(sum(d.attendance_by_weekday_hour.map((c) => c.count))).toBe(k.new_leads)
    expect(sum(d.attendance_by_department.map((x) => x.chat_count))).toBe(k.new_leads)
    expect(sum(d.leads_by_status_chart.map((x) => x.new_leads))).toBe(k.new_leads)
    expect(sum(d.leads_by_status_chart.map((x) => x.attended_leads))).toBe(k.attended_leads)
    expect(sum(d.leads_by_status_chart.map((x) => x.resolved_leads))).toBe(k.resolved_leads)
    expect(sum(d.leads_by_user.map((u) => u.answered_chats))).toBe(k.attended_leads)
  })

  it('série por dia com zeros, média por bucket, heatmap 7×24 e pico com empate', () => {
    expect(d.attendance_over_time).toEqual([
      { bucket_start: '2026-06-01', count: 1 },
      { bucket_start: '2026-06-02', count: 1 },
      { bucket_start: '2026-06-03', count: 2 },
    ])
    expect(d.response_time_over_time[2]).toEqual({ bucket_start: '2026-06-03', average_seconds: 10, count: 1 })
    expect(d.attendance_by_weekday_hour).toHaveLength(168)
    expect(d.peaks).toEqual([
      { weekday: 1, hour: 10, count: 2 },
      { weekday: 3, hour: 22, count: 2 },
    ])
    expect(d.peak).toEqual({ weekday: 1, hour: 10, count: 2 })
    expect(attendanceDetail([], { start: '2026-06-01', end: '2026-06-01' }, names).peak).toBeNull()
  })

  it('por atendente (1ªs respostas dele; atribuídos agora), por departamento e por conexão', () => {
    expect(d.leads_by_user).toEqual([
      { user_id: 'u2', user_name: 'Ana', answered_chats: 0, attending_chats: 0, resolved_chats: 2, average_response_seconds: null },
      { user_id: 'u1', user_name: 'Bruno', answered_chats: 2, attending_chats: 1, resolved_chats: 0, average_response_seconds: 60 },
      { user_id: null, user_name: REMOVED_USER, answered_chats: 1, attending_chats: 0, resolved_chats: 0, average_response_seconds: 10 },
    ])
    expect(d.attendance_by_department).toEqual([
      { department_id: 'd1', department_name: 'Vendas', color: '#FF0000', chat_count: 2 },
      { department_id: null, department_name: NO_DEPARTMENT, color: null, chat_count: 2 },
    ])
    expect(d.leads_by_status_chart.map((c) => c.connection_name)).toEqual(['Principal', 'Suporte'])
  })

  it('1 dia → 24 buckets de hora', () => {
    const b = bucketsOf('2026-06-01', '2026-06-01')
    expect(b.granularity).toBe('hour')
    expect(b.buckets).toHaveLength(24)
    expect(b.buckets[9]).toBe('2026-06-01T09:00')
  })
})
