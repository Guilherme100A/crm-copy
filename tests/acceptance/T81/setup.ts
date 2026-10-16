// Ambiente da suíte T81 (processador de webhooks de entrada). Contrato combinado com o Operário (Cinzel):
// - Recepção (T72): POST /api/hooks/in/:token → 202; createApp({ inboundWebhooksEnqueue(data) }) captura o job
//   { requestId, webhookId, companyId } sem BullMQ.
// - @crm/core: new InboundWebhookProcessor({ db, engine, control, publisher, redis, now }).process(data) → { status, steps, error, reason };
//   processor.sweepPending({ olderThanMs, limit }, enqueue) reenfileira os pending antigos.
// - engine = FlowEngine({ db, wa: FakeWaGateway, enqueue: captura }) (o run nasce, os passos não rodam); control = FlowControl({ db }).
// - Escuta de amostra: POST/DELETE /api/inbound-webhooks/:id/sample-listen; o processador publica
//   `webhook.sample_received` só para o usuário ouvinte (RealtimePublisher real → SSE /api/events).
// - Log de acesso: chave `path` com /api/hooks/in/*** (createApp({ logger }) com destino capturado).
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { ensureConnection } from '../helpers/connections'
import { connectSse, type SseConnection } from '../helpers/sse'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const MIN = 60_000

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  core: Any
  processor: Any
  /** jobs capturados da recepção pública */
  enqueued: Any[]
  /** passos de fluxo enfileirados pelo motor (o run nasce mas não executa) */
  steps: Any[]
  logs: string[]
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  for (const n of ['InboundWebhookProcessor', 'FlowEngine', 'FlowControl', 'FlowStore', 'RealtimePublisher'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const logs: string[] = []
  const logger = createLogger({ level: 'debug', destination: { write: (s: string) => void logs.push(s) } as Any })
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const enqueued: Any[] = []
    const steps: Any[] = []
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: new FakeWaGateway(),
      logger,
      trustProxy: true,
      inboundWebhooksEnqueue: async (data: Any) => void enqueued.push(data),
    })
    const engine = new core.FlowEngine({ db, wa: new FakeWaGateway(), enqueue: async (j: Any) => void steps.push(j) })
    const control = new core.FlowControl({ db })
    const publisher = new core.RealtimePublisher({ redis })
    const processor = new core.InboundWebhookProcessor({ db, engine, control, publisher, redis })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, core, processor, enqueued, steps, logs, q, close }
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

export interface User {
  c: ApiClient
  userId: string
  companyId: string
  cookie: () => string
}

export async function newOwner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t81')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t81')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id, cookie: () => `crm_session=${c.cookies.get('crm_session')}` }
}

export async function newMember(env: Env, companyId: string, keys: string[] | null): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

/** Conexão da empresa com número e estado (open = conectada). */
export async function newConnection(env: Env, companyId: string, phone: string | null, state: 'open' | 'close' = 'open'): Promise<string> {
  const id = await ensureConnection(env.q, companyId)
  await env.q(`UPDATE crm.connections SET phone_number = $2, connection_state = $3 WHERE id = $1`, [id, phone, state])
  return id
}

export async function newWebhook(u: User, body: Record<string, unknown> = {}): Promise<Any> {
  const res = await u.c.post('/api/inbound-webhooks', { name: `Webhook ${uniqueId('wh')}`, ...body })
  if (res.status !== 201) throw new Error(`POST /api/inbound-webhooks → ${res.status} ${res.text}`)
  return res.body.webhook
}

export async function newLabel(u: User, name: string): Promise<string> {
  const res = await u.c.post('/api/labels', { name, color: '#22AA55' })
  if (res.status !== 201) throw new Error(`POST /api/labels → ${res.status} ${res.text}`)
  return (res.body.label ?? res.body).id
}

/** Quadro kanban com as colunas padrão; devolve { crmId, columns: [ids em ordem] }. */
export async function newBoard(u: User): Promise<{ crmId: string; columns: string[] }> {
  const res = await u.c.post('/api/crms', { name: `Funil ${uniqueId('k')}` })
  if (res.status !== 201) throw new Error(`POST /api/crms → ${res.status} ${res.text}`)
  const crmId = (res.body.crm ?? res.body).id
  const cols = await u.c.get(`/api/crms/${crmId}/columns`)
  if (cols.status !== 200) throw new Error(`GET columns → ${cols.status} ${cols.text}`)
  const items: Any[] = cols.body.items ?? cols.body.columns ?? cols.body
  return { crmId, columns: [...items].sort((a, b) => a.position - b.position).map((c) => c.id) }
}

