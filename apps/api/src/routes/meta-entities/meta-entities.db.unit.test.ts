/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// PATCH /api/meta/structure-entities/:id (AC-T103-01..04) com o FakeMetaGraph: status/orçamento na Graph, cache do
// bundle invalidado, 422, 502 da Meta, 404 de conta alheia e 403 sem facebook.campaigns.
import { randomBytes } from 'node:crypto'
import { FakeMetaGraph } from '@crm/core/meta-testing'
import { companyMembers, createDb, metaAdAccounts, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, generateCredentialsKey, initCredentialsCrypto, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const fake = new FakeMetaGraph({ appId: 'app-103-api', appSecret: 'secret-103-api' })
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const REDIRECT = 'http://api.test/api/meta/oauth/callback'
const rnd = () => randomBytes(4).toString('hex')

interface Session {
  cookie: string
  companyId: string
  userId: string
}
async function signUp(): Promise<Session> {
  const email = `t103-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.103.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}
const call = async (s: Session, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}

/** Perfil conectado pelo OAuth da T99 com uma conta incluída no dashboard e uma campanha → conjunto → anúncio. */
async function connected(s: Session): Promise<string> {
  const act = `act_1030${Math.floor(Math.random() * 1e6)}`
  const fbUser = `fb-${rnd()}`
  fake.addUser({ id: fbUser, name: 'Ana', adAccounts: [{ id: act, name: 'Conta', currency: 'BRL' }] })
  fake.setStructure(act, {
    campaigns: [{ id: `${act}-c`, name: 'C', effective_status: 'ACTIVE', daily_budget: '5000' }],
    adsets: [{ id: `${act}-s`, name: 'S', campaign_id: `${act}-c`, effective_status: 'ACTIVE' }],
    ads: [{ id: `${act}-a`, name: 'A', campaign_id: `${act}-c`, adset_id: `${act}-s`, effective_status: 'ACTIVE' }],
  })
  const start = await call(s, 'POST', '/api/meta/oauth/start', {})
  const state = new URL(start.body.oauth_url).searchParams.get('state')!
  await app.request(`/api/meta/oauth/callback?${new URLSearchParams({ code: fake.issueCode(fbUser, REDIRECT), state })}`, { headers: { cookie: s.cookie } })
  await db.update(metaAdAccounts).set({ includedInDashboard: true }).where(eq(metaAdAccounts.companyId, s.companyId))
  return act
}

beforeAll(async () => {
  initCredentialsCrypto({ key: generateCredentialsKey() })
  const { url } = await fake.start()
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    metaConfig: { appId: fake.appId, appSecret: fake.appSecret, graphUrl: url, version: 'v26.0', redirectUri: REDIRECT, webUrl: 'http://web.test', dialogUrl: 'https://www.facebook.com' },
  })
}, 120_000)

afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('PATCH /api/meta/structure-entities/:id', () => {
  it('AC-T103-01/02: status e orçamento vão à Meta; o bundle seguinte não vem do cache e já mostra o novo valor', async () => {
    const s = await signUp()
    const act = await connected(s)
    const url = '/api/meta/structure-bundle?status_filter=all'
    expect((await call(s, 'GET', url)).body.cached).toBe(false)
    expect((await call(s, 'GET', url)).body.cached).toBe(true)

    const r = await call(s, 'PATCH', `/api/meta/structure-entities/${act}-c`, { level: 'campaign', fb_ad_account_id: act, status: 'PAUSED', daily_budget: '12,50', lifetime_budget: '' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, entity: { id: `${act}-c`, status: 'PAUSED', daily_budget: 12.5 } })
    expect(fake.mutations.at(-1)!.fields).toEqual({ status: 'PAUSED', daily_budget: '1250' })

    const after = await call(s, 'GET', url)
    expect(after.body.cached).toBe(false)
    expect(after.body.campaign[0]).toMatchObject({ id: `${act}-c`, status: 'PAUSED' })
  })

  it('AC-T103-03: name com level=ad e sem fb_ad_account_id → 422; conta de outra empresa → 404', async () => {
    const s = await signUp()
    const act = await connected(s)
    const before = fake.mutations.length
    const adName = await call(s, 'PATCH', `/api/meta/structure-entities/${act}-a`, { level: 'ad', fb_ad_account_id: act, name: 'Novo' })
    expect(adName.status).toBe(422)
    expect(JSON.stringify(adName.body)).toContain('"name"')
    const noAccount = await call(s, 'PATCH', `/api/meta/structure-entities/${act}-c`, { level: 'campaign', status: 'PAUSED' })
    expect(noAccount.status).toBe(422)
    expect(JSON.stringify(noAccount.body)).toContain('fb_ad_account_id')
    const other = await signUp()
    expect((await call(other, 'PATCH', `/api/meta/structure-entities/${act}-c`, { level: 'campaign', fb_ad_account_id: act, status: 'PAUSED' })).status).toBe(404)
    expect(fake.mutations.length).toBe(before)
  })

  it('AC-T103-04: erro da Meta → 502 UPSTREAM_ERROR "Não foi possível atualizar na Meta"; sem facebook.campaigns → 403', async () => {
    const s = await signUp()
    const act = await connected(s)
    fake.failNext(400, { message: 'Invalid parameter', type: 'OAuthException', code: 100 })
    const r = await call(s, 'PATCH', `/api/meta/structure-entities/${act}-c`, { level: 'campaign', fb_ad_account_id: act, status: 'PAUSED' })
    expect(r.status).toBe(502)
    expect(r.body.error).toMatchObject({ code: 'UPSTREAM_ERROR', message: expect.stringContaining('Não foi possível atualizar na Meta') })

    const m = await signUp()
    await db.insert(companyMembers).values({ companyId: s.companyId, userId: m.userId, role: 'member', permissionKeys: ['chat.view'] })
    await db.update(users).set({ lastCompanyId: s.companyId }).where(eq(users.id, m.userId))
    expect((await call({ ...m, companyId: s.companyId }, 'PATCH', `/api/meta/structure-entities/${act}-c`, { level: 'campaign', fb_ad_account_id: act, status: 'PAUSED' })).status).toBe(403)
  })

  it('limite de uso da Meta → 429 RATE_LIMIT', async () => {
    const s = await signUp()
    const act = await connected(s)
    fake.failNext(400, { message: 'User request limit reached', code: 17 })
    const r = await call(s, 'PATCH', `/api/meta/structure-entities/${act}-s`, { level: 'adset', fb_ad_account_id: act, name: 'Novo' })
    expect(r.status).toBe(429)
    expect(r.body.error.code).toBe('RATE_LIMIT')
  })
})
