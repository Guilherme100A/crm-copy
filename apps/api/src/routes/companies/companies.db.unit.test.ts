// Fuso da empresa fora da lista aceita → 422 (pendência herdada da T22, corrigida na T102).
import { randomBytes } from 'node:crypto'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

async function signUp() {
  const email = `tz-${randomBytes(4).toString('hex')}@x.com`
  const ip = { 'x-forwarded-for': `10.41.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id as string }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }), waGateway: new FakeWaGateway() })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
}, 60_000)

describe('PUT/POST /api/companies — time_zone', () => {
  it('fuso fora da lista → 422 e nada muda; fuso da lista e o nome curto de Buenos Aires são aceitos', async () => {
    const s = await signUp()
    const put = (body: unknown) =>
      app.request(`/api/companies/${s.companyId}`, { method: 'PUT', headers: { ...H, cookie: s.cookie, 'x-company-id': s.companyId }, body: JSON.stringify(body) })

    const bad = await put({ time_zone: 'Europe/Paris' })
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as Json).error.code).toBe('VALIDATION_ERROR')

    const ok = await put({ time_zone: 'America/Manaus' })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as Json).company.time_zone).toBe('America/Manaus')

    const alias = await put({ time_zone: 'America/Buenos_Aires' })
    expect(((await alias.json()) as Json).company.time_zone).toBe('America/Argentina/Buenos_Aires')

    const created = await app.request('/api/companies', { method: 'POST', headers: { ...H, cookie: s.cookie }, body: JSON.stringify({ name: 'Outra', time_zone: 'Mars/Olympus' }) })
    expect(created.status).toBe(422)
  })
})
