/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// GET /api/meta/structure-bundle (T101) com o FakeMetaGraph: síncrono (200), assíncrono (202 + job + SSE) e permissão.
import { randomBytes } from 'node:crypto'
import { FakeMetaGraph } from '@crm/core/meta-testing'
import { type MetaSyncJobData } from '@crm/core'
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
const fake = new FakeMetaGraph({ appId: 'app-101-api', appSecret: 'secret-101-api' })
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const REDIRECT = 'http://api.test/api/meta/oauth/callback'
const jobs: MetaSyncJobData[] = []
const events: { type: string; data: any }[] = []
const rnd = () => randomBytes(4).toString('hex')

interface Session {
  cookie: string
  companyId: string
  userId: string
}
async function signUp(): Promise<Session> {
  const email = `t101-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.101.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}
const call = async (s: Session, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: (await res.json()) as any }
}

/** Perfil conectado pelo OAuth da T99 com as contas incluídas no dashboard. */
async function connected(s: Session, act: string): Promise<void> {
  const fbUser = `fb-${rnd()}`
  fake.addUser({ id: fbUser, name: 'Ana', adAccounts: [{ id: act, name: 'Conta', currency: 'BRL' }] })
  fake.setStructure(act, { campaigns: [{ id: `${act}-c`, name: 'C', effective_status: 'ACTIVE' }], adsets: [], ads: [] })
  fake.setInsights(act, 'campaign', [{ campaign_id: `${act}-c`, spend: '12.5', actions: [{ action_type: 'link_click', value: '3' }] }])
  const start = await call(s, 'POST', '/api/meta/oauth/start', {})
  const state = new URL(start.body.oauth_url).searchParams.get('state')!
  await app.request(`/api/meta/oauth/callback?${new URLSearchParams({ code: fake.issueCode(fbUser, REDIRECT), state })}`, { headers: { cookie: s.cookie } })
  await db.update(metaAdAccounts).set({ includedInDashboard: true }).where(eq(metaAdAccounts.companyId, s.companyId))
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
    metaSyncEnqueue: async (d) => void jobs.push(d),
    realtimePublisher: { publish: async (_c: string, type: string, data: unknown) => void events.push({ type, data }) } as never,
  })
}, 120_000)

afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('GET /api/meta/structure-bundle', () => {
  it('síncrono → 200 ready com os três níveis; async → 202 loading + job + meta.bundle.progress; depois do job → 200 do cache', async () => {
    const s = await signUp()
    await connected(s, 'act_9101')
    const sync = await call(s, 'GET', '/api/meta/structure-bundle?status_filter=all&date_preset=7d')
    expect(sync.status).toBe(200)
    expect(sync.body).toMatchObject({ status: 'ready', targets_done: 1, campaign: [expect.objectContaining({ id: 'act_9101-c', metrics: expect.objectContaining({ meta_spend: 12.5, meta_link_clicks: 3 }) })], adset: [], ad: [] })

    const async1 = await call(s, 'GET', '/api/meta/structure-bundle?status_filter=all&date_preset=30d&async=1')
    expect(async1.status).toBe(202)
    expect(async1.body).toMatchObject({ status: 'loading', targets_total: 1 })
    expect(jobs.at(-1)).toMatchObject({ companyId: s.companyId, bundleKey: async1.body.bundle_key })
    expect(events.at(-1)).toMatchObject({ type: 'meta.bundle.progress', data: { status: 'loading', bundle_key: async1.body.bundle_key } })
  })

  it('validação → 422; sem facebook.campaigns → 403', async () => {
    const s = await signUp()
    expect((await call(s, 'GET', '/api/meta/structure-bundle?level=x')).status).toBe(422)
    expect((await call(s, 'GET', '/api/meta/structure-bundle?date_preset=custom')).status).toBe(422)
    const m = await signUp()
    await db.insert(companyMembers).values({ companyId: s.companyId, userId: m.userId, role: 'member', permissionKeys: ['chat.view'] })
    await db.update(users).set({ lastCompanyId: s.companyId }).where(eq(users.id, m.userId))
    expect((await call({ ...m, companyId: s.companyId }, 'GET', '/api/meta/structure-bundle')).status).toBe(403)
  })
})
