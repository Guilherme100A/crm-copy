// GET /api/connections/disconnect-alert (AC-T107-01, AC-T107-03) com Postgres real e relógio injetável.
import { randomBytes } from 'node:crypto'
import { companyMembers, connections, createDb, supportAccessGrants, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const NOW = new Date('2026-10-17T12:00:00.000Z')
const HOUR = 3_600_000
const ago = (ms: number) => new Date(NOW.getTime() - ms)

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `ca-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.107.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ name: 'A', email, password: '12345678', password_confirmation: '12345678' }),
  })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ email, password: '12345678' }),
  })
  return {
    cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0],
    companyId: user.last_company_id,
    userId: user.id,
  }
}

const alert = async (s: Session, companyId = s.companyId) => {
  const res = await app.request('/api/connections/disconnect-alert', {
    headers: { ...H, cookie: s.cookie, 'x-company-id': companyId },
  })
  return { status: res.status, body: (await res.json()) as Json }
}

async function member(owner: Session, role: 'admin' | 'member', perms: string[] | null): Promise<Session> {
  const u = await signUp()
  await db.insert(companyMembers).values({ companyId: owner.companyId, userId: u.userId, role, permissionKeys: perms })
  await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, u.userId))
  return { ...u, companyId: owner.companyId }
}

const conn = (companyId: string, values: Partial<typeof connections.$inferInsert> = {}) =>
  db.insert(connections).values({ companyId, sessionId: `s-${rnd()}`, name: `Loja ${rnd()}`, ...values })

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
    connectionsAlert: { now: () => NOW },
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('AC-T107-01 GET /api/connections/disconnect-alert', () => {
  it('200 com false sem conexões (a rota vem antes de /api/connections/:id)', async () => {
    const s = await signUp()
    const r = await alert(s)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ has_recent_disconnected: false, last_disconnected_at: null })
  })

  it('queda nas últimas 24 h → true com a mais recente; vale mesmo depois de reconectar', async () => {
    const s = await signUp()
    await conn(s.companyId, { connectionState: 'open', disconnectedAt: ago(30 * HOUR), connectedAt: ago(29 * HOUR) })
    expect((await alert(s)).body.has_recent_disconnected).toBe(false)
    await conn(s.companyId, { connectionState: 'open', disconnectedAt: ago(5 * HOUR), connectedAt: ago(4 * HOUR) })
    await conn(s.companyId, { connectionState: 'close', disconnectedAt: ago(23 * HOUR) })
    expect((await alert(s)).body).toEqual({
      has_recent_disconnected: true,
      last_disconnected_at: ago(5 * HOUR).toISOString(),
    })
  })

  it('limite da janela: exatamente 24 h atrás não conta; 24 h menos 1 s conta', async () => {
    const s = await signUp()
    await conn(s.companyId, { connectionState: 'close', disconnectedAt: ago(24 * HOUR) })
    expect((await alert(s)).body.has_recent_disconnected).toBe(false)
    await conn(s.companyId, { connectionState: 'close', disconnectedAt: ago(24 * HOUR - 1000) })
    expect((await alert(s)).body.has_recent_disconnected).toBe(true)
  })

  it('conexão agendada para exclusão não conta; queda de outra empresa não vaza', async () => {
    const s = await signUp()
    const other = await signUp()
    await conn(s.companyId, {
      connectionState: 'close',
      disconnectedAt: ago(HOUR),
      scheduledForDeletionAt: ago(HOUR / 2),
    })
    await conn(other.companyId, { connectionState: 'close', disconnectedAt: ago(HOUR) })
    expect((await alert(s)).body.has_recent_disconnected).toBe(false)
    expect((await alert(other)).body.has_recent_disconnected).toBe(true)
  })
})

describe('AC-T107-03 permissão', () => {
  it('owner e admin veem; member sem connections.view → 403; member com a chave → 200', async () => {
    const owner = await signUp()
    await conn(owner.companyId, { connectionState: 'close', disconnectedAt: ago(HOUR) })
    expect((await alert(owner)).status).toBe(200)
    expect((await alert(await member(owner, 'admin', null))).body.has_recent_disconnected).toBe(true)
    const m = await alert(await member(owner, 'member', null))
    expect(m.status).toBe(403)
    expect(m.body.error).toMatchObject({ code: 'FORBIDDEN' })
    expect((await alert(await member(owner, 'member', ['connections.view']))).status).toBe(200)
  })

  it('support → 403, como membro com a chave ou entrando por concessão', async () => {
    const owner = await signUp()
    await conn(owner.companyId, { connectionState: 'close', disconnectedAt: ago(HOUR) })
    const asMember = await member(owner, 'admin', ['connections.view'])
    await db.update(users).set({ systemRole: 'support' }).where(eq(users.id, asMember.userId))
    expect((await alert(asMember)).status).toBe(403)

    const sup = await signUp()
    await db.update(users).set({ systemRole: 'support' }).where(eq(users.id, sup.userId))
    await db
      .insert(supportAccessGrants)
      .values({
        companyId: owner.companyId,
        supportUserId: sup.userId,
        grantedByUserId: owner.userId,
        expiresAt: new Date(Date.now() + HOUR),
      })
    expect((await alert(sup, owner.companyId)).status).toBe(403)
  })
})
