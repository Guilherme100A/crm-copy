// Dashboard de atendimento contra Postgres real (AC-T65-01..04): fixture em America/Sao_Paulo, mensagens de usuário,
// bot, IA e fluxo; período > 92 dias; cache.
import { randomBytes } from 'node:crypto'
import { chats, companies, connections, contacts, createDb, departments, messages, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AttendanceDashboardService } from './service'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

const rnd = () => randomBytes(4).toString('hex')
/** Horário local de São Paulo (UTC−3) → Date. */
const sp = (local: string) => new Date(`${local}-03:00`)

async function fixture() {
  const [co] = await db.insert(companies).values({ name: `A${rnd()}`, slug: `a-t65-${rnd()}`, timeZone: 'America/Sao_Paulo' }).returning({ id: companies.id })
  const companyId = co!.id
  const [ana] = await db.insert(users).values({ email: `ana-${rnd()}@x.com`, passwordHash: 'x', name: 'Ana', lastCompanyId: companyId }).returning({ id: users.id })
  const [bruno] = await db.insert(users).values({ email: `bruno-${rnd()}@x.com`, passwordHash: 'x', name: 'Bruno', lastCompanyId: companyId }).returning({ id: users.id })
  const [vendas] = await db.insert(departments).values({ companyId, name: 'Vendas', color: '#FF0000' }).returning({ id: departments.id })
  const [c1] = await db.insert(connections).values({ companyId, sessionId: `s-${rnd()}`, name: 'Principal' }).returning({ id: connections.id })
  const [c2] = await db.insert(connections).values({ companyId, sessionId: `s-${rnd()}`, name: 'Suporte' }).returning({ id: connections.id })
  let n = 0
  async function chat(o: { conn: string; opened: string; status?: 'waiting' | 'attending' | 'resolved'; assigned?: string | null; dept?: string | null; msgs?: { at: string; sender: 'user' | 'bot' | 'ai' | 'flow' | 'contact'; by?: string }[] }) {
    const [ct] = await db.insert(contacts).values({ companyId, name: `C${++n}`, phoneE164: `+55119${String(n).padStart(4, '0')}${rnd().slice(0, 4).replace(/\D/g, '1').padEnd(4, '1')}` }).returning({ id: contacts.id })
    const [ch] = await db
      .insert(chats)
      .values({ companyId, connectionId: o.conn, contactId: ct!.id, status: o.status ?? 'waiting', assignedUserId: o.assigned ?? null, departmentId: o.dept ?? null, openedAt: sp(o.opened) })
      .returning({ id: chats.id })
    for (const m of o.msgs ?? [])
      await db.insert(messages).values({
        companyId,
        chatId: ch!.id,
        direction: m.sender === 'contact' ? 'inbound' : 'outbound',
        senderType: m.sender,
        senderUserId: m.by ?? null,
        type: 'text',
        body: 'x',
        status: 'sent',
        createdAt: sp(m.at),
        sentAt: sp(m.at),
      })
    return ch!.id
  }
  // Fora do período (31/05 local): conta só no first_reply_since.
  await chat({ conn: c1!.id, opened: '2026-05-31T10:00:00', msgs: [{ at: '2026-05-31T10:05:00', sender: 'user', by: ana!.id }] })
  // 01/06 23:30 local = 02/06 02:30 UTC: entra no dia 01 (fuso), segunda-feira 23h.
  await chat({ conn: c1!.id, opened: '2026-06-01T23:30:00', status: 'attending', assigned: ana!.id, dept: vendas!.id, msgs: [{ at: '2026-06-01T23:30:10', sender: 'bot' }, { at: '2026-06-01T23:32:00', sender: 'user', by: ana!.id }] })
  // IA e fluxo antes; a humana só depois (conta 300 s).
  await chat({ conn: c1!.id, opened: '2026-06-02T09:00:00', status: 'resolved', assigned: bruno!.id, dept: vendas!.id, msgs: [{ at: '2026-06-02T09:00:30', sender: 'ai' }, { at: '2026-06-02T09:01:00', sender: 'flow' }, { at: '2026-06-02T09:05:00', sender: 'user', by: bruno!.id }] })
  // Só IA: sem resposta humana.
  await chat({ conn: c2!.id, opened: '2026-06-02T09:20:00', status: 'resolved', msgs: [{ at: '2026-06-02T09:20:05', sender: 'ai' }] })
  // Sem mensagem nenhuma.
  await chat({ conn: c2!.id, opened: '2026-06-03T14:00:00' })
  return { companyId, ana: ana!.id, bruno: bruno!.id, vendas: vendas!.id, c1: c1!.id, c2: c2!.id }
}

