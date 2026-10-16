// Ambiente da suíte T111. Contrato combinado com o Operário (Cinzel):
// - Integração XPag pela API (T109): createApp({ paymentIntegrations }) com um PaymentIntegrationsService
//   ({ db, cipher, env: { XPAG_API_URL: fake.url, API_PUBLIC_URL } }) compartilhado com o nó.
// - Nó `payment` num fluxo REAL: FlowStore (publicar) + FlowEngine({ db, wa, registry, hooks: control.engineHooks(), now })
//   com createNodeRegistry() + registerPaymentNodes(registry, { paymentIntegrations }); o nó `message` é trocado por um
//   gravador que renderiza o texto (mostra o caminho seguido e as variáveis {gateway.*}).
// - Webhook: POST na URL que o FakeXPag recebeu no cashin (fake.webhookFor(tx).url → /api/hooks/payments/xpag/:id?token=…);
//   a API responde 202 e chama createApp({ paymentWebhookEnqueue(data, { jobId }) }), capturado aqui; o job é processado
//   por PaymentWebhookService({ db, control, now }).process(data) de @crm/core, e o passo enfileirado pelo controle roda
//   com engine.step. O mesmo relógio vai em registerPaymentNodes({ now }) (listener_until), FlowEngine, FlowControl e no serviço.
// Semântica (decisão do orquestrador): com aresta charge_created o ramo roda e o run fica onde o ramo terminar; o
// webhook aprovado dentro do TTL interrompe o run e o leva a payment_approved. Sem a aresta, o run espera
// (wait kind 'payment') no próprio nó até o TTL. Webhook repetido ou fora do TTL só atualiza payment_charges.
// Nunca a API real da XPag: só o FakeXPag local.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, fakePhone, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const CLIENT_ID = 'cli-t111'
export const CLIENT_SECRET = `sk_xpag_${randomBytes(12).toString('hex')}`
export const API_PUBLIC_URL = 'http://api.t111.test'
export const MIN = 60_000

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  core: Any
  fake: Any
  integrations: Any
  store: Any
  /** relógio controlado (motor, controle e processador de webhooks) */
  clock: { now: () => Date; advance: (ms: number) => void }
  /** jobs enfileirados pela rota pública de webhooks */
  jobs: Array<{ data: Any; opts: Any }>
  logs: string[]
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  for (const n of ['FakeXPag', 'PaymentIntegrationsService', 'PaymentWebhookService', 'registerPaymentNodes', 'FlowEngine', 'FlowControl', 'FlowStore', 'createNodeRegistry'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const fake = new core.FakeXPag({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  await fake.start()
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const logs: string[] = []
  const logger = createLogger({ level: 'debug', destination: { write: (s: string) => void logs.push(s) } as Any })
  let offset = 0
  const clock = { now: () => new Date(Date.now() + offset), advance: (ms: number) => void (offset += ms) }
  const jobs: Array<{ data: Any; opts: Any }> = []
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
    await fake.stop().catch(() => {})
  }
  try {
    const credentialsCipher = createCipher({ key: generateCredentialsKey() })
    const paymentsEnv = { XPAG_API_URL: fake.url, API_PUBLIC_URL }
    const integrations = new core.PaymentIntegrationsService({ db, cipher: credentialsCipher, env: paymentsEnv })
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: new FakeWaGateway(),
      logger,
      credentialsCipher,
      paymentsEnv,
      paymentIntegrations: integrations,
      paymentWebhookEnqueue: async (data: Any, opts: Any) => void jobs.push({ data, opts }),
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, core, fake, integrations, store: new core.FlowStore(db), clock, jobs, logs, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

function client(env: Env): ApiClient {
  const ip = randomIp()
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export interface Owner {
  c: ApiClient
  companyId: string
}

export async function newOwner(env: Env): Promise<Owner> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t111')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t111')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, companyId: m.company_id }
}

/** Integração XPag criada pela API (T109); devolve o DTO. */
export async function newIntegration(o: Owner) {
  const res = await o.c.post('/api/payment-integrations', { label: `XPag ${uniqueId('x')}`, gateway: 'xpag', client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
  if (res.status !== 201) throw new Error(`POST /api/payment-integrations → ${res.status} ${res.text}`)
  return res.body.integration
}

export async function newContact(env: Env, companyId: string): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, $2, $3) RETURNING id`, [companyId, `Contato ${uniqueId('ct')}`, fakePhone()])
  return r.id
}

const msg = (id: string, text: string) => ({
  id,
  type: 'message',
  name: `Msg ${id}`,
  position: { x: 0, y: 0 },
  actions: [{ id: `${id}-a1`, type: 'send_message', order: 0, config: { message_text: text } }],
})

/** Texto do ramo charge_created: mostra as variáveis expostas pelo nó. */
export const CREATED_TEXT = 'tx={gateway.transaction_id}|code={gateway.payment_code}|qr={gateway.qr_url}|checkout={gateway.checkout_url}'

/**
 * start → P (payment) ─output:charge_created→ C (instruções) → W (espera resposta, prazo 2 h: source→R, timeout→T)
 *                      ─output:payment_approved→ A ("pago {gateway.value}")
 *                      ─failure→ E ("erro {gateway.error}")
 * `branch: 'end'` = ramo só com C (o run termina completed); `branch: 'none'` tira a aresta charge_created
 * (o run espera o pagamento no próprio nó P, wait kind 'payment').
 */
export function paymentFlow(config: Record<string, unknown>, opts: { branch?: 'wait' | 'end' | 'none' } = {}) {
  const branch = opts.branch ?? 'wait'
  const withBranch = branch !== 'none'
  const withWait = branch === 'wait'
  const waitNode = {
    id: 'W',
    type: 'wait_response',
    name: 'Espera',
    position: { x: 0, y: 0 },
    actions: [{ id: 'W-a1', type: 'wait_for_response', order: 0, config: { wait_indefinitely: false, timeout_value: 2, timeout_unit: 'hours' } }],
  }
  return {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
      { id: 'P', type: 'payment', name: 'Cobrar', position: { x: 200, y: 0 }, actions: [{ id: 'P-a1', type: 'create_payment_charge', order: 0, config }] },
      ...(withBranch ? [msg('C', CREATED_TEXT)] : []),
      ...(withWait ? [waitNode, msg('R', 'respondeu'), msg('T', 'sem resposta')] : []),
      msg('A', 'pago {gateway.value}'),
      msg('E', 'erro {gateway.error}'),
    ],
    edges: [
      { id: 'e1', from: 'start', handle: 'source', to: 'P' },
      ...(withBranch ? [{ id: 'e2', from: 'P', handle: 'output:charge_created', to: 'C' }] : []),
      ...(withWait
        ? [
            { id: 'e5', from: 'C', handle: 'source', to: 'W' },
            { id: 'e6', from: 'W', handle: 'source', to: 'R' },
            { id: 'e7', from: 'W', handle: 'timeout', to: 'T' },
          ]
        : []),
      { id: 'e3', from: 'P', handle: 'output:payment_approved', to: 'A' },
      { id: 'e4', from: 'P', handle: 'failure', to: 'E' },
    ],
    variables: [],
    refs: {},
  }
}

export const pixConfig = (integrationId: string, extra: Record<string, unknown> = {}) => ({
  gateway: 'xpag',
  payment_integration_id: integrationId,
  currency: 'BRL',
  method: 'PIX',
  amount: 50,
  listener_ttl_value: 1,
  listener_ttl_unit: 'hours',
  ...extra,
})

export interface Run {
  runId: string
  contactId: string
  /** mensagens "enviadas" pelos nós de mensagem, em ordem: { node, text } */
  sent: Array<{ node: string; text: string }>
  /** executa os passos que o controle enfileirou */
  drain: () => Promise<void>
  /** timers agendados pelo controle (agendador falso) */
  timers: Array<{ data: Any; delayMs: number }>
  /** dispara os timers agendados até agora (como o worker flow-timer faria) e roda os passos */
  fireTimers: () => Promise<void>
  engine: Any
  control: Any
}

/** Publica o fluxo, inicia um run para um contato novo e executa até parar. */
export async function runFlow(env: Env, companyId: string, def: Any, vars: Record<string, unknown> = {}): Promise<Run> {
  const ctx = { companyId }
  const flow = await env.store.createFlow(ctx, { name: uniqueId('Cobrança') })
  await env.store.fromDefinition(ctx, flow.id, def)
  await env.store.publish(ctx, flow.id)
  const contactId = await newContact(env, companyId)
  const sent: Run['sent'] = []
  const enqueued: Array<{ runId: string; expectedSeq: number }> = []
  const timers: Run['timers'] = []
  const scheduler = { schedule: async (data: Any, delayMs: number) => void timers.push({ data, delayMs }), cancel: async () => {} }
  const control = new env.core.FlowControl({ db: env.db, timers: scheduler, now: env.clock.now, enqueueStep: async (j: Any) => void enqueued.push(j) })
  const registry = env.core.createNodeRegistry()
  env.core.registerPaymentNodes(registry, { paymentIntegrations: env.integrations, now: env.clock.now })
  registry.register('message', {
    async execute(c: Any) {
      sent.push({ node: c.node.id, text: c.render(String(c.node.actions[0].config.message_text)) })
      return { next: 'source' }
    },
  })
  const engine = new env.core.FlowEngine({ db: env.db, wa: {}, registry, hooks: control.engineHooks(), now: env.clock.now })
  const { runId } = await engine.startRun(ctx, { flowId: flow.id, contactId, vars })
  await engine.step(runId, 0)
  const drain = async () => {
    while (enqueued.length) {
      const j = enqueued.shift()!
      await engine.step(j.runId, j.expectedSeq)
    }
  }
  await drain()
  const fireTimers = async () => {
    for (const t of timers.splice(0)) await control.fireTimer(t.data)
    await drain()
  }
  return { runId, contactId, sent, drain, timers, fireTimers, engine, control }
}

export async function runRow(env: Env, runId: string) {
  const [r] = await env.q(`SELECT status, wait, vars, error, current_node_key FROM crm.flow_runs WHERE id = $1`, [runId])
  return r
}

export async function chargesOf(env: Env, runId: string) {
  return env.q(`SELECT * FROM crm.payment_charges WHERE flow_run_id = $1 ORDER BY created_at`, [runId])
}

/** Entrega um webhook na rota pública (path + query da URL do cashin). */
export async function deliver(env: Env, hook: { url: string; rawBody: string; headers: Record<string, string> }, urlOverride?: string) {
  const u = new URL(urlOverride ?? hook.url)
  const res: Response = await env.app.request(u.pathname + u.search, { method: 'POST', headers: hook.headers, body: hook.rawBody })
  const text = await res.text()
  return { status: res.status, text }
}

/** Processa (como o worker da fila payment-webhooks) os jobs capturados e roda os passos retomados. */
export async function processJobs(env: Env, run: Run) {
  const service = new env.core.PaymentWebhookService({ db: env.db, control: run.control, now: env.clock.now })
  while (env.jobs.length) {
    const j = env.jobs.shift()!
    await service.process(j.data)
  }
  await run.drain()
}