/** Fluxo publicado simples (início → mensagem). */
export async function newFlow(env: Env, companyId: string): Promise<string> {
  const store = new env.core.FlowStore(env.db)
  const ctx = { companyId }
  const flow = await store.createFlow(ctx, { name: uniqueId('Fluxo wh') })
  await store.fromDefinition(ctx, flow.id, {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
      { id: 'M', type: 'message', name: 'Oi', position: { x: 200, y: 0 }, actions: [{ id: 'M-a1', type: 'send_message', order: 0, config: { message_text: 'oi' } }] },
    ],
    edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'M' }],
    variables: [],
    refs: {},
  })
  await store.publish(ctx, flow.id)
  return flow.id
}

export const path = (value: string) => ({ kind: 'path', value })
export const lit = (value: string) => ({ kind: 'literal', value })

/** Config base: nome em cliente.nome, telefone "+55" + cliente.fone, e-mail em cliente.email. */
export const baseConfig = (extra: Record<string, unknown> = {}) => ({
  field_paths: { full_name: [path('cliente.nome')], phone: [lit('+55'), path('cliente.fone')], email: [path('cliente.email')] },
  ...extra,
})

export async function setConfig(u: User, webhookId: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const res = await u.c.patch(`/api/inbound-webhooks/${webhookId}`, { config, ...extra })
  if (res.status !== 200) throw new Error(`PATCH webhook → ${res.status} ${res.text}`)
  return res.body.webhook
}

let phoneSeq = 0
/** Celular BR (DDD 11) único por chamada, só dígitos locais: 9XXXXXXXX. */
export const localPhone = () => `119${String(Date.now() % 1e6).padStart(6, '0').slice(-6)}${String(++phoneSeq % 100).padStart(2, '0')}`

/** POST público; devolve { status, body }. */
export async function postHook(env: Env, token: string, payload: unknown) {
  const res: Response = await env.app.request(`/api/hooks/in/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
  const text = await res.text()
  let body: Any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* não-JSON */
  }
  return { status: res.status, body, text }
}

/** Recebe e processa (como o worker) o request; devolve o resultado do processador e a linha gravada. */
export async function deliver(env: Env, token: string, payload: unknown) {
  const res = await postHook(env, token, payload)
  if (res.status !== 202) throw new Error(`POST /api/hooks/in → ${res.status} ${res.text}`)
  const results = await processAll(env)
  const requestId = res.body.request_id
  return { requestId, result: results.find((r) => r.requestId === requestId)?.result, row: await requestRow(env, requestId) }
}

/** Processa todos os jobs capturados, em ordem. */
export async function processAll(env: Env) {
  const out: Array<{ requestId: string; result: Any }> = []
  while (env.enqueued.length) {
    const job = env.enqueued.shift()!
    out.push({ requestId: job.requestId, result: await env.processor.process(job) })
  }
  return out
}

export async function requestRow(env: Env, requestId: string) {
  const [r] = await env.q(`SELECT processing_status, steps, error, reason, processed_at, created_at FROM crm.inbound_webhook_requests WHERE id = $1`, [requestId])
  return r
}

/** Histórico pela API (contrato HTTP da T72), item do request. */
export async function requestDto(u: User, webhookId: string, requestId: string) {
  const res = await u.c.get(`/api/inbound-webhooks/${webhookId}/requests?page=1&limit=100`)
  if (res.status !== 200) throw new Error(`GET requests → ${res.status} ${res.text}`)
  return res.body.items.find((i: Any) => i.id === requestId)
}

export const stepOf = (steps: Any[], name: string) => steps.find((s) => s.step === name)

export async function contactByPhone(env: Env, companyId: string, local: string) {
  const [c] = await env.q(`SELECT * FROM crm.contacts WHERE company_id = $1 AND phone_e164 LIKE '%' || $2`, [companyId, local])
  return c
}

export async function runsOf(env: Env, contactId: string) {
  return env.q(`SELECT r.flow_id, r.contact_id, r.chat_id, r.trigger, ch.connection_id FROM crm.flow_runs r LEFT JOIN crm.chats ch ON ch.id = r.chat_id WHERE r.contact_id = $1`, [contactId])
}

export async function openSse(env: Env, u: User): Promise<SseConnection> {
  const s = await connectSse((p, init) => env.app.request(p, init), `/api/events?company_id=${u.companyId}`, { cookie: u.cookie() })
  if (s.status !== 200) throw new Error(`SSE ${s.status}: ${s.text}`)
  await s.waitFor((m) => m.event === 'ping', 10_000)
  return s
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
