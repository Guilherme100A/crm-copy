/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON da API e opções internas lidas como dados */
// Montado como produção (AC-T127-01..07): worker do CRM por `startProductionWorker` (a mesma função do main.ts) e a API
// por `createProductionApiDeps` (a mesma do server.ts). FakeMetaGraph para o Pixel, FakeLlm (AI_MODE=fake) e WaGateway
// fake. A ponta a ponta de pagamento (FakeXPag), do turno do agente e da criação assistida fica com a suíte do Tester;
// aqui conferimos que os módulos do processo receberam as dependências de produção.
import { randomBytes } from 'node:crypto'
import { text } from '@crm/ai'
import { createApp, createProductionApiDeps, type ProductionApi } from '@crm/api'
import { createNodeRegistry, defineQueue, EXPORTS_QUEUE, FlowEngine, FlowStore } from '@crm/core'
import { FakeMetaGraph } from '@crm/core/meta-testing'
import { aiAgents, aiKnowledgeSources, aiUsage, aiWallets, backgroundJobs, connections, contacts, flowRuns, flowRunSteps, inboundWebhookRequests, llmPrices, sales, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, generateCredentialsKey, initCredentialsCrypto, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { and, eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { aiAgentRuntime } from '../jobs/ai-agent'
import { aiAgentLabService } from '../jobs/ai-agent-lab'
import { INBOUND_WEBHOOKS_QUEUE } from '../jobs/inbound-webhooks'
import { paymentWebhookService } from '../jobs/payment-webhooks'
import type { CompanyKeyedFakeLlm } from './production'
import { startProductionWorker, type ProductionWorker } from './production-worker'

const id = randomBytes(4).toString('hex')
const KEY = generateCredentialsKey()
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const fake = new FakeMetaGraph({ appId: `app-${id}`, appSecret: `secret-${id}` })
const PREFIX = `crm_t127_${id}`
const ENV_KEYS = ['META_APP_ID', 'META_APP_SECRET', 'META_GRAPH_URL', 'META_OAUTH_REDIRECT_URI', 'CRM_QUEUE_PREFIX', 'REDIS_URL'] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

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
  process.env.CRM_QUEUE_PREFIX = PREFIX
  const meta = { META_APP_ID: fake.appId, META_APP_SECRET: fake.appSecret, META_GRAPH_URL: `${fake.url}/v26.0`, META_OAUTH_REDIRECT_URI: 'http://api.test/api/meta/oauth/callback' }
  Object.assign(process.env, meta)
  tmp = await createTempDatabase({ migrate: true })
  redis = redisConnection()
  initCredentialsCrypto({ key: KEY })
  const env = { DATABASE_URL: tmp.url, REDIS_URL: process.env.REDIS_URL, CRM_QUEUE_PREFIX: PREFIX, CREDENTIALS_KEY: KEY, LOG_LEVEL: 'silent', WA_GATEWAY: 'fake', NODE_ENV: 'test', AI_MODE: 'fake', ...meta }
  crmWorker = await startProductionWorker({ env, migrate: false, handleSignals: false, logger: createLogger({ level: 'silent' }) })
  db = crmWorker.db
  api = await createProductionApiDeps({ env: { ...env, TRUST_PROXY: 'true' }, db, migrate: false, logger: createLogger({ level: 'silent' }) })
  app = createApp({ ...api.deps, mailer: new MemoryMailer() })
}, 180_000)

afterAll(async () => {
  api?.dispose()
  await api?.close()
  await crmWorker?.stop()
  await fake.close()
  const keys = await redis.keys(`${PREFIX}:*`)
  if (keys.length) await redis.del(...keys)
  await redis.quit()
  await tmp?.drop()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}, 60_000)

