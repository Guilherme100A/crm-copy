// Ambiente da suíte T64 (contrato combinado com o Torno):
//  - API: POST /api/chats/:id/schedules, GET /api/schedules?chat_id&status, GET /api/chats/:id/schedules, GET|DELETE /api/schedules/:id
//  - deps.scheduleJobs = { add(job, delayMs), remove(job) } espião (sem Redis): observa o job 'schedule-<id>-<runAtMs>'
//  - execução: runSchedule(deps, { scheduleId, runAt }) de '@crm/core' com o ChatSendService real (FakeWaGateway),
//    FlowEngine real (cria crm.flow_runs), enqueue espião e relógio injetado
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { ensureConnection } from '../helpers/connections'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  db: Any
  core: Any
  gateway: Any
  app: Any
  jobs: { added: Array<{ job: Any; delayMs: number }>; removed: Any[] }
  sessions: Map<string, string>
  connections: Map<string, { companyId: string; connectionId: string }>
  run: (scheduleId: string, runAt: string, now?: Date) => Promise<Any>
  enqueued: Array<{ job: Any; delayMs: number }>
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  for (const n of ['runSchedule', 'ChatSendService', 'FlowEngine', 'ChatIngest']) if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const storage = mkdtempSync(join(tmpdir(), 'crm-t64-'))
  const redis = redisConnection({})
  redis.on?.('error', () => {})
  const gateway = new FakeWaGateway()
  const sessions = new Map<string, string>()
  const connections = new Map<string, { companyId: string; connectionId: string }>()
  const resolveSession = async (companyId: string, connectionId: string) => sessions.get(`${companyId}:${connectionId}`) ?? null
  const blobStore = new FsBlobStore(storage)
  const jobs: Env['jobs'] = { added: [], removed: [] }
  const ptt = async (data: Uint8Array) => ({ audio: data, mime: 'audio/ogg; codecs=opus', seconds: 1 })
  const app = api.createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    blobStore,
    waGateway: gateway,
    resolveSession,
    pttConverter: ptt,
    chatPublisher: { publish: async () => {} },
    scheduleJobs: {
      add: async (job: Any, delayMs: number) => void jobs.added.push({ job, delayMs }),
      remove: async (job: Any) => void jobs.removed.push(job),
    },
    trustProxy: true,
  })
  const send = new core.ChatSendService({
    db,
    waGateway: gateway,
    resolveSession,
    media: new core.MediaService({ blobStore }),
    pttConverter: ptt,
    idempotency: new core.RedisIdempotencyStore(redis, `crm:t64:idem:${randomBytes(4).toString('hex')}:`),
    publisher: { publish: async () => {} },
  })
  const engine = new core.FlowEngine({ db, wa: gateway, enqueue: async () => {} })
  const enqueued: Env['enqueued'] = []
  const run = (scheduleId: string, runAt: string, now = new Date(runAt)) =>
    core.runSchedule(
      { db, send, flows: engine, enqueue: async (job: Any, delayMs: number) => void enqueued.push({ job, delayMs }), now: () => now },
      { scheduleId, runAt },
    )
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    core,
    gateway,
    app,
    jobs,
    sessions,
    connections,
    run,
    enqueued,
    q,
    close: async () => {
      await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
      await Promise.resolve(redis.quit()).catch(() => redis.disconnect())
      await db.$client.end().catch(() => {})
      await tmp.drop()
      rmSync(storage, { recursive: true, force: true })
    },
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

function clientOn(env: Env, cookie: string, companyId: string): ApiClient {
  const ip = randomIp()
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
    companyId,
  })
  const [k, v] = cookie.split('=')
  c.cookies.set(k!, v!)
  return c
}

