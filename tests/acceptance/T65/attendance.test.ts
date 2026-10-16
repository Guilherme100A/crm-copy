// AC-T65-01..04: métricas de atendimento (GET /api/dashboard/attendance) contra uma fixture calculada à mão,
// no fuso da empresa (America/Sao_Paulo, −03:00).
//
// Período 2026-06-01 (segunda) .. 2026-06-07 (domingo). Atendentes: Ana (owner) e Bruno (membro).
//   ch1  C1  seg 01/06 10:00  bot 30 s, IA 60 s, Ana 300 s, Bruno 400 s   attending (Ana)   dep. Vendas
//   ch2  C1  seg 01/06 10:20  Bruno 120 s                                   resolved (Bruno)  dep. Vendas
//   ch5  C1  seg 01/06 10:40  flow, system, IA (sem humano)                 attending (Bruno) dep. Vendas
//   ch3  C2  qua 03/06 23:30  só bot (= 04/06 02:30 UTC)                    waiting           sem dep.
//   ch4  C2  dom 07/06 00:10  Ana 600 s                                     resolved (Ana)    sem dep.
//   ch7  C2  dom 07/06 22:30  sem resposta (= 08/06 01:30 UTC)              waiting           sem dep.
//   ch6  C1  dom 31/05 23:50  Ana 60 s (= 01/06 02:50 UTC: fica no período ANTERIOR)
// Totais: novos 6, atendidos 3 (ch1, ch2, ch4), sem resposta 3, resolvidos 2, tempo médio round((300+120+600)/3) = 340.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attendance, attPath, newConnection, newDepartment, newMember, newOwner, seedChat, setTimeZone, startEnv, sum, type Env, type User } from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const RANGE = { start: '2026-06-01', end: '2026-06-07' }

let env: Env
let ana: User
let bruno: User
let c1: string
let c2: string
let vendas: string
beforeAll(async () => {
  env = await startEnv()
  ana = await newOwner(env, 'Ana Atendente')
  bruno = await newMember(env, ana.companyId, ['chat.view'], 'Bruno Suporte')
  const co = ana.companyId
  await setTimeZone(env, co, 'America/Sao_Paulo')
  c1 = await newConnection(env, co, 'Comercial')
  c2 = await newConnection(env, co, 'Suporte')
  vendas = await newDepartment(env, co, 'Vendas', '#FF8800')
  const A = ana.userId
  const B = bruno.userId
  await seedChat(env, co, {
    connectionId: c1,
    openedAt: '2026-06-01T10:00:00-03:00',
    status: 'attending',
    assignedUserId: A,
    departmentId: vendas,
    messages: [['contact', 0], ['bot', 30], ['ai', 60], ['user', 300, A], ['user', 400, B]],
  })
  await seedChat(env, co, { connectionId: c1, openedAt: '2026-06-01T10:20:00-03:00', status: 'resolved', assignedUserId: B, departmentId: vendas, messages: [['contact', 0], ['user', 120, B]] })
  await seedChat(env, co, {
    connectionId: c1,
    openedAt: '2026-06-01T10:40:00-03:00',
    status: 'attending',
    assignedUserId: B,
    departmentId: vendas,
    messages: [['contact', 0], ['flow', 5], ['system', 6], ['ai', 20]],
  })
  await seedChat(env, co, { connectionId: c2, openedAt: '2026-06-03T23:30:00-03:00', messages: [['contact', 0], ['bot', 10]] })
  await seedChat(env, co, { connectionId: c2, openedAt: '2026-06-07T00:10:00-03:00', status: 'resolved', assignedUserId: A, messages: [['contact', 0], ['user', 600, A]] })
  await seedChat(env, co, { connectionId: c2, openedAt: '2026-06-07T22:30:00-03:00', messages: [['contact', 0]] })
  await seedChat(env, co, { connectionId: c1, openedAt: '2026-05-31T23:50:00-03:00', status: 'resolved', assignedUserId: A, messages: [['contact', 0], ['user', 60, A]] })
})
afterAll(async () => {
  await env?.close()
})

