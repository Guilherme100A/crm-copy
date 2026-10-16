// API de agendamentos (T64): criar/listar/detalhe/cancelar com fila fake, validação de 31 dias e escopo (T119).
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chats, companyMembers, connections, contacts, createDb, departments, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import type { ScheduleJobData } from '@crm/core'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const added: Array<[ScheduleJobData, number]> = []
const removed: ScheduleJobData[] = []
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const CONN = '00000000-0000-4000-8000-0000000000d4'
const DAY = 24 * 3600_000

interface Session {
  cookie: string
  companyId: string
  userId: string
  headers: Record<string, string>
}

async function signUp(): Promise<Session> {
  const email = `t64-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.64.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'S', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id, headers: {} }
}

const call = (s: Session, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...H, ...s.headers, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json

let owner: Session
let member: Session
let chatX: string
let chatY: string

async function seedChat(departmentId: string) {
  const [contact] = await db
    .insert(contacts)
    .values({ companyId: owner.companyId, name: 'Cli', phoneE164: `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}` })
    .returning({ id: contacts.id })
  const [chat] = await db.insert(chats).values({ companyId: owner.companyId, connectionId: CONN, contactId: contact!.id, departmentId }).returning({ id: chats.id })
  return chat!.id
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    scheduleJobs: { add: async (j, d) => void added.push([j, d]), remove: async (j) => void removed.push(j) },
  })
  owner = await signUp()
  await db.insert(connections).values({ id: CONN, companyId: owner.companyId, sessionId: `s-${rnd()}`, name: 'Conexão' })
  const [x] = await db.insert(departments).values({ companyId: owner.companyId, name: 'X' }).returning({ id: departments.id })
  const [y] = await db.insert(departments).values({ companyId: owner.companyId, name: 'Y' }).returning({ id: departments.id })
  chatX = await seedChat(x!.id)
  chatY = await seedChat(y!.id)
  const m = await signUp()
  const [row] = await db.insert(companyMembers).values({ companyId: owner.companyId, userId: m.userId, role: 'member', permissionKeys: ['chat.view'] }).returning({ id: companyMembers.id })
  await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, m.userId))
  member = { ...m, companyId: owner.companyId, headers: { 'x-company-id': owner.companyId } }
  expect((await call(owner, 'PUT', `/api/departments/members/${row!.id}/scope`, { department_ids: [x!.id] })).status).toBe(200)
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

const runAt = (ms: number) => new Date(Date.now() + ms).toISOString()

describe('AC-T64-01 criar', () => {
  it('201 com o job enfileirado; passado e além de 31 dias → 422 em run_at', async () => {
    const res = await call(owner, 'POST', `/api/chats/${chatX}/schedules`, { kind: 'message', text: 'Oi!', run_at: runAt(DAY), recurrence: 'weekly' })
    expect(res.status).toBe(201)
    const { schedule } = await json(res)
    expect(schedule).toMatchObject({ chat_id: chatX, kind: 'message', text: 'Oi!', recurrence: 'weekly', status: 'pending' })
    expect(added.at(-1)![0]).toEqual({ scheduleId: schedule.id, runAt: schedule.run_at })
    for (const at of [runAt(-60_000), runAt(31 * DAY + 3600_000)]) {
      const bad = await call(owner, 'POST', `/api/chats/${chatX}/schedules`, { kind: 'message', text: 'x', run_at: at })
      expect(bad.status).toBe(422)
      expect((await json(bad)).error.details.fields).toEqual([expect.objectContaining({ path: 'run_at' })])
    }
    const viaBody = await call(owner, 'POST', '/api/schedules', { chat_id: chatX, kind: 'message', text: 'via corpo', run_at: runAt(31 * DAY - 60_000) })
    expect(viaBody.status).toBe(201)
  })
})

describe('AC-T64-04 listar e cancelar', () => {
  it('lista por chat e status; DELETE cancela e remove o job; 2º cancelamento → 409', async () => {
    const { schedule } = await json(await call(owner, 'POST', `/api/chats/${chatX}/schedules`, { kind: 'message', text: 'cancelar', run_at: runAt(2 * DAY) }))
    const del = await call(owner, 'DELETE', `/api/schedules/${schedule.id}`)
    expect(del.status).toBe(200)
    expect((await json(del)).schedule.status).toBe('cancelled')
    expect(removed.at(-1)).toEqual({ scheduleId: schedule.id, runAt: schedule.run_at })
    expect((await call(owner, 'POST', `/api/schedules/${schedule.id}/cancel`)).status).toBe(409)
    const cancelled = await json(await call(owner, 'GET', `/api/schedules?chat_id=${chatX}&status=cancelled`))
    expect(cancelled.items.map((x: Json) => x.id)).toEqual([schedule.id])
    expect(cancelled.page).toMatchObject({ total_count: 1 })
    const byChat = await json(await call(owner, 'GET', `/api/chats/${chatX}/schedules?status=pending`))
    expect(byChat.items.every((x: Json) => x.status === 'pending' && x.chat_id === chatX)).toBe(true)
    expect((await call(owner, 'GET', `/api/schedules/${schedule.id}`)).status).toBe(200)
    expect((await call(owner, 'GET', '/api/schedules?status=bogus')).status).toBe(422)
  })
})

describe('escopo de chat (T119)', () => {
  it('chat fora do escopo → 404 em criar, listar por chat, detalhe e cancelar; lista geral só os visíveis', async () => {
    const { schedule } = await json(await call(owner, 'POST', `/api/chats/${chatY}/schedules`, { kind: 'message', text: 'Y', run_at: runAt(DAY) }))
    const before = added.length
    expect((await call(member, 'POST', `/api/chats/${chatY}/schedules`, { kind: 'message', text: 'x', run_at: runAt(DAY) })).status).toBe(404)
    expect(added.length).toBe(before)
    expect((await call(member, 'GET', `/api/schedules?chat_id=${chatY}`)).status).toBe(404)
    expect((await call(member, 'GET', `/api/chats/${chatY}/schedules`)).status).toBe(404)
    expect((await call(member, 'GET', `/api/schedules/${schedule.id}`)).status).toBe(404)
    expect((await call(member, 'DELETE', `/api/schedules/${schedule.id}`)).status).toBe(404)
    const mine = await call(member, 'POST', `/api/chats/${chatX}/schedules`, { kind: 'message', text: 'X', run_at: runAt(DAY) })
    expect(mine.status).toBe(201)
    const all = await json(await call(member, 'GET', '/api/schedules'))
    expect(all.items.length).toBeGreaterThan(0)
    expect(all.items.every((x: Json) => x.chat_id === chatX)).toBe(true)
  })
})
