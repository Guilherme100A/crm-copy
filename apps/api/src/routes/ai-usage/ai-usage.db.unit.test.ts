/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// `GET /api/ai/wallet` com a última recarga (T59, AC-T59-02): `last_topup` nulo sem recarga, a mais recente depois de
// várias recargas e débitos de uso não contam.
import { randomBytes } from 'node:crypto'
import { AiUsageService } from '@crm/core'
import { createDb, llmPrices, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const rnd = () => randomBytes(4).toString('hex')

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `t59-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.59.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}
const call = async (s: Session, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    realtimePublisher: { publish: async () => undefined } as never,
  })
  await db.insert(llmPrices).values({ provider: 'testprov', model: 'm1', kind: 'llm', effectiveFrom: new Date('2020-01-01T00:00:00Z'), inputPerMtokMicros: 1_000_000, outputPerMtokMicros: 0 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('AC-T59-02 última recarga na carteira', () => {
  it('sem recarga → last_topup null; com recargas → a mais recente; débito de uso não conta', async () => {
    const owner = await signUp()
    const empty = await call(owner, 'GET', '/api/ai/wallet')
    expect(empty.status).toBe(200)
    expect(empty.body.wallet).toMatchObject({ balance_credits: 0, last_topup: null })

    const admin = await signUp()
    await db.update(users).set({ systemRole: 'platform_admin' }).where(eq(users.id, admin.userId))
    const path = `/api/platform/companies/${owner.companyId}/ai/topups`
    expect((await call(admin, 'POST', path, { credits: 5000, note: 'primeira' })).status).toBe(201)
    await new Promise((r) => setTimeout(r, 5))
    const second = await call(admin, 'POST', path, { credits: 1200, note: 'segunda' })
    expect(second.status).toBe(201)

    // Um uso cobrado gera débito no ledger depois da recarga: a última recarga continua a de 1200.
    await new AiUsageService({ db }).record({ companyId: owner.companyId, requestId: `req-${rnd()}`, provider: 'testprov', model: 'm1', usage: { inputTokens: 1_000_000, outputTokens: 0 } })

    const r = await call(owner, 'GET', '/api/ai/wallet')
    expect(r.status).toBe(200)
    expect(r.body.wallet.last_topup).toEqual({ amount_credits: 1200, created_at: second.body.entry.created_at })
    expect(r.body.wallet.balance_credits).toBeLessThan(6200)

    // Outra empresa não enxerga a recarga desta.
    const other = await signUp()
    expect((await call(other, 'GET', '/api/ai/wallet')).body.wallet.last_topup).toBeNull()
  })
})
