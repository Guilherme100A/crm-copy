/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON da API lidas como dados */
// Vendas internas × anúncios montadas como produção (T105): worker por `startProductionWorker` (job `meta-sync`) e API
// por `createProductionApiDeps`, contra o FakeMetaGraph (nunca a Graph real). O bundle traz `purchases_leona`,
// `purchase_value_leona(_display)` e `roas_internal` pelos dois caminhos: job do worker (async) e montagem na API (sync).
import { randomBytes } from 'node:crypto'
import { createApp, createProductionApiDeps, type ProductionApi } from '@crm/api'
import { FakeMetaGraph } from '@crm/core/meta-testing'
import { metaAdAccounts, sales, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import {
  createLogger,
  generateCredentialsKey,
  initCredentialsCrypto,
  MemoryMailer,
  redisConnection,
} from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startProductionWorker, type ProductionWorker } from './production-worker'

const id = randomBytes(4).toString('hex')
const KEY = generateCredentialsKey()
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const REDIRECT = 'http://api.test/api/meta/oauth/callback'
const fake = new FakeMetaGraph({ appId: `app-${id}`, appSecret: `secret-${id}` })
const META_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_GRAPH_URL',
  'META_OAUTH_REDIRECT_URI',
  'CRM_QUEUE_PREFIX',
  'REDIS_URL',
] as const
const saved = Object.fromEntries(META_KEYS.map((k) => [k, process.env[k]]))

let tmp: TempDatabase
let redis: Redis
let crmWorker: ProductionWorker
let app: ReturnType<typeof createApp>
let api: ProductionApi
let db: Database

beforeAll(async () => {
  await fake.start()
  // Redis e prefixo de filas próprios: os workers de outros worktrees não consomem estes jobs.
  process.env.REDIS_URL = `redis://127.0.0.1:6379/${2 + (randomBytes(1)[0]! % 14)}`
  process.env.CRM_QUEUE_PREFIX = `crm_t105_${id}`
  const meta = {
    META_APP_ID: fake.appId,
    META_APP_SECRET: fake.appSecret,
    META_GRAPH_URL: `${fake.url}/v26.0`,
    META_OAUTH_REDIRECT_URI: REDIRECT,
  }
  Object.assign(process.env, meta)
  tmp = await createTempDatabase({ migrate: true })
  redis = redisConnection()
  initCredentialsCrypto({ key: KEY })
  const env = {
    DATABASE_URL: tmp.url,
    REDIS_URL: process.env.REDIS_URL,
    CRM_QUEUE_PREFIX: process.env.CRM_QUEUE_PREFIX,
    CREDENTIALS_KEY: KEY,
    LOG_LEVEL: 'silent',
    WA_GATEWAY: 'fake',
    NODE_ENV: 'test',
    ...meta,
  }
  crmWorker = await startProductionWorker({
    env,
    migrate: false,
    handleSignals: false,
    logger: createLogger({ level: 'silent' }),
  })
  db = crmWorker.db
  api = await createProductionApiDeps({
    env: { ...env, TRUST_PROXY: 'true' },
    db,
    migrate: false,
    logger: createLogger({ level: 'silent' }),
  })
  app = createApp({ ...api.deps, mailer: new MemoryMailer() })
}, 180_000)

