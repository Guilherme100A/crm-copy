// Webhooks de entrada (T72) com Postgres real: CRUD, recepção pública, truncamento, rate limit, cota e retenção.
import { randomBytes } from 'node:crypto'
import { companyMembers, createDb, inboundWebhookRequests, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { INBOUND_WEBHOOK_BODY_LIMIT, INBOUND_WEBHOOK_RETENTION, type InboundWebhookJobData } from '@crm/core'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const jobs: InboundWebhookJobData[] = []
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `w-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.72.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'W', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id, userId: user.id }
}

const call = (s: Session, method: string, path: string, body?: unknown, companyId = s.companyId) =>
  app.request(path, { method, headers: { ...H, cookie: s.cookie, 'x-company-id': companyId }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json
const hook = (token: string, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  app.request(`/api/hooks/in/${token}`, { method: 'POST', headers, body })

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
    inboundWebhooksEnv: { API_PUBLIC_URL: 'https://api.crm.test' },
    inboundWebhookRateLimit: { limit: 5, windowMs: 60_000 },
    inboundWebhooksMonthlyLimit: 8,
    inboundWebhooksMaxPerCompany: 3,
    inboundWebhooksEnqueue: async (d) => void jobs.push(d),
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

async function create(s: Session, body: Json = {}) {
  const res = await call(s, 'POST', '/api/inbound-webhooks', { inbound_webhook: { name: `Webhook ${rnd()}`, ...body } })
  expect(res.status, await res.clone().text()).toBe(201)
  return (await json(res)).webhook as Json
}

describe('CRUD', () => {
  it('cria com token ≥ 32 bytes e URL pública; edita; valida; limite por empresa; isola empresas; exclui', async () => {
    const s = await signUp()
    const w = await create(s, { name: '  N8N Vendas  ' })
    expect(w).toMatchObject({ name: 'N8N Vendas', active: true, connection_id: null, config: {}, month_count: 0, last_inbound_webhook_request: null })
    expect(Buffer.from(w.public_token, 'base64url').length).toBe(32)
    expect(w.public_receive_url).toBe(`https://api.crm.test/api/hooks/in/${w.public_token}`)
    expect(w.request_stats).toEqual({ total: 0, processed: 0, failed: 0, pending: 0, skipped: 0, retention_max: 1000 })

    const patched = await call(s, 'PATCH', `/api/inbound-webhooks/${w.id}`, { active: false, config: { add_tags: ['Lead'] } })
    expect((await json(patched)).webhook).toMatchObject({ active: false, config: { add_tags: ['Lead'] }, name: 'N8N Vendas' })

    const bad = [
      await call(s, 'POST', '/api/inbound-webhooks', { name: '   ' }),
      await call(s, 'POST', '/api/inbound-webhooks', { name: 'x', connection_id: crypto.randomUUID() }),
      await call(s, 'PUT', `/api/inbound-webhooks/${w.id}`, { config: { trigger_flow: true } }),
    ]
    expect(bad.map((r) => r.status)).toEqual([422, 422, 422])

    await create(s)
    await create(s)
    expect((await call(s, 'POST', '/api/inbound-webhooks', { name: 'Quarto' })).status).toBe(409)

    const other = await signUp()
    expect((await call(other, 'GET', `/api/inbound-webhooks/${w.id}`)).status).toBe(404)
    const list = await json(await call(s, 'GET', '/api/inbound-webhooks'))
    expect(list.items).toHaveLength(3)
    expect(list.usage).toEqual({ used: 0, limit: 8 })

    expect((await call(s, 'DELETE', `/api/inbound-webhooks/${w.id}`)).status).toBe(200)
    expect((await call(s, 'GET', `/api/inbound-webhooks/${w.id}`)).status).toBe(404)
  })

  it('permissões: sem webhooks.view → 403; só view lê mas não cria', async () => {
    const owner = await signUp()
    const member = await signUp()
    await db.insert(companyMembers).values({ companyId: owner.companyId, userId: member.userId, role: 'member', permissionKeys: ['webhooks.view'] })
    expect((await call(member, 'GET', '/api/inbound-webhooks', undefined, owner.companyId)).status).toBe(200)
    expect((await call(member, 'POST', '/api/inbound-webhooks', { name: 'x' }, owner.companyId)).status).toBe(403)
  })
})

