/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON da API lidas como dados */
// Emissão de NF montada como produção (T112): worker por `startProductionWorker` (a mesma função do main.ts) e API por
// `createProductionApiDeps` (a mesma do server.ts), contra o FakeNotasy (`NOTASY_API_URL` do env, como em produção).
// Prova a ligação no boot: o nó approved_sale com `note_issuer_id` emite pelo job `invoices`, e a reemissão da API
// chega ao worker. WaGateway fake (o WhatsApp não participa).
import { randomBytes } from 'node:crypto'
import { createApp, createProductionApiDeps, type ProductionApi } from '@crm/api'
import { createNodeRegistry, FakeNotasy, FlowEngine, FlowStore } from '@crm/core'
import { contacts, products, saleInvoices, sales, type Database } from '@crm/db'
import { FakeWaGateway } from '@crm/wa-port/testing'
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
import { startProductionWorker, type ProductionWorker } from '../../boot/production-worker'

const id = randomBytes(4).toString('hex')
const KEY = generateCredentialsKey()
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const TOKEN = `ntsy_PROD_${randomBytes(6).toString('hex')}`
const fake = new FakeNotasy([TOKEN])
const KEYS = ['CRM_QUEUE_PREFIX', 'REDIS_URL', 'NOTASY_API_URL'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
const logs: string[] = []

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
  process.env.CRM_QUEUE_PREFIX = `crm_t112_${id}`
  process.env.NOTASY_API_URL = fake.url
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
    NOTASY_API_URL: fake.url,
  }
  crmWorker = await startProductionWorker({
    env,
    migrate: false,
    handleSignals: false,
    logger: createLogger({ level: 'trace', destination: { write: (s: string) => void logs.push(s) } }),
  })
  db = crmWorker.db
  api = await createProductionApiDeps({
    env: { ...env, TRUST_PROXY: 'true' },
    db,
    migrate: false,
    logger: createLogger({ level: 'trace', destination: { write: (s: string) => void logs.push(s) } }),
  })
  app = createApp({ ...api.deps, mailer: new MemoryMailer() })
}, 180_000)

afterAll(async () => {
  api?.dispose()
  await api?.close()
  await crmWorker?.stop()
  await fake.stop()
  const keys = await redis.keys(`crm_t112_${id}:*`)
  if (keys.length) await redis.del(...keys)
  await redis.quit()
  await tmp?.drop()
  for (const k of KEYS) {
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
  const email = `t112-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.112.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
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

describe('NF montada como produção', () => {
  it('AC-T112-01: approved_sale com note_issuer_id → job invoices emite no fake; reemissão pela API com outro emissor chega ao worker', async () => {
    const s = await signUp()
    const noToken = await call(s, 'POST', '/api/invoice-integrations', {
      invoice_integration: { provider: 'notasy', company_name: 'Sem token' },
    })
    const good = await call(s, 'POST', '/api/invoice-integrations', {
      invoice_integration: { provider: 'notasy', company_name: 'Loja', integration_token: TOKEN },
    })
    expect([noToken.status, good.status]).toEqual([201, 201])
    const [product] = await db
      .insert(products)
      .values({
        companyId: s.companyId,
        name: 'Curso',
        currency: 'BRL',
        priceMinCents: 1000,
        priceMaxCents: 50000,
        priceFallbackCents: 4700,
      })
      .returning()
    const [contact] = await db
      .insert(contacts)
      .values({
        companyId: s.companyId,
        name: 'Rui',
        phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      })
      .returning()
    const store = new FlowStore(db)
    const flow = await store.createFlow({ companyId: s.companyId }, { name: `Venda ${rnd()}` })
    const node = (nid: string, type: string, actions: unknown[] = []) => ({
      id: nid,
      type,
      name: nid,
      position: { x: 0, y: 0 },
      actions,
    })
    await store.fromDefinition({ companyId: s.companyId }, flow.id, {
      schema: 'crm.flow/v1',
      entry: 'start',
      nodes: [
        node('start', 'start'),
        node('V', 'approved_sale', [
          {
            id: 'a',
            type: 'register_approved_sale',
            order: 0,
            config: {
              product_public_id: product!.publicId,
              amount_template: '250,00',
              note_issuer_id: noToken.body.invoice_integration.id,
            },
          },
        ]),
      ],
      edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'V' }],
      variables: [],
      refs: {},
    })
    await store.publish({ companyId: s.companyId }, flow.id)
    // Registry padrão do processo: os nós de CRM usam as deps do configureCrmNodes do boot (publisher com o emissor).
    const engine = new FlowEngine({ db, wa: new FakeWaGateway(), registry: createNodeRegistry() })
    const { runId } = await engine.startRun({ companyId: s.companyId }, { flowId: flow.id, contactId: contact!.id })
    await engine.step(runId, 0)
    const [sale] = await db.select().from(sales).where(eq(sales.companyId, s.companyId))
    expect(sale).toMatchObject({ source: 'flow', noteIssuerId: noToken.body.invoice_integration.id })

    // Emissor sem token: a emissão automática termina "Emissor não configurado" (AC-T112-02).
    const failed = await until('emissão automática', async () => {
      const [row] = await db.select().from(saleInvoices).where(eq(saleInvoices.saleId, sale!.id))
      return row && row.status !== 'pending' ? row : null
    })
    expect(failed).toMatchObject({ status: 'failed', lastError: 'Emissor não configurado' })
    expect((await call(s, 'GET', `/api/sales/${sale!.id}/invoice`)).body.invoice).toMatchObject({
      invoice_emit_status: 'failed',
      can_reemit: true,
    })

    // Reemissão escolhendo o outro emissor (AC-T112-03) → o worker emite no fake.
    const re = await call(s, 'POST', `/api/sales/${sale!.id}/reemit-invoice`, {
      invoice_integration_id: good.body.invoice_integration.id,
    })
    expect(re.status).toBe(202)
    expect(re.body.sale).toMatchObject({ id: sale!.id, invoice_emit_status: 'pending' })
    const done = await until('reemissão no worker', async () => {
      const r = await call(s, 'GET', `/api/sales/${sale!.id}/invoice`)
      return r.body.invoice?.invoice_emit_status === 'succeeded' ? r.body.invoice : null
    })
    expect(done).toMatchObject({ invoice_integration_id: good.body.invoice_integration.id, attempts: 1 })
    expect(fake.sales.filter((x) => x.body.id === sale!.id)).toHaveLength(1)
    expect(logs.join('\n')).not.toContain(TOKEN)
  }, 120_000)
})
