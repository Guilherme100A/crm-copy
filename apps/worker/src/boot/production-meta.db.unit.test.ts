/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON da API lidas como dados */
// Montado como produção (AC-T125-01..03): worker do CRM por `startProductionWorker` (a mesma função do main.ts) e a
// API por `createProductionApiDeps` (a mesma do server.ts), contra o FakeMetaGraph. Config da Meta só pelo env, como
// em produção. WaGateway fake (o WhatsApp não participa).
import { randomBytes } from 'node:crypto'
import { createApp, createProductionApiDeps, type ProductionApi } from '@crm/api'
import { createNodeRegistry, FlowEngine, FlowStore } from '@crm/core'
import { FakeMetaGraph } from '@crm/core/meta-testing'
import { contacts, metaAdAccounts, products, sales, type Database } from '@crm/db'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, generateCredentialsKey, initCredentialsCrypto, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startProductionWorker, type ProductionWorker } from './production-worker'

const id = randomBytes(4).toString('hex')
const KEY = generateCredentialsKey()
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const REDIRECT = 'http://api.test/api/meta/oauth/callback'
const fake = new FakeMetaGraph({ appId: `app-${id}`, appSecret: `secret-${id}` })
const META_KEYS = ['META_APP_ID', 'META_APP_SECRET', 'META_GRAPH_URL', 'META_OAUTH_REDIRECT_URI', 'META_CAPI_TEST_EVENT_CODE', 'CRM_QUEUE_PREFIX', 'REDIS_URL'] as const
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
  process.env.CRM_QUEUE_PREFIX = `crm_t125_${id}`
  // As rotas Meta da API leem a config do process.env (metaConfigFromEnv/fxRatesFromEnv no default); o worker, do env do boot.
  const meta = { META_APP_ID: fake.appId, META_APP_SECRET: fake.appSecret, META_GRAPH_URL: `${fake.url}/v26.0`, META_OAUTH_REDIRECT_URI: REDIRECT, META_CAPI_TEST_EVENT_CODE: 'TEST125' }
  Object.assign(process.env, meta)
  tmp = await createTempDatabase({ migrate: true })
  redis = redisConnection()
  initCredentialsCrypto({ key: KEY })
  const env = { DATABASE_URL: tmp.url, REDIS_URL: process.env.REDIS_URL, CRM_QUEUE_PREFIX: process.env.CRM_QUEUE_PREFIX, CREDENTIALS_KEY: KEY, LOG_LEVEL: 'silent', WA_GATEWAY: 'fake', NODE_ENV: 'test', ...meta }
  crmWorker = await startProductionWorker({ env, migrate: false, handleSignals: false, logger: createLogger({ level: 'silent' }) })
  db = crmWorker.db
  // A MESMA montagem do server.ts (`sale.recorded` da API → fila meta-capi); só o e-mail fica em memória.
  api = await createProductionApiDeps({ env: { ...env, TRUST_PROXY: 'true' }, db, migrate: false, logger: createLogger({ level: 'silent' }) })
  app = createApp({ ...api.deps, mailer: new MemoryMailer() })
}, 180_000)