describe('recepção pública', () => {
  it('AC-T72-01 token inexistente → 404; inativo → 202 e skipped/webhook_inactive sem job', async () => {
    expect((await hook(randomBytes(32).toString('base64url'), '{}')).status).toBe(404)
    expect((await hook('curto', '{}')).status).toBe(404)
    const s = await signUp()
    const w = await create(s, { active: false })
    const before = jobs.length
    const res = await hook(w.public_token, '{"a":1}')
    expect(res.status).toBe(202)
    const body = await json(res)
    expect(body).toMatchObject({ ok: true, status: 'skipped' })
    const reqs = await json(await call(s, 'GET', `/api/inbound-webhooks/${w.id}/requests`))
    expect(reqs.items[0]).toMatchObject({ id: body.request_id, processing_status: 'skipped', error: 'webhook_inactive', raw_body: '{"a":1}' })
    expect(jobs.length).toBe(before)
  })

  it('AC-T72-03 válido → 202 rápido, pending, job com o id do request, month_count +1 e último payload', async () => {
    const s = await signUp()
    const w = await create(s)
    const t0 = performance.now()
    const res = await hook(w.public_token, '{"nome":"Ana"}', { 'content-type': 'text/plain' })
    const ms = performance.now() - t0
    expect(res.status).toBe(202)
    expect(ms).toBeLessThan(200)
    const { request_id } = await json(res)
    expect(jobs.at(-1)).toEqual({ requestId: request_id, webhookId: w.id, companyId: s.companyId })
    const got = (await json(await call(s, 'GET', `/api/inbound-webhooks/${w.id}`))).webhook
    expect(got).toMatchObject({ month_count: 1, request_stats: { total: 1, pending: 1 }, last_inbound_webhook_request: { id: request_id, raw_body: '{"nome":"Ana"}' } })
    const req = (await json(await call(s, 'GET', `/api/inbound-webhooks/${w.id}/requests`))).items[0]
    expect(req).toMatchObject({ processing_status: 'pending', content_type: 'text/plain', body_size: 14, raw_body_truncated: false })
    expect(req.body_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('AC-T72-02 corpo acima do limite trunca com a flag e grava; acima do rate limit → 429', async () => {
    const s = await signUp()
    const w = await create(s)
    const big = JSON.stringify({ blob: 'x'.repeat(INBOUND_WEBHOOK_BODY_LIMIT + 100) })
    expect((await hook(w.public_token, big)).status).toBe(202)
    const req = (await json(await call(s, 'GET', `/api/inbound-webhooks/${w.id}/requests`))).items[0]
    expect(req).toMatchObject({ raw_body_truncated: true, body_size: big.length })
    expect(req.raw_body.length).toBe(INBOUND_WEBHOOK_BODY_LIMIT)
    for (let i = 0; i < 4; i++) expect((await hook(w.public_token, '{}')).status).toBe(202)
    const limited = await hook(w.public_token, '{}')
    expect(limited.status).toBe(429)
    expect((await json(limited)).error.code).toBe('RATE_LIMIT')
    expect((await json(await call(s, 'GET', `/api/inbound-webhooks/${w.id}/requests`))).page.total_count).toBe(5)
  })

  it('cota mensal da empresa → 429 QUOTA_EXCEEDED e request skipped/monthly_limit_reached', async () => {
    const s = await signUp()
    const a = await create(s)
    const b = await create(s)
    for (let i = 0; i < 4; i++) {
      expect((await hook(a.public_token, `{"i":${i}}`)).status).toBe(202)
      expect((await hook(b.public_token, `{"i":${i}}`)).status).toBe(202)
    }
    const res = await hook(a.public_token, '{"i":9}')
    expect(res.status).toBe(429)
    expect((await json(res)).error.code).toBe('QUOTA_EXCEEDED')
    const req = (await json(await call(s, 'GET', `/api/inbound-webhooks/${a.id}/requests`))).items[0]
    expect(req).toMatchObject({ processing_status: 'skipped', error: 'monthly_limit_reached' })
    expect((await json(await call(s, 'GET', '/api/inbound-webhooks'))).usage).toEqual({ used: 8, limit: 8 })
  })

  it('AC-T72-04 o 1001º request remove o mais antigo do webhook', async () => {
    const s = await signUp()
    const w = await create(s)
    await db.execute(sql`
      insert into crm.inbound_webhook_requests (company_id, webhook_id, processing_status, raw_body, body_hash)
      select ${s.companyId}, ${w.id}, 'processed', 'old-' || g, '' from generate_series(1, ${INBOUND_WEBHOOK_RETENTION}) g`)
    const [oldest] = await db.select().from(inboundWebhookRequests).where(eq(inboundWebhookRequests.webhookId, w.id)).orderBy(asc(inboundWebhookRequests.seq)).limit(1)
    expect(oldest!.rawBody).toBe('old-1')
    expect((await hook(w.public_token, '{"new":true}')).status).toBe(202)
    const rows = await db.select({ raw: inboundWebhookRequests.rawBody }).from(inboundWebhookRequests).where(eq(inboundWebhookRequests.webhookId, w.id)).orderBy(asc(inboundWebhookRequests.seq))
    expect(rows).toHaveLength(INBOUND_WEBHOOK_RETENTION)
    expect(rows[0]!.raw).toBe('old-2')
    expect(rows.at(-1)!.raw).toBe('{"new":true}')
  })
})
