/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// GET /api/dashboard/attendance (AC-T65-01): permissão dashboard.support, limite de 92 dias (422), cache e force_refresh.
import { randomBytes } from 'node:crypto'
import { companyMembers, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Session {
  cookie: string
  companyId: string
  userId: string
}
async function signUp(): Promise<Session> {
  const email = `d-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.65.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'D', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}
const get = async (s: Session, query: string) => {
  const res = await app.request(`/api/dashboard/attendance?${query}`, { headers: { ...H, cookie: s.cookie } })
  return { status: res.status, body: (await res.json()) as any }
}
async function member(owner: Session, perms: string[]): Promise<Session> {
  const u = await signUp()
  await db.insert(companyMembers).values({ companyId: owner.companyId, userId: u.userId, role: 'member', permissionKeys: perms })
  await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, u.userId))
  return { ...u, companyId: owner.companyId }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }) })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('GET /api/dashboard/attendance', () => {
  it('200 com o bloco; 91 dias passa e 94 → 422 em end_date; cache e force_refresh', async () => {
    const s = await signUp()
    const ok = await get(s, 'start_date=2026-06-01&end_date=2026-06-30')
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ range: { start_date: '2026-06-01', end_date: '2026-06-30', granularity: 'day' }, cached: false, attendance: { new_leads: 0, peak: null } })
    expect(ok.body.attendance.attendance_over_time).toHaveLength(30)
    expect((await get(s, 'start_date=2026-06-01&end_date=2026-06-30')).body.cached).toBe(true)
    expect((await get(s, 'start_date=2026-06-01&end_date=2026-06-30&force_refresh=1')).body.cached).toBe(false)

    expect((await get(s, 'start_date=2026-01-01&end_date=2026-04-01')).status).toBe(200)
    const tooLong = await get(s, 'start_date=2026-01-01&end_date=2026-04-04')
    expect(tooLong.status).toBe(422)
    expect(tooLong.body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: { fields: [{ path: 'end_date' }] } })
    expect((await get(s, 'start_date=2026-06-01&end_date=2026-06-02&connection_ids[]=nao-uuid')).status).toBe(422)
  })

  it('sem dashboard.support → 403 (dashboard.sales sozinho não basta)', async () => {
    const owner = await signUp()
    expect((await get(await member(owner, ['dashboard.sales']), 'start_date=2026-06-01&end_date=2026-06-01')).status).toBe(403)
    expect((await get(await member(owner, ['dashboard.support']), 'start_date=2026-06-01&end_date=2026-06-01')).status).toBe(200)
  })
})
