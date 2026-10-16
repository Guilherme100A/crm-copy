/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Fontes de venda pela API (AC-T73-01..05): recepção pública (202/404/401/400/413/429), log de acesso sem o token,
// CRUD e permissões, teste sem gravar, eventos/replay, rotação e atribuição do contato.
import { createHmac, randomBytes } from 'node:crypto'
import { InboundSalesProcessor, type InboundSaleJobData } from '@crm/core'
import { companyMembers, createDb, inboundSaleEvents, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const jobs: { data: InboundSaleJobData; jobId: string }[] = []
const logLines: string[] = []
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const mapping = { external_id: '$.id', status: '$.status', amount: '$.total', phone: '$.phone', utm_source: '$.utm' }

interface Session {
  cookie: string
  companyId: string
  userId: string
}
async function signUp(): Promise<Session> {
  const email = `v-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.73.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'V', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}
const call = async (s: Session, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}
const hook = (token: string, body: string, headers: Record<string, string> = {}) => app.request(`/api/hooks/sales/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

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
    credentialsCipher: createCipher({ key: generateCredentialsKey() }),
    saleSourcesEnv: { API_PUBLIC_URL: 'https://api.crm.test' },
    inboundSalesEnqueue: async (data, opts) => void jobs.push({ data, jobId: opts.jobId }),
    inboundSalesRateLimit: { limit: 5, windowMs: 60_000 },
  })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('POST /api/hooks/sales/:token', () => {
  it('AC-T73-01: 202 + job; token inválido 404; HMAC errado 401 sem gravar; JSON inválido 400; > 256 KB 413; rate limit 429; log sem o token', async () => {
    const s = await signUp()
    const created = await call(s, 'POST', '/api/sale-sources', { sale_source: { name: 'Hotmart', hmac_secret: 'segredo', mapping } })
    expect(created.status).toBe(201)
    const src = created.body.sale_source
    expect(src).toMatchObject({ hmac_configured: true, public_url: `https://api.crm.test/api/hooks/sales/${src.token}` })
    expect(JSON.stringify(created.body)).not.toContain('segredo')

    const raw = JSON.stringify({ id: 'H-1', status: 'paid', total: 100, phone: '+5511966665555', utm: 'fb' })
    const sig = createHmac('sha256', 'segredo').update(raw).digest('hex')
    logLines.length = 0
    jobs.length = 0
    const ok = await hook(src.token, raw, { 'x-signature': `sha256=${sig}` })
    expect(ok.status).toBe(202)
    const okBody = (await ok.json()) as any
    expect(okBody).toMatchObject({ ok: true, status: 'pending', event_id: expect.any(String) })
    expect(jobs).toEqual([{ data: { eventId: okBody.event_id, saleSourceId: src.id, companyId: s.companyId }, jobId: `ise-${okBody.event_id}` }])

    expect((await hook('x'.repeat(43), raw)).status).toBe(404)
    expect((await hook(src.token, raw, { 'x-signature': 'deadbeef' })).status).toBe(401)
    expect((await hook(src.token, raw)).status).toBe(401)
    const badJson = '{nao json'
    expect((await hook(src.token, badJson, { 'x-signature': createHmac('sha256', 'segredo').update(badJson).digest('hex') })).status).toBe(400)
    expect((await db.select({ n: count() }).from(inboundSaleEvents).where(eq(inboundSaleEvents.saleSourceId, src.id)))[0]!.n).toBe(1)
    const log = logLines.join('\n')
    expect(log).toContain('"path":"/api/hooks/sales/***"')
    expect(log).not.toContain(src.token)

    const big = await call(s, 'POST', '/api/sale-sources', { name: 'Grande', mapping })
    expect((await hook(big.body.sale_source.token, `{"x":"${'a'.repeat(300 * 1024)}"}`)).status).toBe(413)
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await hook(big.body.sale_source.token, '{}')).status)
    expect(statuses.at(-1)).toBe(429)
  })
})

