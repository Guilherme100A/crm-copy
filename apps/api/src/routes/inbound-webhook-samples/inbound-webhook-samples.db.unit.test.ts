// Escuta de amostra (AC-T81-04) pela API: registra o ouvinte por 90 s, DELETE cancela, webhook de outra empresa → 404,
// sem webhooks.view → 403; o log de acesso da recepção pública não leva o token.
import { randomBytes } from 'node:crypto'
import { SampleListeners, sampleListenKey } from '@crm/core'
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
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const logLines: string[] = []

interface Session {
  cookie: string
  companyId: string
  userId: string
}
async function signUp(): Promise<Session> {
  const email = `s-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.81.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'S', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}
const call = (s: Session, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'info', destination: { write: (s: string) => void logLines.push(s) } as never }),
    inboundWebhooksEnqueue: async () => undefined,
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('POST/DELETE /api/inbound-webhooks/:id/sample-listen', () => {
  it('registra a escuta do usuário por ~90 s e cancela; outra empresa → 404; sem webhooks.view → 403', async () => {
    const s = await signUp()
    const created = (await (await call(s, 'POST', '/api/inbound-webhooks', { name: 'Vendas' })).json()) as Json
    const id = created.webhook?.id ?? created.id
    const before = Date.now()
    const res = await call(s, 'POST', `/api/inbound-webhooks/${id}/sample-listen`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Json
    expect(body).toMatchObject({ listening: true, webhook_id: id })
    const delta = new Date(body.expires_at).getTime() - before
    expect(delta).toBeGreaterThan(85_000)
    expect(delta).toBeLessThan(95_000)
    expect(Object.keys(await redis.hgetall(sampleListenKey(id)))).toEqual([s.userId])

    expect((await call(s, 'DELETE', `/api/inbound-webhooks/${id}/sample-listen`)).status).toBe(200)
    expect(await new SampleListeners(redis as never).take(id)).toEqual([])

    const other = await signUp()
    expect((await call(other, 'POST', `/api/inbound-webhooks/${id}/sample-listen`)).status).toBe(404)
    expect((await call(other, 'POST', '/api/inbound-webhooks/nao-uuid/sample-listen')).status).toBe(404)

    const m = await signUp()
    await db.insert(companyMembers).values({ companyId: s.companyId, userId: m.userId, role: 'member', permissionKeys: ['chat.view'] })
    await db.update(users).set({ lastCompanyId: s.companyId }).where(eq(users.id, m.userId))
    expect((await call({ ...m, companyId: s.companyId }, 'POST', `/api/inbound-webhooks/${id}/sample-listen`)).status).toBe(403)
  })

  it('o log de acesso da recepção pública mascara o token (inclusive no 404)', async () => {
    const s = await signUp()
    const created = (await (await call(s, 'POST', '/api/inbound-webhooks', { name: 'Log' })).json()) as Json
    const url: string = created.webhook?.public_receive_url ?? created.public_receive_url
    const token = url.split('/').pop()!
    logLines.length = 0
    expect((await app.request(`/api/hooks/in/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })).status).toBe(202)
    const fake = `${'z'.repeat(43)}`
    expect((await app.request(`/api/hooks/in/${fake}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    const log = logLines.join('\n')
    expect(log).toContain('"path":"/api/hooks/in/***"')
    expect(log).not.toContain(token)
    expect(log).not.toContain(fake)
  })
})
