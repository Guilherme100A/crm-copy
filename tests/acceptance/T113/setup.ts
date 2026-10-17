// Ambiente da suíte T113 — sistema MONTADO como produção (contrato da "Entrega do operário" no brief):
// - worker do CRM pela MESMA função do main.ts: startProductionWorker({ env }) de '@crm/worker' (WA_GATEWAY=fake);
//   o boot liga configureUtmify + utmifySalePublisher no publisher das vendas (nó approved_sale);
// - API pela MESMA composição do server.ts: createProductionApiDeps({ env }) + createApp(deps) (reembolso por
//   PATCH /api/sales/:id → fila `utmify`);
// - UTMify: SÓ o FakeUtmify (@crm/core) em UTMIFY_API_URL; nunca a UTMify real;
// - backoff encurtado por configureUtmify({ retryBaseMs }) (base injetável declarada pelo operário);
// - filas isoladas pelo CRM_QUEUE_PREFIX da execução (config da aceitação, T121);
// - logs da API e do worker capturados (AC-T113-04: o token nunca aparece em log).
// A venda com utmify_integration_id nasce do bloco "Venda aprovada" de um fluxo REAL criado/ativado pela API e executado
// pelo FlowEngine com o registry padrão do processo (nós de CRM com as deps do boot). Os utm_* do contato entram pela
// porta pública AttributionService.recordTouch (T73), a mesma usada pelas fontes de venda.
import { randomBytes } from 'node:crypto'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, fakePhone, uniqueId } from '../helpers/factories'
import { connectSse, type SseConnection } from '../helpers/sse'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Base do backoff entre chamadas à UTMify nos testes (produção: 10 s). */
export const RETRY_BASE_MS = 400

