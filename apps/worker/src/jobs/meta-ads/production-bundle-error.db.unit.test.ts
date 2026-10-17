/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON da API lidas como dados */
// T129 montado como produção: worker por `startProductionWorker` (job `meta-sync`, BullMQ real) e API por
// `createProductionApiDeps`, contra o FakeMetaGraph com `failAccount` (nunca a Graph real). Antes, o bundle pronto com
// erro não ia ao cache, o GET `async=1` seguinte reenfileirava `bundle-<key>` e o BullMQ ignorava o `add` (job
// concluído retido): a resposta ficava em `loading` até o estado expirar (15 min).
import { randomBytes } from 'node:crypto'
import { createApp, createProductionApiDeps, type ProductionApi } from '@crm/api'
import { defineQueue, META_SYNC_QUEUE, type MetaSyncJobData } from '@crm/core'
import { FakeMetaGraph } from '@crm/core/meta-testing'
import { metaAdAccounts, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, generateCredentialsKey, initCredentialsCrypto, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startProductionWorker, type ProductionWorker } from '../../boot/production-worker'

const id = randomBytes(4).toString('hex')
const KEY = generateCredentialsKey()
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const REDIRECT = 'http://api.test/api/meta/oauth/callback'
const fake = new FakeMetaGraph({ appId: `app-${id}`, appSecret: `secret-${id}` })
const META_KEYS = ['META_APP_ID', 'META_APP_SECRET', 'META_GRAPH_URL', 'META_OAUTH_REDIRECT_URI', 'CRM_QUEUE_PREFIX', 'REDIS_URL'] as const
const saved = Object.fromEntries(META_KEYS.map((k) => [k, process.env[k]]))
const PREFIX = `crm_t129_${id}`

let tmp: TempDatabase
let redis: Redis
let crmWorker: ProductionWorker
let app: ReturnType<typeof createApp>
let api: ProductionApi
let db: Database
let queue: ReturnType<typeof defineQueue<MetaSyncJobData>>

beforeAll(async () => {
  await fake.start()
  // Redis e prefixo de filas próprios: os workers de outros worktrees não consomem estes jobs.
  process.env.REDIS_URL = `redis://127.0.0.1:6379/${2 + (randomBytes(1)[0]! % 14)}`
  process.env.CRM_QUEUE_PREFIX = PREFIX
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
    CRM_QUEUE_PREFIX: PREFIX,
    CREDENTIALS_KEY: KEY,
    LOG_LEVEL: 'silent',
    WA_GATEWAY: 'fake',
    NODE_ENV: 'test',
    ...meta,
  }
  crmWorker = await startProductionWorker({ env, migrate: false, handleSignals: false, logger: createLogger({ level: 'silent' }) })
  db = crmWorker.db
  api = await createProductionApiDeps({ env: { ...env, TRUST_PROXY: 'true' }, db, migrate: false, logger: createLogger({ level: 'silent' }) })
  app = createApp({ ...api.deps, mailer: new MemoryMailer() })
  queue = defineQueue<MetaSyncJobData>(META_SYNC_QUEUE, { prefix: PREFIX })
}, 180_000)