describe('T65 dashboard de atendimento', () => {
  it('AC-T65-01 novos, atendidos, resolvidos e sem resposta batem com a fixture no fuso da empresa', async () => {
    const body = await attendance(ana, RANGE)
    expect(body.range).toMatchObject({ start_date: RANGE.start, end_date: RANGE.end, time_zone: 'America/Sao_Paulo', granularity: 'day' })
    expect(body.attendance).toMatchObject({ new_leads: 6, attended_leads: 3, resolved_leads: 2, unanswered_chats: 3 })
    // série por dia (abertura no fuso): soma = novos
    const series = Object.fromEntries(body.attendance.attendance_over_time.map((b: Any) => [String(b.bucket_start).slice(0, 10), b.count]))
    expect(series).toEqual({ '2026-06-01': 3, '2026-06-02': 0, '2026-06-03': 1, '2026-06-04': 0, '2026-06-05': 0, '2026-06-06': 0, '2026-06-07': 2 })
  })

  it('AC-T65-01 um dia só usa buckets por hora no fuso; filtro de conexão; período anterior', async () => {
    const day = await attendance(ana, { start: '2026-06-07', end: '2026-06-07' })
    expect(day.range.granularity).toBe('hour')
    expect(day.attendance).toMatchObject({ new_leads: 2, attended_leads: 1, resolved_leads: 1, unanswered_chats: 1 })
    expect(day.attendance.attendance_over_time).toHaveLength(24)
    const byHour = day.attendance.attendance_over_time.filter((b: Any) => b.count > 0).map((b: Any) => [String(b.bucket_start).slice(11, 13), b.count])
    expect(byHour).toEqual([
      ['00', 1],
      ['22', 1],
    ])

    const onlyC2 = await attendance(ana, { ...RANGE, connectionIds: [c2] })
    expect(onlyC2.attendance).toMatchObject({ new_leads: 3, attended_leads: 1, resolved_leads: 1, unanswered_chats: 2, response_time_seconds: 600 })

    const body = await attendance(ana, RANGE)
    expect(body.previous_range).toMatchObject({ start_date: '2026-05-25', end_date: '2026-05-31' })
    expect(body.attendance.previous).toMatchObject({ new_leads: 1, attended_leads: 1, resolved_leads: 1, unanswered_chats: 0, response_time_seconds: 60 })
    expect(body.attendance.inverted_kpis).toEqual(expect.arrayContaining(['unanswered_chats', 'response_time_seconds']))
  })

  it('AC-T65-01 período acima de 92 dias, fim antes do início ou data inválida → 422', async () => {
    const ok = await ana.c.get(attPath({ start: '2026-01-01', end: '2026-04-01', force: true })) // 91 dias
    expect(ok.status, ok.text).toBe(200)
    for (const [start, end, field] of [
      ['2026-01-01', '2026-04-04', 'end_date'], // 94 dias
      ['2026-01-01', '2026-12-31', 'end_date'],
      ['2026-06-07', '2026-06-01', 'end_date'],
      ['2026-13-40', '2026-06-01', 'start_date'],
    ]) {
      const res = await ana.c.get(attPath({ start: start!, end: end!, force: true }))
      expect(res.status, `${start}..${end} → ${res.text}`).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      const paths = (res.body.error.details?.fields ?? []).map((f: Any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))
      expect(paths, `${start}..${end}`).toContain(field)
    }
  })

  it('AC-T65-01 exige dashboard.support (dashboard.sales sozinho → 403); cache de 5 min e force_refresh', async () => {
    const salesOnly = await newMember(env, ana.companyId, ['dashboard.sales'])
    expect((await salesOnly.c.get(attPath(RANGE))).status).toBe(403)
    const support = await newMember(env, ana.companyId, ['dashboard.support'])
    const res = await support.c.get(attPath({ ...RANGE, force: true }))
    expect(res.status, res.text).toBe(200)
    expect(res.body.attendance.new_leads).toBe(6)

    // empresa própria: o chat novo não altera a fixture compartilhada
    const own = await newOwner(env)
    const conn = await newConnection(env, own.companyId, 'Cache')
    await seedChat(env, own.companyId, { connectionId: conn, openedAt: '2026-06-03T12:00:00-03:00' })
    const first = await own.c.get(attPath({ start: '2026-06-02', end: '2026-06-06', force: true }))
    expect(first.body.cached).toBe(false)
    expect(first.body.attendance.new_leads).toBe(1)
    // chat novo dentro do período: com cache o número não muda; com force_refresh muda
    await seedChat(env, own.companyId, { connectionId: conn, openedAt: '2026-06-05T12:00:00-03:00' })
    const cached = await own.c.get(attPath({ start: '2026-06-02', end: '2026-06-06' }))
    expect(cached.body.cached).toBe(true)
    expect(cached.body.attendance.new_leads).toBe(1)
    const fresh = await own.c.get(attPath({ start: '2026-06-02', end: '2026-06-06', force: true }))
    expect(fresh.body.cached).toBe(false)
    expect(fresh.body.attendance.new_leads).toBe(2)
  })

  it('AC-T65-02 tempo de 1ª resposta conta só humanos; bot/IA não contam; chat sem resposta fica fora da média', async () => {
    const { attendance: a } = await attendance(ana, RANGE)
    // ch1: bot (30 s) e IA (60 s) ignorados → 300 s; ch2 120 s; ch4 600 s; ch3/ch5/ch7 fora da média
    expect(a.response_time_seconds).toBe(340)
    expect(a.first_reply_since).toBe('2026-05-31')
    const rt = Object.fromEntries(a.response_time_over_time.map((b: Any) => [String(b.bucket_start).slice(0, 10), b.average_seconds]))
    expect(rt['2026-06-01']).toBe(210)
    expect(rt['2026-06-07']).toBe(600)
    expect(rt['2026-06-03'] ?? null).toBeNull()
  })

  it('AC-T65-02 empresa só com bot/IA/flow: nenhum atendido e tempo de resposta null', async () => {
    const other = await newOwner(env)
    const conn = await newConnection(env, other.companyId, 'Bot')
    await seedChat(env, other.companyId, { connectionId: conn, openedAt: '2026-06-02T09:00:00-03:00', messages: [['contact', 0], ['bot', 1], ['ai', 2], ['flow', 3], ['system', 4]] })
    const { attendance: a } = await attendance(other, RANGE)
    expect(a).toMatchObject({ new_leads: 1, attended_leads: 0, unanswered_chats: 1, response_time_seconds: null, first_reply_since: null })
    expect(a.leads_by_user.filter((u: Any) => u.answered_chats > 0)).toEqual([])
  })

  it('AC-T65-03 mapa de calor dia × hora no fuso da empresa e pico identificado', async () => {
    const { attendance: a } = await attendance(ana, RANGE)
    expect(a.attendance_by_weekday_hour).toHaveLength(168)
    const cell = (wd: number, h: number) => a.attendance_by_weekday_hour.find((c: Any) => c.weekday === wd && c.hour === h)?.count
    expect(cell(1, 10)).toBe(3) // segunda 10h: ch1, ch2, ch5
    expect(cell(3, 23)).toBe(1) // quarta 23h (UTC seria quinta 02h)
    expect(cell(0, 0)).toBe(1) // domingo 00h
    expect(cell(0, 22)).toBe(1) // domingo 22h (UTC seria segunda 01h)
    expect(cell(4, 2)).toBe(0)
    expect(sum(a.attendance_by_weekday_hour, 'count')).toBe(6)
    expect(a.peak).toEqual({ weekday: 1, hour: 10, count: 3 })
    expect(a.peaks).toEqual([{ weekday: 1, hour: 10, count: 3 }])
  })

  it('AC-T65-03 outro fuso desloca dia e hora; empate no pico → menor dia e menor hora', async () => {
    // UTC está em COMPANY_TIME_ZONES e difere 3 h de São Paulo; gravado por SQL e conferido em range.time_zone
    const utc = await newOwner(env)
    await setTimeZone(env, utc.companyId, 'UTC')
    const [co] = await env.q(`SELECT time_zone FROM crm.companies WHERE id = $1`, [utc.companyId])
    expect(co.time_zone).toBe('UTC')
    const conn = await newConnection(env, utc.companyId, 'UTC')
    // terça 02/06 08h UTC (2 chats; em SP seria 05h); quarta 03/06 05h UTC (2 chats; em SP 02h);
    // quinta 04/06 01h UTC (1 chat; em SP seria quarta 22h)
    for (const at of ['2026-06-02T08:30:00Z', '2026-06-02T08:40:00Z', '2026-06-03T05:00:00Z', '2026-06-03T05:10:00Z', '2026-06-04T01:00:00Z'])
      await seedChat(env, utc.companyId, { connectionId: conn, openedAt: at })
    const { attendance: a, range } = await attendance(utc, { start: '2026-06-01', end: '2026-06-07' })
    expect(range.time_zone).toBe('UTC')
    const cell = (wd: number, h: number) => a.attendance_by_weekday_hour.find((c: Any) => c.weekday === wd && c.hour === h)?.count
    expect(cell(2, 8)).toBe(2)
    expect(cell(3, 5)).toBe(2)
    expect(cell(4, 1)).toBe(1)
    expect(cell(2, 5)).toBe(0)
    expect(cell(3, 22)).toBe(0)
    expect(a.peak).toEqual({ weekday: 2, hour: 8, count: 2 })
    expect(a.peaks).toEqual([
      { weekday: 2, hour: 8, count: 2 },
      { weekday: 3, hour: 5, count: 2 },
    ])
    // sem chats no período → sem pico
    const empty = await attendance(utc, { start: '2026-07-01', end: '2026-07-02' })
    expect(empty.attendance.peak).toBeNull()
  })

  it('AC-T65-04 desempenho por atendente: quem escreveu a 1ª resposta, atribuídos agora e média própria', async () => {
    const { attendance: a } = await attendance(ana, RANGE)
    expect(a.leads_by_user).toEqual([
      { user_id: ana.userId, user_name: 'Ana Atendente', answered_chats: 2, attending_chats: 1, resolved_chats: 1, average_response_seconds: 450 },
      { user_id: bruno.userId, user_name: 'Bruno Suporte', answered_chats: 1, attending_chats: 1, resolved_chats: 1, average_response_seconds: 120 },
    ])
    expect(sum(a.leads_by_user, 'answered_chats')).toBe(a.attended_leads)
  })

  it('AC-T65-04 por departamento e por conexão: somas batem com a visão geral', async () => {
    const { attendance: a } = await attendance(ana, RANGE)
    const deps = [...a.attendance_by_department].sort((x: Any, y: Any) => String(x.department_id).localeCompare(String(y.department_id)))
    expect(a.attendance_by_department).toHaveLength(2)
    expect(a.attendance_by_department).toEqual(
      expect.arrayContaining([
        { department_id: vendas, department_name: 'Vendas', color: '#FF8800', chat_count: 3 },
        expect.objectContaining({ department_id: null, color: null, chat_count: 3 }),
      ]),
    )
    expect(sum(deps, 'chat_count')).toBe(a.new_leads)

    const byConn = Object.fromEntries(a.leads_by_status_chart.map((r: Any) => [r.connection_id, r]))
    expect(byConn[c1]).toMatchObject({ connection_name: 'Comercial', new_leads: 3, attended_leads: 2, resolved_leads: 1 })
    expect(byConn[c2]).toMatchObject({ connection_name: 'Suporte', new_leads: 3, attended_leads: 1, resolved_leads: 1 })
    for (const k of ['new_leads', 'attended_leads', 'resolved_leads']) expect(sum(a.leads_by_status_chart, k), k).toBe(a[k])
  })

  it('AC-T65-04 com filtro de conexão as quebras continuam somando os totais filtrados', async () => {
    const { attendance: a } = await attendance(ana, { ...RANGE, connectionIds: [c1] })
    expect(a).toMatchObject({ new_leads: 3, attended_leads: 2, resolved_leads: 1 })
    expect(sum(a.attendance_by_department, 'chat_count')).toBe(3)
    expect(sum(a.leads_by_user, 'answered_chats')).toBe(2)
    expect(sum(a.attendance_over_time, 'count')).toBe(3)
    expect(sum(a.attendance_by_weekday_hour, 'count')).toBe(3)
    expect(a.leads_by_status_chart.map((r: Any) => r.connection_id)).toEqual([c1])
    expect(a.leads_by_user.find((u: Any) => u.user_id === ana.userId)).toMatchObject({ answered_chats: 1, average_response_seconds: 300 })
  })
})
