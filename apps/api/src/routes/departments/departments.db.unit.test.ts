import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { passesScope } from '@crm/core'
import { chats, companyMembers, contacts, createDb, flows, memberDepartments, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const CONN = '00000000-0000-4000-8000-0000000000c1'

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `d-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.31.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'D', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}

const call = (s: Session, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json
const paths = async (r: Response) => ((await json(r)).error.details.fields as Json[]).map((f) => f.path)

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }) })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('AC-T31-01 departamentos', () => {
  it('paginação de 20, busca sem caixa/acento e /all', async () => {
    const s = await signUp()
    for (let i = 0; i < 23; i++) expect((await call(s, 'POST', '/api/departments', { name: `Setor ${String(i).padStart(2, '0')}` })).status).toBe(201)
    await call(s, 'POST', '/api/departments', { department: { name: 'Cobrança', color: '#ef4444' } })
    const p1 = await json(await call(s, 'GET', '/api/departments'))
    expect(p1.items).toHaveLength(20)
    expect(p1.page).toEqual({ page: 1, limit: 20, total_count: 24, total_pages: 2, has_more: true })
    const p2 = await json(await call(s, 'GET', '/api/departments?page=2'))
    expect(p2.items).toHaveLength(4)
    expect(p2.page.has_more).toBe(false)
    const found = await json(await call(s, 'GET', '/api/departments?search=COBRANCA'))
    expect(found.items).toEqual([expect.objectContaining({ name: 'Cobrança', color: '#EF4444' })])
    expect((await json(await call(s, 'GET', '/api/departments/all'))).items).toHaveLength(24)
  })

  it('cor padrão, hex normalizado e cor inválida → 422 color', async () => {
    const s = await signUp()
    expect((await json(await call(s, 'POST', '/api/departments', { name: 'A' }))).department.color).toBe('#3B82F6')
    expect((await json(await call(s, 'POST', '/api/departments', { name: 'B', color: '#abc' }))).department.color).toBe('#AABBCC')
    for (const color of ['azul', '#12345', '#GGGGGG']) {
      const res = await call(s, 'POST', '/api/departments', { name: 'C', color })
      expect(res.status).toBe(422)
      expect(await paths(res)).toContain('color')
    }
    const { department } = await json(await call(s, 'POST', '/api/departments', { name: 'D' }))
    const bad = await call(s, 'PATCH', `/api/departments/${department.id}`, { color: 'rosa' })
    expect(bad.status).toBe(422)
    expect((await call(s, 'POST', '/api/departments', { name: '  ' })).status).toBe(422)
  })

  it('excluir remove vínculos de membros e zera chats.department_id (FK)', async () => {
    const s = await signUp()
    const { department } = await json(await call(s, 'POST', '/api/departments', { name: 'Vendas' }))
    const [member] = await db.select({ id: companyMembers.id }).from(companyMembers).where(eq(companyMembers.userId, s.userId))
    expect((await call(s, 'PUT', `/api/departments/members/${member!.id}/scope`, { department_ids: [department.id], connection_ids: [CONN] })).status).toBe(200)
    const [contact] = await db.insert(contacts).values({ companyId: s.companyId, name: 'C' }).returning({ id: contacts.id })
    const [chat] = await db.insert(chats).values({ companyId: s.companyId, connectionId: CONN, contactId: contact!.id, departmentId: department.id }).returning({ id: chats.id })
    await expect(db.insert(chats).values({ companyId: s.companyId, connectionId: CONN, contactId: contact!.id, departmentId: '00000000-0000-4000-8000-000000000999' })).rejects.toThrow()

    expect((await call(s, 'DELETE', `/api/departments/${department.id}`)).status).toBe(204)
    expect(await db.select().from(memberDepartments).where(eq(memberDepartments.departmentId, department.id))).toEqual([])
    const [after] = await db.select({ d: chats.departmentId }).from(chats).where(eq(chats.id, chat!.id))
    expect(after!.d).toBeNull()
    expect((await call(s, 'GET', `/api/departments/${department.id}`)).status).toBe(404)
  })

  it('outra empresa → 404; departamento de outra empresa no escopo → 422', async () => {
    const a = await signUp()
    const b = await signUp()
    const { department } = await json(await call(a, 'POST', '/api/departments', { name: 'X' }))
    expect((await call(b, 'GET', `/api/departments/${department.id}`)).status).toBe(404)
    const [mb] = await db.select({ id: companyMembers.id }).from(companyMembers).where(eq(companyMembers.userId, b.userId))
    const res = await call(b, 'PUT', `/api/departments/members/${mb!.id}/scope`, { department_ids: [department.id] })
    expect(res.status).toBe(422)
    expect(await paths(res)).toContain('department_ids')
  })
})

describe('AC-T31-03 horários', () => {
  const hours = [
    { day_of_week: 1, start_time: '09:00', end_time: '12:00', active: true },
    { day_of_week: 1, start_time: '13:00', end_time: '18:00', active: true },
  ]

  it('mensagem sem texto ou fluxo sem fluxo → 422; PUT substitui tudo', async () => {
    const s = await signUp()
    expect((await json(await call(s, 'GET', `/api/business-hours/${CONN}`))).config).toMatchObject({ id: null, active: false, business_hours: [] })
    const noText = await call(s, 'PUT', `/api/business-hours/${CONN}`, { active: true, action_type: 'message', message_text: '  ', business_hours: hours })
    expect(noText.status).toBe(422)
    expect(await paths(noText)).toContain('message_text')
    const noFlow = await call(s, 'PUT', `/api/business-hours/${CONN}`, { active: true, action_type: 'flow', business_hours: hours })
    expect(await paths(noFlow)).toContain('flow_id')
    // inativa não exige texto
    expect((await call(s, 'PUT', `/api/business-hours/${CONN}`, { active: false, action_type: 'message' })).status).toBe(200)

    const ok = await json(await call(s, 'PUT', `/api/business-hours/${CONN}`, { active: true, action_type: 'message', message_text: 'Voltamos às 9h', business_hours: hours }))
    expect(ok.config).toMatchObject({ active: true, message_text: 'Voltamos às 9h' })
    expect(ok.config.business_hours).toHaveLength(2)
    const replaced = await json(
      await call(s, 'PUT', `/api/business-hours/${CONN}`, { active: true, action_type: 'message', message_text: 'x', business_hours: [{ day_of_week: 2, start_time: '08:00', end_time: '10:00' }] }),
    )
    expect(replaced.config.business_hours.map((h: Json) => h.day_of_week)).toEqual([2])
    expect(replaced.config.id).toBe(ok.config.id)
  })

  it('intervalo inválido → 422 e a config anterior continua intacta', async () => {
    const s = await signUp()
    await call(s, 'PUT', `/api/business-hours/${CONN}`, { active: true, action_type: 'message', message_text: 'antes', business_hours: hours })
    const bad = await call(s, 'PUT', `/api/business-hours/${CONN}`, {
      active: true,
      action_type: 'message',
      message_text: 'depois',
      business_hours: [hours[0], { day_of_week: 1, start_time: '25:00', end_time: '26:00' }],
    })
    expect(bad.status).toBe(422)
    expect(await paths(bad)).toEqual(expect.arrayContaining(['business_hours.1.start_time', 'business_hours.1.end_time']))
    const cur = (await json(await call(s, 'GET', `/api/business-hours/${CONN}`))).config
    expect(cur.message_text).toBe('antes')
    expect(cur.business_hours).toHaveLength(2)
  })

  it('fluxo de outra empresa → 422; fluxo usado por horário não pode ser excluído (409)', async () => {
    const a = await signUp()
    const b = await signUp()
    const [fa] = await db.insert(flows).values({ companyId: a.companyId, name: 'Fora do horário' }).returning({ id: flows.id })
    const cross = await call(b, 'PUT', `/api/business-hours/${CONN}`, { active: true, action_type: 'flow', flow_id: fa!.id })
    expect(cross.status).toBe(422)
    expect(await paths(cross)).toContain('flow_id')

    const put = await json(await call(a, 'PUT', `/api/business-hours/${CONN}`, { active: true, action_type: 'flow', flow_id: fa!.id, business_hours: hours }))
    const del = await call(a, 'DELETE', `/api/flows/${fa!.id}`)
    expect(del.status).toBe(409)
    const { error } = await json(del)
    expect(error.code).toBe('CONFLICT')
    expect(error.details.references).toEqual([{ kind: 'business_hour_config', id: put.config.id, name: CONN }])
    // trocar a ação libera a exclusão
    await call(a, 'PUT', `/api/business-hours/${CONN}`, { active: true, action_type: 'message', message_text: 'x', flow_id: null })
    expect((await call(a, 'DELETE', `/api/flows/${fa!.id}`)).status).toBe(200)
  })
})

describe('AC-T31-04 escopo e realtime', () => {
  it('membro com departamento só recebe eventos dele; sem seleção recebe todos; owner sempre', async () => {
    const owner = await signUp()
    const other = await signUp()
    const { department: d1 } = await json(await call(owner, 'POST', '/api/departments', { name: 'D1' }))
    const { department: d2 } = await json(await call(owner, 'POST', '/api/departments', { name: 'D2' }))
    const [m] = await db.insert(companyMembers).values({ companyId: owner.companyId, userId: other.userId, role: 'member' }).returning({ id: companyMembers.id })
    await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, other.userId))

    const env = { id: '1-0', type: 'chat.updated', company_id: owner.companyId, at: new Date().toISOString(), data: {} }
    const member = { companyId: owner.companyId, userId: other.userId, role: 'member' as const, permissionKeys: null }
    expect(await passesScope(member, { department_id: d1.id }, env)).toBe(true) // sem seleção = todos

    const scoped = await json(await call(owner, 'PUT', `/api/departments/members/${m!.id}/scope`, { department_ids: [d1.id] }))
    expect(scoped.scope).toEqual({ member_id: m!.id, department_ids: [d1.id], connection_ids: [] })
    expect(await passesScope(member, { department_id: d1.id }, env)).toBe(true)
    expect(await passesScope(member, { department_id: d2.id }, env)).toBe(false)
    expect(await passesScope(member, { connection_id: CONN }, env)).toBe(true)
    expect(await passesScope({ ...member, userId: owner.userId, role: 'owner' }, { department_id: d2.id }, env)).toBe(true)

    await call(owner, 'PUT', `/api/departments/members/${m!.id}/scope`, { connection_ids: [CONN] })
    expect(await passesScope(member, { connection_id: '00000000-0000-4000-8000-0000000000c2' }, env)).toBe(false)
    expect((await json(await call(owner, 'GET', `/api/departments/members/${m!.id}/scope`))).scope.connection_ids).toEqual([CONN])
  })
})