async function register(env: Env) {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t64')
  const c = createClient({ fetcher: (p, init) => env.app.request(p, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-forwarded-for': randomIp() } }) })
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t64')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  return { userId: login.body.user.id as string, companyId: login.body.companies[0].id as string, cookie: `crm_session=${c.cookies.get('crm_session')}` }
}

export interface Owner {
  c: ApiClient
  userId: string
  companyId: string
  connectionId: string
  sessionId: string
}

export async function newOwner(env: Env): Promise<Owner> {
  const r = await register(env)
  const sessionId = env.gateway.addSession({ state: 'STABLE' }).id
  const connectionId = await ensureConnection(env.q, r.companyId, { id: randomUUID(), sessionId })
  env.sessions.set(`${r.companyId}:${connectionId}`, sessionId)
  env.connections.set(sessionId, { companyId: r.companyId, connectionId })
  return { c: clientOn(env, r.cookie, r.companyId), userId: r.userId, companyId: r.companyId, connectionId, sessionId }
}

export async function addMember(env: Env, o: Owner) {
  const r = await register(env)
  const [m] = await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3) RETURNING id`, [
    o.companyId,
    r.userId,
    ['chat.view'],
  ])
  return { c: clientOn(env, r.cookie, o.companyId), userId: r.userId, memberId: m.id as string }
}

/** Chat criado pela ingestão de uma mensagem recebida (T33). */
export async function newChat(env: Env, o: Owner) {
  const ingest = new env.core.ChatIngest({
    db: env.db,
    publisher: { publish: async () => {} },
    waGateway: env.gateway,
    resolveConnection: async (sid: string) => env.connections.get(sid) ?? null,
  })
  const e164 = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  await ingest.handle({
    v: 1,
    type: 'message.inbound',
    session_id: o.sessionId,
    at: new Date().toISOString(),
    message: { id: `WAIN-${randomBytes(5).toString('hex')}`, from: `${e164.slice(1)}@s.whatsapp.net`, from_me: false, timestamp: Date.now(), type: 'conversation', text: 'oi', push_name: 'Cliente' },
  })
  const [chat] = await env.q(`SELECT c.id, c.contact_id FROM crm.chats c JOIN crm.contacts k ON k.id = c.contact_id WHERE c.company_id = $1 AND k.phone_e164 = $2`, [o.companyId, e164])
  return { id: chat.id as string, contactId: chat.contact_id as string, phone: e164 }
}

const flowDef = () => ({
  schema: 'crm.flow/v1',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
    { id: 'm1', type: 'message', name: 'Oi', position: { x: 200, y: 0 }, actions: [{ id: 'm1-a1', type: 'send_message', order: 0, config: { message_text: 'Olá do fluxo agendado' } }] },
  ],
  edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'm1' }],
  variables: [],
  refs: {},
})

/** Fluxo pela API (T28): `active` publica e ativa; `draft` só cria. */
export async function newFlow(o: Owner, status: 'active' | 'draft' = 'active') {
  const res = await o.c.post('/api/flows', { name: uniqueId('Fluxo') })
  if (res.status !== 201) throw new Error(`POST /api/flows → ${res.status} ${res.text}`)
  const flow = res.body.flow
  const put = await o.c.put(`/api/flows/${flow.id}/definition`, flowDef())
  if (put.status !== 200) throw new Error(`PUT definition → ${put.status} ${put.text}`)
  if (status === 'active') {
    const act = await o.c.post(`/api/flows/${flow.id}/activate`)
    if (act.status !== 200) throw new Error(`activate → ${act.status} ${act.text}`)
  }
  return flow.id as string
}

export const MIN = 60_000
export const DAY = 24 * 60 * MIN
/** Instante futuro arredondado para o minuto (evita depender de milissegundos). */
export const inFuture = (ms: number) => new Date(Math.floor((Date.now() + ms) / MIN) * MIN).toISOString()

export async function schedule(o: Owner, chatId: string, body: Record<string, unknown>) {
  const res = await o.c.post(`/api/chats/${chatId}/schedules`, body)
  if (res.status !== 201) throw new Error(`agendar: ${res.status} ${res.text}`)
  return res.body.schedule
}

export const fieldPaths = (res: { body: Any }) =>
  (res.body?.error?.details?.fields ?? []).map((f: Any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))

/** Partes de data/hora no fuso (America/Sao_Paulo por padrão). */
export function localParts(iso: string, tz = 'America/Sao_Paulo') {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso))
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value)
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour'), min: g('minute') }
}