interface Session {
  cookie: string
  companyId: string
}
const rnd = () => randomBytes(3).toString('hex')
const phone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
async function signUp(): Promise<Session> {
  const email = `t127-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.127.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id }
}
async function call(s: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const t = await res.text()
  return { status: res.status, body: t ? (JSON.parse(t) as any) : {} }
}
const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout esperando ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}
const node = (nid: string, type: string, actions: unknown[] = []) => ({ id: nid, type, name: nid, position: { x: 0, y: 0 }, actions })
async function publish(companyId: string, nodes: unknown[], edges: unknown[]) {
  const store = new FlowStore(db)
  const flow = await store.createFlow({ companyId }, { name: `F ${rnd()}` })
  await store.fromDefinition({ companyId }, flow.id, { schema: 'crm.flow/v1', entry: 'start', nodes: nodes as never, edges: edges as never, variables: [], refs: {} })
  await store.publish({ companyId }, flow.id)
  return flow.id
}

describe('T127 montado como produção', () => {
  it('AC-T127-01: POST na URL pública do webhook de entrada → request processado pelo worker e fluxo iniciado; varredura agendada', async () => {
    const queue = defineQueue(INBOUND_WEBHOOKS_QUEUE)
    const schedulers = await queue.getJobSchedulers()
    await queue.close()
    expect(schedulers.map((j) => j.key)).toContain('inbound-webhooks-sweep')

    const s = await signUp()
    const flowId = await publish(s.companyId, [node('start', 'start')], [])
    const instance = phone()
    await db.insert(connections).values({ companyId: s.companyId, sessionId: `s-${rnd()}`, name: 'Loja', phoneNumber: instance, connectionState: 'open' })
    const hook = await call(s, 'POST', '/api/inbound-webhooks', {
      name: 'Lead',
      config: { field_paths: { full_name: [{ kind: 'path', value: 'nome' }], phone: [{ kind: 'path', value: 'fone' }] }, trigger_flow: true, flow_id: flowId, connection_value: instance },
    })
    expect(hook.status).toBe(201)
    const token = hook.body.webhook.public_token
    expect((await post(`/api/hooks/in/${token}`, { nome: 'Bia', fone: phone() })).status).toBeLessThan(300)
    const req = await until('request processado', async () => {
      const [r] = await db.select().from(inboundWebhookRequests).where(eq(inboundWebhookRequests.companyId, s.companyId))
      return r?.processedAt ? r : null
    })
    expect(req.processingStatus).toBe('processed')
    const [run] = await db.select().from(flowRuns).where(and(eq(flowRuns.companyId, s.companyId), eq(flowRuns.flowId, flowId)))
    expect(run).toBeDefined()
    const [lead] = await db.select().from(contacts).where(eq(contacts.id, run!.contactId))
    expect(lead).toMatchObject({ name: 'Bia', consent: true, consentSource: 'webhook' })
  }, 120_000)

  it('AC-T127-02: fonte de venda montada → aprovada gera 1 Purchase; pending não gera; pending → approved gera 1', async () => {
    const s = await signUp()
    const pixelId = String(127000000000000 + Math.floor(Math.random() * 1e9))
    const token = `EAAB${randomBytes(12).toString('hex')}`
    fake.addPixel(pixelId, token)
    expect((await call(s, 'POST', '/api/meta/pixels', { name: 'Loja', pixel_id: pixelId, access_token: token, auto_send_sales: true })).status).toBe(201)
    const src = (await call(s, 'POST', '/api/sale-sources', { name: 'Loja', mapping: { external_id: '$.id', status: '$.status', amount: '$.total', phone: '$.phone' } })).body.sale_source
    const send = async (body: Record<string, unknown>) => expect((await post(`/api/hooks/sales/${src.token}`, body)).status).toBe(202)
    const saleOf = (ext: string) => until(`venda ${ext}`, async () => (await db.select().from(sales).where(and(eq(sales.companyId, s.companyId), eq(sales.externalId, ext))))[0])
    const purchases = (saleId: string) => fake.capiEventsFor(pixelId).filter((e) => e.event.event_id === `sale-${saleId}`)

    await send({ id: 'A-1', status: 'paid', total: '99,90', phone: phone() })
    const approved = await saleOf('A-1')
    await until('Purchase da aprovada', async () => purchases(approved.id).length > 0)

    const p = phone()
    await send({ id: 'P-1', status: 'pending', total: '50', phone: p })
    const pending = await saleOf('P-1')
    await new Promise((r) => setTimeout(r, 1500))
    expect(purchases(pending.id)).toHaveLength(0)
    await send({ id: 'P-1', status: 'approved', total: '50', phone: p })
    await until('Purchase da pending → approved', async () => purchases(pending.id).length > 0)
    await new Promise((r) => setTimeout(r, 1500))
    expect(purchases(pending.id)).toHaveLength(1)
    expect(purchases(approved.id)).toHaveLength(1)
  }, 120_000)

  it('AC-T127-03: o webhook de pagamento do worker usa o FlowControl do processo', () => {
    const svc = paymentWebhookService() as any
    expect(svc).toBeDefined()
    expect(typeof svc.opts.control.resolvePayment).toBe('function')
    expect(typeof svc.opts.control.interruptForPayment).toBe('function')
    expect(svc.opts.integrations).toBeDefined()
  })

  it('AC-T127-04: nó de IA → ai_usage flow_ai; ai_integration_id usa a chave da integração; cota esgotada → falha sem LLM', async () => {
    const s = await signUp()
    const llm = crmWorker.production.llm as CompanyKeyedFakeLlm
    const fakeLlm = crmWorker.production.fakeLlm!
    const key = await crmWorker.production.keys.create(s.companyId, { provider: 'anthropic', name: 'Claude', secret: 'sk-ant-t127-fake' })
    await db.insert(llmPrices).values({ provider: 'anthropic', model: 'claude-t127', effectiveFrom: new Date('2020-01-01T00:00:00Z'), inputPerMtokMicros: 3_000_000, outputPerMtokMicros: 15_000_000 }).onConflictDoNothing()
    await db.insert(aiWallets).values({ companyId: s.companyId, balanceCredits: 1_000_000, status: 'ok' }).onConflictDoUpdate({ target: aiWallets.companyId, set: { balanceCredits: 1_000_000, status: 'ok' } })
    const config = { provider: 'gpt', api_key_source: 'integration', ai_integration_id: key.id, model: 'claude-t127', system_prompt: 'Responda', user_message: 'oi' }
    const flowId = await publish(
      s.companyId,
      [node('start', 'start'), node('A', 'ai', [{ id: 'a', type: 'ai_call', order: 0, config }]), node('OK', 'start'), node('F', 'start')],
      [
        { id: 'e1', from: 'start', handle: 'source', to: 'A' },
        { id: 'e2', from: 'A', handle: 'success', to: 'OK' },
        { id: 'e3', from: 'A', handle: 'failure', to: 'F' },
      ],
    )
    const [contact] = await db.insert(contacts).values({ companyId: s.companyId, name: 'Rui', phoneE164: phone() }).returning({ id: contacts.id })
    // Registry padrão do processo: o nó de IA usa as deps do configureExternalNodes do boot.
    const engine = new FlowEngine({ db, wa: new FakeWaGateway(), registry: createNodeRegistry() })
    const runOnce = async () => {
      const { runId } = await engine.startRun({ companyId: s.companyId }, { flowId, contactId: contact!.id })
      await engine.step(runId, 0)
      return runId
    }
    fakeLlm.enqueue(text('olá'))
    const before = fakeLlm.calls.length
    await runOnce()
    expect(fakeLlm.calls.length).toBe(before + 1)
    expect(fakeLlm.calls.at(-1)!.model.provider).toBe('anthropic')
    expect(llm.keyedCalls.at(-1)).toEqual({ companyId: s.companyId, keyId: key.id, provider: 'anthropic' })
    const usage = await db.select().from(aiUsage).where(eq(aiUsage.companyId, s.companyId))
    expect(usage.map((u) => u.feature)).toContain('flow_ai')

    await db.update(aiWallets).set({ balanceCredits: 0, maxOverrunCredits: 0, status: 'exhausted' }).where(eq(aiWallets.companyId, s.companyId))
    const calls = fakeLlm.calls.length
    const runId = await runOnce()
    expect(fakeLlm.calls.length).toBe(calls)
    const steps = await db.select().from(flowRunSteps).where(eq(flowRunSteps.runId, runId))
    expect(steps.find((st) => st.nodeKey === 'A')).toMatchObject({ status: 'failed', result: { handle: 'failure' } })
    expect(steps.map((st) => st.nodeKey)).toContain('F')
  }, 120_000)

  it('AC-T127-05: documento da base é processado pelo job ai-knowledge e o runtime do agente busca nele', async () => {
    const s = await signUp()
    const [agent] = await db.insert(aiAgents).values({ companyId: s.companyId, name: 'Leo' }).returning({ id: aiAgents.id })
    const created = await call(s, 'POST', `/api/ai-agents/${agent!.id}/knowledge-sources`, { kind: 'text', title: 'Frete', body: 'O frete para Manaus custa 42 reais e chega em 5 dias.' })
    expect(created.status).toBeLessThan(300)
    await until('fonte pronta', async () => (await db.select().from(aiKnowledgeSources).where(eq(aiKnowledgeSources.agentId, agent!.id)))[0]?.status === 'ready')
    const knowledge = (aiAgentRuntime() as any).opts.knowledge
    expect(await knowledge.search({ companyId: s.companyId, agentId: agent!.id, query: 'quanto custa o frete para Manaus?' })).toEqual([expect.stringContaining('Manaus')])
  }, 120_000)

  it('AC-T127-06: o job ai-agent-lab usa o LLM e o UsageGuard do processo', () => {
    const svc = aiAgentLabService() as any
    expect(svc.opts.llm).toBe(crmWorker.production.llm)
    expect(svc.opts.guard).toBe(crmWorker.production.guard)
    expect(svc.opts.knowledge).toBeDefined()
  })

  it('AC-T127-07: export de kind sem processor termina failed com a mensagem', async () => {
    const s = await signUp()
    const kind = `t127_nao_existe_${rnd()}`
    const [job] = await db.insert(backgroundJobs).values({ companyId: s.companyId, type: 'export', kind, status: 'queued' }).returning({ id: backgroundJobs.id })
    const queue = defineQueue(EXPORTS_QUEUE)
    await queue.add(EXPORTS_QUEUE, { jobId: job!.id }, { jobId: `t127-${job!.id}` })
    await queue.close()
    const done = await until('job failed', async () => {
      const [r] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, job!.id))
      return r?.status === 'failed' ? r : null
    })
    expect(done.error).toContain(kind)
  }, 60_000)
})