describe('AttendanceDashboardService', () => {
  it('AC-T65-01/02/03/04: KPIs no fuso, 1ª resposta só humana, heatmap/pico e somas por atendente e departamento', async () => {
    const f = await fixture()
    const r = await new AttendanceDashboardService({ db }).get(f.companyId, { start_date: '2026-06-01', end_date: '2026-06-03' })
    const a = r.attendance
    expect(r.range).toEqual({ start_date: '2026-06-01', end_date: '2026-06-03', time_zone: 'America/Sao_Paulo', granularity: 'day' })
    expect(a).toMatchObject({ new_leads: 4, attended_leads: 2, resolved_leads: 2, unanswered_chats: 2, response_time_seconds: 210, first_reply_since: '2026-05-31' })
    expect(a.attendance_over_time).toEqual([
      { bucket_start: '2026-06-01', count: 1 },
      { bucket_start: '2026-06-02', count: 2 },
      { bucket_start: '2026-06-03', count: 1 },
    ])
    expect(a.attendance_by_weekday_hour.find((c) => c.weekday === 1 && c.hour === 23)!.count).toBe(1)
    expect(a.peak).toEqual({ weekday: 2, hour: 9, count: 2 })
    expect(a.leads_by_user).toEqual([
      { user_id: f.ana, user_name: 'Ana', answered_chats: 1, attending_chats: 1, resolved_chats: 0, average_response_seconds: 120 },
      { user_id: f.bruno, user_name: 'Bruno', answered_chats: 1, attending_chats: 0, resolved_chats: 1, average_response_seconds: 300 },
    ])
    expect(a.attendance_by_department).toEqual([
      { department_id: f.vendas, department_name: 'Vendas', color: '#FF0000', chat_count: 2 },
      { department_id: null, department_name: 'Sem departamento', color: null, chat_count: 2 },
    ])
    expect(a.leads_by_status_chart).toEqual([
      { connection_id: f.c1, connection_name: 'Principal', new_leads: 2, attended_leads: 2, resolved_leads: 1 },
      { connection_id: f.c2, connection_name: 'Suporte', new_leads: 2, attended_leads: 0, resolved_leads: 1 },
    ])
    // Período anterior (29–31/05): só o chat de 31/05.
    expect(r.previous_range).toEqual({ start_date: '2026-05-29', end_date: '2026-05-31' })
    expect(a.previous).toEqual({ new_leads: 1, attended_leads: 1, resolved_leads: 0, unanswered_chats: 0, response_time_seconds: 300 })
    expect(a.trends.new_leads).toMatchObject({ direction: 'up' })

    // Filtro de conexão e 1 dia (buckets por hora).
    const one = await new AttendanceDashboardService({ db }).get(f.companyId, { start_date: '2026-06-02', end_date: '2026-06-02', connection_ids: [f.c2] })
    expect(one.range.granularity).toBe('hour')
    expect(one.attendance.attendance_over_time).toHaveLength(24)
    expect(one.attendance.attendance_over_time[9]).toEqual({ bucket_start: '2026-06-02T09:00', count: 1 })
    expect(one.attendance).toMatchObject({ new_leads: 1, attended_leads: 0, response_time_seconds: null, leads_by_user: [] })
  })

  it('período > 92 dias, fim antes do início e data inválida → DashboardQueryError; 92 dias passa', async () => {
    const f = await fixture()
    const svc = new AttendanceDashboardService({ db })
    await expect(svc.get(f.companyId, { start_date: '2026-01-01', end_date: '2026-04-03' })).rejects.toMatchObject({ fields: [{ path: 'end_date' }] })
    await expect(svc.get(f.companyId, { start_date: '2026-06-02', end_date: '2026-06-01' })).rejects.toMatchObject({ fields: [{ path: 'end_date' }] })
    await expect(svc.get(f.companyId, { start_date: '2026-13-01', end_date: '2026-06-01' })).rejects.toMatchObject({ fields: [{ path: 'start_date' }] })
    await expect(svc.get(f.companyId, { start_date: '2026-01-01', end_date: '2026-04-02' })).resolves.toMatchObject({ range: { granularity: 'day' } })
  })

  it('cache de 5 min por filtros; force_refresh recalcula', async () => {
    const f = await fixture()
    const store = new Map<string, string>()
    const svc = new AttendanceDashboardService({ db, cache: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) } })
    const q = { start_date: '2026-06-01', end_date: '2026-06-03' }
    expect((await svc.get(f.companyId, q)).cached).toBe(false)
    const hit = await svc.get(f.companyId, q)
    expect(hit.cached).toBe(true)
    expect(hit.attendance.new_leads).toBe(4)
    expect((await svc.get(f.companyId, q, { forceRefresh: true })).cached).toBe(false)
  })
})