describe('/api/sale-sources', () => {
  it('AC-T73-02/03/05: test sem gravar; eventos failed + replay; rotação invalida a URL; atribuição do contato', async () => {
    const s = await signUp()
    const src = (await call(s, 'POST', '/api/sale-sources', { name: 'Kiwify', mapping: { ...mapping, phone: '$.cliente.fone' } })).body.sale_source
    const sample = { id: 'K-1', status: 'Paid', total: '49,90', phone: '+5511955554444', utm: 'google' }
    const t = await call(s, 'POST', `/api/sale-sources/${src.id}/test`, { sample, mapping })
    expect(t.body).toMatchObject({ ok: true, event: { external_id: 'K-1', status: 'approved', amount_cents: 4990 } })
    const unsaved = await call(s, 'POST', '/api/sale-sources/test', { sample: { v: 4990 }, mapping: { external_id: '$.x', status: '$.y', amount: '$.v', phone: '$.p' }, amount_unit: 'cents' })
    expect(unsaved.body).toMatchObject({ ok: false, missing: expect.arrayContaining([{ field: 'external_id', path: '$.x' }]) })
    expect((await db.select({ n: count() }).from(inboundSaleEvents).where(eq(inboundSaleEvents.saleSourceId, src.id)))[0]!.n).toBe(0)

    jobs.length = 0
    expect((await hook(src.token, JSON.stringify(sample))).status).toBe(202)
    const processor = new InboundSalesProcessor({ db })
    expect(await processor.process(jobs[0]!.data)).toMatchObject({ status: 'failed', error: 'missing_path:$.cliente.fone' })
    const failed = await call(s, 'GET', `/api/sale-sources/${src.id}/events?status=failed`)
    expect(failed.body).toMatchObject({ total: 1, items: [{ status: 'failed', error: 'missing_path:$.cliente.fone', missing: [{ field: 'phone', path: '$.cliente.fone' }] }] })
    expect((await call(s, 'PATCH', `/api/sale-sources/${src.id}`, { mapping })).status).toBe(200)
    jobs.length = 0
    const replay = await call(s, 'POST', `/api/sale-sources/${src.id}/events/${failed.body.items[0].id}/replay`)
    expect(replay.status).toBe(202)
    expect(jobs[0]!.jobId.startsWith(`ise-${failed.body.items[0].id}`)).toBe(true)
    const done = await processor.process(jobs[0]!.data)
    expect(done.status).toBe('processed')
    const attr = await call(s, 'GET', `/api/contacts/${done.contactId}/attribution`)
    expect(attr.body.attribution).toMatchObject({ first_touch: { utm_source: 'google' }, last_touch: { utm_source: 'google' } })

    const rotated = await call(s, 'POST', `/api/sale-sources/${src.id}/rotate-token`)
    expect(rotated.body.sale_source.token).not.toBe(src.token)
    expect((await hook(src.token, JSON.stringify(sample))).status).toBe(404)
    expect((await hook(rotated.body.sale_source.token, JSON.stringify(sample))).status).toBe(202)
    expect(logLines.join('\n')).not.toContain(src.token)
  })

  it('permissões: sem settings.integrations.edit → 403; outra empresa → 404', async () => {
    const s = await signUp()
    const src = (await call(s, 'POST', '/api/sale-sources', { name: 'Eduzz', mapping })).body.sale_source
    const other = await signUp()
    expect((await call(other, 'GET', `/api/sale-sources/${src.id}`)).status).toBe(404)
    const u = await signUp()
    await db.insert(companyMembers).values({ companyId: s.companyId, userId: u.userId, role: 'member', permissionKeys: ['settings.integrations.view'] })
    await db.update(users).set({ lastCompanyId: s.companyId }).where(eq(users.id, u.userId))
    const viewer = { ...u, companyId: s.companyId }
    expect((await call(viewer, 'GET', '/api/sale-sources')).status).toBe(200)
    expect((await call(viewer, 'POST', `/api/sale-sources/${src.id}/rotate-token`)).status).toBe(403)
    expect((await call(viewer, 'POST', '/api/sale-sources', { name: 'X', mapping })).status).toBe(403)
  })
})