afterAll(async () => {
  await queue?.close()
  api?.dispose()
  await api?.close()
  await crmWorker?.stop()
  await fake.close()
  const keys = [...(await redis.keys(`${PREFIX}:*`)), ...(await redis.keys('crm:meta:*'))]
  if (keys.length) await redis.del(...keys)
  await redis.quit()
  await tmp?.drop()
  for (const k of META_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}, 60_000)

const rnd = () => randomBytes(3).toString('hex')
async function signUp(): Promise<{ cookie: string; companyId: string }> {
  const email = `t129-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.129.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }),
  })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id }
}
async function get(s: { cookie: string }, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path, { headers: { ...H, cookie: s.cookie } })
  return { status: res.status, body: (await res.json()) as any }
}
/** Relê até `fn` devolver algo; o prazo é bem menor que os 15 min do estado preso. */
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout esperando ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}
const jobsOf = async (bundleKey: string) =>
  (await queue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed'])).filter((j) => (j.data as MetaSyncJobData).bundleKey === bundleKey)

describe('Bundle Meta async montado como produção (T129)', () => {
  it('AC-T129-01/02/03: erro de conta não prende em loading; sem erro vem do cache; GETs simultâneos → 1 job', async () => {
    const s = await signUp()
    const act = `act_129${Math.floor(Math.random() * 1e6)}`
    const fbUser = `fb-${rnd()}`
    fake.addUser({ id: fbUser, name: 'Ana', adAccounts: [{ id: act, name: 'Conta', currency: 'BRL' }] })
    fake.setStructure(act, {
      campaigns: [{ id: `${act}-c`, name: 'C', effective_status: 'ACTIVE' }],
      adsets: [{ id: `${act}-s`, name: 'S', campaign_id: `${act}-c`, effective_status: 'ACTIVE' }],
      ads: [{ id: `${act}-a`, name: 'A', campaign_id: `${act}-c`, adset_id: `${act}-s`, effective_status: 'ACTIVE' }],
    })
    fake.setInsights(act, 'campaign', [{ campaign_id: `${act}-c`, spend: '50' }])
    fake.setInsights(act, 'adset', [{ adset_id: `${act}-s`, spend: '50' }])
    fake.setInsights(act, 'ad', [{ ad_id: `${act}-a`, spend: '50' }])
    const start = await app.request('/api/meta/oauth/start', { method: 'POST', headers: { ...H, cookie: s.cookie }, body: '{}' })
    const state = new URL(((await start.json()) as any).oauth_url).searchParams.get('state')!
    await app.request(`/api/meta/oauth/callback?${new URLSearchParams({ code: fake.issueCode(fbUser, REDIRECT), state })}`, { headers: { cookie: s.cookie } })
    await db.update(metaAdAccounts).set({ includedInDashboard: true }).where(eq(metaAdAccounts.companyId, s.companyId))

    // AC-T129-01: conta falhando → job conclui `ready` com errors[]; a releitura sai de `loading` (antes: presa 15 min).
    fake.failAccount(act, 400, { message: 'Permissions error', type: 'OAuthException', code: 200 })
    const url = '/api/meta/structure-bundle?status_filter=all&date_preset=30d&display_currency=BRL&async=1'
    const first = await get(s, url)
    expect(first).toMatchObject({ status: 202, body: { status: 'loading' } })
    const key: string = first.body.bundle_key
    const withError = await until('pronto com erro', async () => {
      const r = await get(s, url)
      return r.status === 200 && r.body.status === 'ready' ? r.body : null
    })
    expect(withError.errors).toEqual([expect.objectContaining({ fb_ad_account_id: act, error: 'Permissions error' })])
    expect(await jobsOf(key)).toHaveLength(1)

    // Expirado o pronto com erro (TTL curto, simulado): o GET seguinte enfileira job NOVO, que o worker roda.
    fake.clearAccountFailure(act)
    await redis.del(`crm:meta:state:${key}`)
    expect((await get(s, url)).status).toBe(202)
    const ok = await until('pronto sem erro', async () => {
      const r = await get(s, url)
      return r.status === 200 && r.body.status === 'ready' && r.body.errors.length === 0 ? r.body : null
    })
    expect(ok.campaign).toHaveLength(1)
    expect(await jobsOf(key)).toHaveLength(2)

    // AC-T129-02: sem erro → cache (sem job); force_refresh → job novo.
    expect(await get(s, url)).toMatchObject({ status: 200, body: { status: 'ready', cached: true } })
    expect(await jobsOf(key)).toHaveLength(2)
    expect(await get(s, `${url}&force_refresh=1`)).toMatchObject({ status: 202, body: { status: 'refreshing' } })
    await until('job de force_refresh', async () => (await jobsOf(key)).length === 3)

    // AC-T129-03: 5 GETs simultâneos numa chave sem cache → 1 job.
    const url2 = '/api/meta/structure-bundle?status_filter=all&date_preset=7d&display_currency=BRL&async=1'
    const burst = await Promise.all(Array.from({ length: 5 }, () => get(s, url2)))
    expect(burst.map((r) => r.status)).toEqual(Array(5).fill(202))
    const key2: string = burst[0]!.body.bundle_key
    expect(key2).not.toBe(key)
    expect(await jobsOf(key2)).toHaveLength(1)
    await until('bundle 7d', async () => (await get(s, url2)).status === 200)
  }, 120_000)
})