afterAll(async () => {
  api?.dispose()
  await api?.close()
  await crmWorker?.stop()
  await fake.close()
  const keys = await redis.keys(`crm_t105_${id}:*`)
  if (keys.length) await redis.del(...keys)
  await redis.quit()
  await tmp?.drop()
  for (const k of META_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}, 60_000)

interface Session {
  cookie: string
  companyId: string
}
const rnd = () => randomBytes(3).toString('hex')
async function signUp(): Promise<Session> {
  const email = `t105-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.105.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }),
  })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ email, password: '12345678' }),
  })
  return {
    cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0],
    companyId: user.last_company_id,
  }
}
async function call(s: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method,
    headers: { ...H, cookie: s.cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout esperando ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

describe('Vendas internas no bundle montado como produção', () => {
  it('AC-T105-01/02/03: job meta-sync (worker) e montagem síncrona (API) trazem purchases_leona e roas_internal', async () => {
    const s = await signUp()
    const act = `act_105${Math.floor(Math.random() * 1e6)}`
    const fbUser = `fb-${rnd()}`
    const [a1, a2] = [`${act}01`, `${act}02`]
    fake.addUser({ id: fbUser, name: 'Ana', adAccounts: [{ id: act, name: 'Conta', currency: 'BRL' }] })
    fake.setStructure(act, {
      campaigns: [{ id: `${act}-c`, name: 'C', effective_status: 'ACTIVE' }],
      adsets: [{ id: `${act}-s`, name: 'S', campaign_id: `${act}-c`, effective_status: 'ACTIVE' }],
      ads: [
        { id: a1, name: 'A1', campaign_id: `${act}-c`, adset_id: `${act}-s`, effective_status: 'ACTIVE' },
        { id: a2, name: 'A2', campaign_id: `${act}-c`, adset_id: `${act}-s`, effective_status: 'ACTIVE' },
      ],
    })
    fake.setInsights(act, 'campaign', [{ campaign_id: `${act}-c`, spend: '50' }])
    fake.setInsights(act, 'adset', [{ adset_id: `${act}-s`, spend: '50' }])
    fake.setInsights(act, 'ad', [
      { ad_id: a1, spend: '50' },
      { ad_id: a2, spend: '0' },
    ])
    const start = await call(s, 'POST', '/api/meta/oauth/start', {})
    expect(start.status).toBe(200)
    const state = new URL(start.body.oauth_url).searchParams.get('state')!
    await app.request(
      `/api/meta/oauth/callback?${new URLSearchParams({ code: fake.issueCode(fbUser, REDIRECT), state })}`,
      { headers: { cookie: s.cookie } },
    )
    await db.update(metaAdAccounts).set({ includedInDashboard: true }).where(eq(metaAdAccounts.companyId, s.companyId))

    // Vendas de 1 dia atrás (dentro dos 30 dias): 2 aprovadas no A1, 1 no A2; reembolsada e sem source_id ficam fora.
    const soldAt = new Date(Date.now() - 24 * 3600_000)
    await db.insert(sales).values([
      { companyId: s.companyId, amountCents: 10_000, soldAt, sourceId: a1 },
      { companyId: s.companyId, amountCents: 5_000, soldAt, sourceId: a1 },
      { companyId: s.companyId, amountCents: 2_000, soldAt, sourceId: a2 },
      { companyId: s.companyId, amountCents: 9_900, soldAt, sourceId: a1, status: 'refunded' },
      { companyId: s.companyId, amountCents: 9_900, soldAt, sourceId: null },
    ])

    // 1) Assíncrono: o job meta-sync do worker de produção monta o bundle.
    const url = '/api/meta/structure-bundle?status_filter=all&date_preset=30d&display_currency=BRL'
    expect((await call(s, 'GET', `${url}&async=1`)).status).toBe(202)
    const ready = await until('bundle ready', async () => {
      const r = await call(s, 'GET', `${url}&async=1`)
      return r.status === 200 && r.body.status === 'ready' ? r.body : null
    })
    const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r.metrics]))
    expect(byId(ready.ad)[a1]).toMatchObject({
      purchases_leona: 2,
      purchase_value_leona: 150,
      purchase_value_leona_display: 150,
      roas_internal: 3,
    })
    expect(byId(ready.ad)[a2]).toMatchObject({ purchases_leona: 1, purchase_value_leona: 20, roas_internal: null })
    expect(ready.adset[0].metrics).toMatchObject({
      purchases_leona: 3,
      purchase_value_leona_display: 170,
      roas_internal: 3.4,
    })
    expect(ready.campaign[0].metrics).toMatchObject({
      purchases_leona: 3,
      purchase_value_leona_display: 170,
      roas_internal: 3.4,
    })

    // 2) Síncrono com force_refresh: a rota da API monta na hora (mesma ligação) e enxerga a venda nova.
    await db.insert(sales).values({ companyId: s.companyId, amountCents: 5_000, soldAt, sourceId: a2 })
    const sync = await call(s, 'GET', `${url}&force_refresh=1`)
    expect(sync.status).toBe(200)
    expect(byId(sync.body.ad)[a2]).toMatchObject({
      purchases_leona: 2,
      purchase_value_leona_display: 70,
      roas_internal: null,
    })
    expect(sync.body.campaign[0].metrics).toMatchObject({
      purchases_leona: 4,
      purchase_value_leona_display: 220,
      roas_internal: 4.4,
    })
    expect(sync.body.warnings).toEqual([])
  }, 120_000)
})