afterAll(async () => {
  api?.dispose()
  await api?.close()
  await crmWorker?.stop()
  await fake.close()
  const keys = await redis.keys(`crm_t125_${id}:*`)
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
  const email = `t125-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.125.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id }
}
async function call(s: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
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

describe('Meta montada como produção', () => {
  it('AC-T125-01: structure-bundle async=1 é processado pelo job meta-sync do worker e fica ready', async () => {
    const s = await signUp()
    const act = `act_125${Math.floor(Math.random() * 1e6)}`
    const fbUser = `fb-${rnd()}`
    fake.addUser({ id: fbUser, name: 'Ana', adAccounts: [{ id: act, name: 'Conta', currency: 'BRL' }] })
    fake.setStructure(act, { campaigns: [{ id: `${act}-c`, name: 'C', effective_status: 'ACTIVE' }], adsets: [], ads: [] })
    fake.setInsights(act, 'campaign', [{ campaign_id: `${act}-c`, spend: '12.5', actions: [{ action_type: 'link_click', value: '3' }] }])
    const start = await call(s, 'POST', '/api/meta/oauth/start', {})
    expect(start.status).toBe(200)
    const state = new URL(start.body.oauth_url).searchParams.get('state')!
    await app.request(`/api/meta/oauth/callback?${new URLSearchParams({ code: fake.issueCode(fbUser, REDIRECT), state })}`, { headers: { cookie: s.cookie } })
    await db.update(metaAdAccounts).set({ includedInDashboard: true }).where(eq(metaAdAccounts.companyId, s.companyId))

    const url = '/api/meta/structure-bundle?status_filter=all&date_preset=30d&async=1'
    expect((await call(s, 'GET', url)).status).toBe(202)
    const ready = await until('bundle ready', async () => {
      const r = await call(s, 'GET', url)
      return r.status === 200 && r.body.status === 'ready' ? r.body : null
    })
    expect(ready.campaign).toEqual([expect.objectContaining({ id: `${act}-c`, metrics: expect.objectContaining({ meta_spend: 12.5 }) })])
    expect(fake.requestsTo(`/${act}/insights`).length).toBeGreaterThan(0)
  }, 120_000)

  it('AC-T125-02/03: venda aprovada pela API → 1 Purchase sale-<id> no pixel com auto_send_sales; repetir a venda não reenvia', async () => {
    const s = await signUp()
    const pixelId = String(125000000000000 + Math.floor(Math.random() * 1e9))
    const token = `EAAB${randomBytes(12).toString('hex')}`
    fake.addPixel(pixelId, token)
    const otherPixel = String(Number(pixelId) + 1)
    fake.addPixel(otherPixel, token)
    expect((await call(s, 'POST', '/api/meta/pixels', { name: 'Loja', pixel_id: pixelId, access_token: token, auto_send_sales: true })).status).toBe(201)
    expect((await call(s, 'POST', '/api/meta/pixels', { name: 'Sem auto', pixel_id: otherPixel, access_token: token })).status).toBe(201)
    const [contact] = await db.insert(contacts).values({ companyId: s.companyId, name: 'Maria', phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, email: 'maria@x.com' }).returning()

    const body = { amount_cents: 19990, currency: 'BRL', status: 'approved', contact_id: contact!.id, external_id: `ext-${rnd()}` }
    const first = await call(s, 'POST', '/api/sales', body)
    expect(first.status).toBe(201)
    const saleId = first.body.sale.id
    const [ev] = await until('Purchase no fake', async () => {
      const evs = fake.capiEventsFor(pixelId)
      return evs.length ? evs : null
    })
    expect(ev!.event).toMatchObject({ event_name: 'Purchase', event_id: `sale-${saleId}`, action_source: 'system_generated', custom_data: { currency: 'BRL', value: 199.9 } })
    expect(ev!.testEventCode).toBe('TEST125')

    const again = await call(s, 'POST', '/api/sales', body)
    expect(again.status).toBe(200)
    expect(again.body.sale.id).toBe(saleId)
    // O job da venda (mesmo jobId) já terminou; dá tempo de um eventual segundo envio chegar.
    await new Promise((r) => setTimeout(r, 1500))
    expect(fake.capiEventsFor(pixelId)).toHaveLength(1)
    expect(fake.capiEventsFor(otherPixel)).toHaveLength(0)
  }, 120_000)

  it('AC-T125-02 (nó): approved_sale com o registry do processo → 1 Purchase sale-<id>; o retry do passo não reenvia', async () => {
    const s = await signUp()
    const pixelId = String(126000000000000 + Math.floor(Math.random() * 1e9))
    const token = `EAAB${randomBytes(12).toString('hex')}`
    fake.addPixel(pixelId, token)
    expect((await call(s, 'POST', '/api/meta/pixels', { name: 'Loja', pixel_id: pixelId, access_token: token, auto_send_sales: true })).status).toBe(201)
    const [product] = await db.insert(products).values({ companyId: s.companyId, name: 'Curso', currency: 'BRL', priceMinCents: 1000, priceMaxCents: 50000, priceFallbackCents: 4700 }).returning()
    const [contact] = await db.insert(contacts).values({ companyId: s.companyId, name: 'Rui', phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }).returning()
    const store = new FlowStore(db)
    const flow = await store.createFlow({ companyId: s.companyId }, { name: `Venda ${rnd()}` })
    const node = (nid: string, type: string, actions: unknown[] = []) => ({ id: nid, type, name: nid, position: { x: 0, y: 0 }, actions })
    await store.fromDefinition({ companyId: s.companyId }, flow.id, {
      schema: 'crm.flow/v1',
      entry: 'start',
      nodes: [node('start', 'start'), node('V', 'approved_sale', [{ id: 'a', type: 'register_approved_sale', order: 0, config: { product_public_id: product!.publicId, amount_template: '250,00' } }])],
      edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'V' }],
      variables: [],
      refs: {},
    })
    await store.publish({ companyId: s.companyId }, flow.id)
    // Registry padrão do processo: os nós de CRM usam as deps do configureCrmNodes do boot (publisher envelopado).
    const engine = new FlowEngine({ db, wa: new FakeWaGateway(), registry: createNodeRegistry() })
    const { runId } = await engine.startRun({ companyId: s.companyId }, { flowId: flow.id, contactId: contact!.id })
    await engine.step(runId, 0)
    const [sale] = await db.select().from(sales).where(eq(sales.companyId, s.companyId))
    expect(sale).toMatchObject({ source: 'flow', amountCents: 25000 })
    const [ev] = await until('Purchase do nó no fake', async () => {
      const evs = fake.capiEventsFor(pixelId)
      return evs.length ? evs : null
    })
    expect(ev!.event).toMatchObject({ event_name: 'Purchase', event_id: `sale-${sale!.id}`, action_source: 'system_generated', custom_data: { value: 250 } })
    await new Promise((r) => setTimeout(r, 1500))
    expect(fake.capiEventsFor(pixelId)).toHaveLength(1)
  }, 120_000)
})