export interface System {
  fake: Any
  core: Any
  db: Any
  app: Any
  logs: string[]
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startSystem(tokens: string[]): Promise<System> {
  const core: Any = await import('@crm/core')
  const kit: Any = await import('@crm/node-kit')
  const wk: Any = await import('@crm/worker')
  const api: Any = await import('@crm/api')
  const { createTempDatabase }: Any = await import('@crm/db/testing')
  for (const n of ['FakeUtmify', 'FlowEngine', 'createNodeRegistry', 'AttributionService'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)

  const fake = new core.FakeUtmify(tokens)
  await fake.start()
  const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
  const KEY = kit.generateCredentialsKey()
  const saved = { UTMIFY_API_URL: process.env.UTMIFY_API_URL, CREDENTIALS_KEY: process.env.CREDENTIALS_KEY }
  process.env.UTMIFY_API_URL = fake.url
  process.env.CREDENTIALS_KEY = KEY
  kit.resetCredentialsCrypto?.()
  kit.initCredentialsCrypto?.({ key: KEY })

  const tmp = await createTempDatabase({ migrate: true })
  const logs: string[] = []
  const logger = (tag: string) => kit.createLogger({ level: 'trace', destination: { write: (s: string) => void logs.push(`[${tag}] ${s}`) } })
  const env = {
    ...process.env,
    DATABASE_URL: tmp.url,
    REDIS_URL,
    CREDENTIALS_KEY: KEY,
    WA_GATEWAY: 'fake',
    AI_MODE: 'fake',
    LOG_LEVEL: 'trace',
    UTMIFY_API_URL: fake.url,
    ANTIBAN_MODE: 'passthrough',
  }
  let prod: Any
  let production: Any
  const close = async () => {
    production?.dispose?.()
    await production?.close?.().catch(() => {})
    await prod?.stop?.().catch(() => {})
    await fake.stop().catch(() => {})
    await tmp.drop().catch(() => {})
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    prod = await wk.startProductionWorker({ env, migrate: false, handleSignals: false, logger: logger('worker') })
    // Base do backoff injetável (brief: `configureUtmify({ retryBaseMs })`); mesmo módulo que o boot configurou.
    const jobs: Any = await import('../../../apps/worker/src/jobs/utmify/index')
    jobs.configureUtmify({ retryBaseMs: RETRY_BASE_MS, notVisibleBaseMs: 100 })
    const db = prod.db
    db.$client.on?.('error', () => {})
    production = await api.createProductionApiDeps({ env: { ...env, TRUST_PROXY: 'true' }, db, migrate: false, logger: logger('api') })
    const app = api.createApp({ ...production.deps, mailer: new kit.MemoryMailer() })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { fake, core, db, app, logs, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

export interface Owner {
  c: ApiClient
  companyId: string
  token: string
}

const randomIp = () => `10.113.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export async function newOwner(sys: System): Promise<Owner> {
  const ip = randomIp()
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return sys.app.request(path, { ...init, headers })
    },
  })
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t113')
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t113')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  return { c, companyId, token: c.cookies.get('crm_session')! }
}

/** Integração UTMify pela API (sem `token` → `token_configured:false`). */
export async function createIntegration(o: Owner, companyName: string, token?: string): Promise<Any> {
  const r = await o.c.post('/api/utmify-integrations', {
    utmify_integration: { company_name: companyName, ...(token !== undefined ? { integration_token: token } : {}) },
  })
  if (r.status !== 201) throw new Error(`integração: ${r.status} ${r.text}`)
  return r.body.utmify_integration
}

export async function newContact(o: Owner, extra: Record<string, unknown> = {}): Promise<Any> {
  const r = await o.c.post('/api/contacts', { name: `Cliente ${uniqueId('c')}`, phone: fakePhone(), ...extra })
  if (r.status !== 201) throw new Error(`contato: ${r.status} ${r.text}`)
  return r.body.contact ?? r.body
}

export async function newProduct(o: Owner): Promise<Any> {
  const r = await o.c.post('/api/products', { name: `Curso ${uniqueId('p')}`, currency: 'BRL', price_min_cents: 1000, price_max_cents: 90_000, price_fallback_cents: 4700 })
  if (r.status !== 201) throw new Error(`produto: ${r.status} ${r.text}`)
  return r.body.product ?? r.body
}

/** Toque de atribuição do contato pela porta pública da T73 (a mesma das fontes de venda). */
export async function touch(sys: System, o: Owner, contactId: string, t: Record<string, string | null>, at: Date): Promise<void> {
  await new sys.core.AttributionService(sys.db).recordTouch(o.companyId, contactId, t, { at })
}

/** Fluxo start → "Venda aprovada" criado, definido e ativado pela API. */
export async function saleFlow(
  o: Owner,
  productPublicId: string,
  utmifyIntegrationId?: string | null,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const f = await o.c.post('/api/flows', { name: uniqueId('Venda T113') })
  if (f.status !== 201) throw new Error(`fluxo: ${f.status} ${f.text}`)
  const id = (f.body.flow ?? f.body).id
  const config: Record<string, unknown> = { product_public_id: productPublicId, amount_template: '250,00', ...extra }
  if (utmifyIntegrationId !== undefined) config.utmify_integration_id = utmifyIntegrationId
  const def = {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'start', position: { x: 0, y: 0 }, actions: [] },
      { id: 'V', type: 'approved_sale', name: 'V', position: { x: 200, y: 0 }, actions: [{ id: 'a1', type: 'register_approved_sale', order: 0, config }] },
    ],
    edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'V' }],
    variables: [],
    refs: {},
  }
  const put = await o.c.put(`/api/flows/${id}/definition`, def)
  if (put.status >= 300) throw new Error(`definição: ${put.status} ${put.text}`)
  const act = await o.c.post(`/api/flows/${id}/activate`, {})
  if (act.status >= 300) throw new Error(`ativar: ${act.status} ${act.text}`)
  return id
}

/** Roda o fluxo para o contato (FlowEngine com o registry padrão do processo) e devolve a venda criada pelo bloco. */
export async function runSale(sys: System, o: Owner, flowId: string, contactId: string): Promise<string> {
  const { FakeWaGateway }: Any = await import('@crm/wa-port/testing')
  const engine = new sys.core.FlowEngine({ db: sys.db, wa: new FakeWaGateway(), registry: sys.core.createNodeRegistry() })
  const { runId } = await engine.startRun({ companyId: o.companyId }, { flowId, contactId })
  await engine.step(runId, 0)
  const rows = await sys.q(`SELECT id FROM crm.sales WHERE company_id = $1 AND contact_id = $2 ORDER BY created_at DESC`, [o.companyId, contactId])
  if (!rows[0]) throw new Error('o bloco Venda aprovada não gravou a venda')
  return rows[0].id
}

export async function utmifyOf(o: Owner, saleId: string): Promise<Any> {
  const r = await o.c.get(`/api/sales/${saleId}/utmify`)
  if (r.status !== 200) throw new Error(`utmify: ${r.status} ${r.text}`)
  return r.body.utmify
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms: number, what: string, every = 50): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as T
    if (Date.now() > deadline) throw new Error(`timeout (${ms} ms) esperando ${what}`)
    await new Promise((r) => setTimeout(r, every))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function sse(sys: System, o: Owner): Promise<SseConnection> {
  const conn = await connectSse((p, i) => sys.app.request(p, i), `/api/events?company_id=${o.companyId}`, { cookie: `crm_session=${o.token}` })
  if (conn.status !== 200) throw new Error(`SSE: ${conn.status} ${conn.text}`)
  return conn
}

/** Instantes (ms) em que cada nova request chegou ao fake, observados por polling curto. */
export function watchRequests(fake: Any, filter: (r: Any) => boolean) {
  const at: number[] = []
  let seen = fake.requests.filter(filter).length
  const tick = () => {
    const n = fake.requests.filter(filter).length
    while (seen < n) {
      at.push(Date.now())
      seen++
    }
  }
  const timer = setInterval(tick, 10)
  return { at, stop: () => (clearInterval(timer), tick()) }
}
