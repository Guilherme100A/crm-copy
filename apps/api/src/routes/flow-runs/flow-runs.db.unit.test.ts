// Execuções por HTTP (app.request), Postgres real; flow-step capturado em memória, timers falsos.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FlowControl, FlowEngine, type FlowStepJobData, type FlowTimerJobData } from '@crm/core'
import { chats, companyMembers, contacts, createDb, flowRuns, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq } from 'drizzle-orm'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const jobs: FlowStepJobData[] = []
const cancelledTimers: FlowTimerJobData[] = []
const names = new Map<string, string>()

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
interface Who {
  cookie: string
  companyId: string
  userId: string
}

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { ...H, cookie: who.cookie, 'x-company-id': who.companyId }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: (await res.json()) as Json }
}

async function owner(): Promise<Who> {
  const email = `r${rnd()}@x.com`
  await app.request('/api/auth/register', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Ana', email, password: 's3nha-forte', password_confirmation: 's3nha-forte' }) })
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, 'x-forwarded-for': `10.4.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email, password: 's3nha-forte' }),
  })
  const body = (await res.json()) as Json
  return { cookie: `crm_session=${/crm_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`, companyId: body.companies[0].id, userId: body.user.id }
}

/** Fluxo ativo start → espera (stub aceito pelo validate: mensagem simples). */
async function activeFlow(a: Who) {
  const flow = (await call(a, 'POST', '/api/flows', { name: `F${rnd()}` })).body.flow
  await call(a, 'POST', `/api/flows/${flow.id}/nodes`, { id: 'm', type: 'message', position: { x: 0, y: 0 }, actions: [{ type: 'send_message', config: { message_text: 'oi' } }] })
  await call(a, 'POST', `/api/flows/${flow.id}/connections`, { from: 'start', handle: 'source', to: 'm' })
  expect((await call(a, 'POST', `/api/flows/${flow.id}/activate`)).status).toBe(200)
  return flow
}

async function chat(a: Who, connectionId = crypto.randomUUID()) {
  const [c] = await db.insert(contacts).values({ companyId: a.companyId, name: 'Lead', phoneE164: `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}` }).returning()
  const [ch] = await db.insert(chats).values({ companyId: a.companyId, connectionId, contactId: c!.id }).returning()
  return { chatId: ch!.id, contactId: c!.id, connectionId }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  const control = new FlowControl({
    db,
    timers: { schedule: async () => undefined, cancel: async (d) => void cancelledTimers.push(d) },
    enqueueStep: async (j) => void jobs.push(j),
  })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer({ from: 'no-reply@example.com' }),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    flowControl: control,
    flowEngine: new FlowEngine({ db, wa: new FakeWaGateway(), hooks: control.engineHooks() }),
    flowStepEnqueue: async (j) => void jobs.push(j),
    connectionName: (_ctx, id) => names.get(id) ?? null,
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('execuções', () => {
  it('trigger cria o run, enfileira o 1º passo e cancela o run ativo anterior do contato', async () => {
    const a = await owner()
    const flow = await activeFlow(a)
    const ch = await chat(a)
    const first = await call(a, 'POST', `/api/flows/${flow.id}/trigger`, { chat_id: ch.chatId })
    expect(first.status).toBe(201)
    expect(first.body.run).toMatchObject({ flow_id: flow.id, chat_id: ch.chatId, status: 'running', trigger: { kind: 'manual' } })
    expect(jobs).toContainEqual({ runId: first.body.run.id, expectedSeq: 0 })
    const second = await call(a, 'POST', `/api/flows/${flow.id}/trigger`, { chat_id: ch.chatId })
    expect(second.body.cancelled_run_ids).toEqual([first.body.run.id])
    expect((await db.select().from(flowRuns).where(eq(flowRuns.id, first.body.run.id)))[0]!.status).toBe('cancelled')

    const detail = await call(a, 'GET', `/api/flow-runs/${second.body.run.id}`)
    expect(detail.body).toMatchObject({ run: { id: second.body.run.id, flow_name: flow.name }, steps: [] })
    expect((await call(a, 'GET', `/api/chats/${ch.chatId}/flow-runs?active=1`)).body.items.map((r: Json) => r.id)).toEqual([second.body.run.id])
    expect((await call(a, 'GET', `/api/flows/${flow.id}/runs`)).body.page.total_count).toBe(2)
    expect((await call(a, 'POST', `/api/flow-runs/${second.body.run.id}/cancel`)).body.run.status).toBe('cancelled')
    expect((await call(a, 'POST', `/api/flow-runs/${second.body.run.id}/cancel`)).status).toBe(409)
  })

  it('fluxo não ativo → 409; chat de outra empresa → 404; sem flows.run → 403', async () => {
    const a = await owner()
    const draft = (await call(a, 'POST', '/api/flows', { name: 'rascunho' })).body.flow
    const ch = await chat(a)
    const r = await call(a, 'POST', `/api/flows/${draft.id}/trigger`, { chat_id: ch.chatId })
    expect([r.status, r.body.error.details.error_code]).toEqual([409, 'flow_not_active'])
    const flow = await activeFlow(a)
    const b = await owner()
    const other = await chat(b)
    expect((await call(a, 'POST', `/api/flows/${flow.id}/trigger`, { chat_id: other.chatId })).status).toBe(404)
    const viewer = await owner()
    await db.insert(companyMembers).values({ companyId: a.companyId, userId: viewer.userId, role: 'member', permissionKeys: ['flows.view'] })
    expect((await call({ ...viewer, companyId: a.companyId }, 'POST', `/api/flows/${flow.id}/trigger`, { chat_id: ch.chatId })).status).toBe(403)
  })

  it('cancelar todos da conexão exige o nome exato e cancela só os runs dela', async () => {
    const a = await owner()
    const flow = await activeFlow(a)
    const conn = crypto.randomUUID()
    names.set(conn, 'Loja Centro')
    const mine = await chat(a, conn)
    const other = await chat(a)
    const r1 = (await call(a, 'POST', `/api/flows/${flow.id}/trigger`, { chat_id: mine.chatId })).body.run
    const r2 = (await call(a, 'POST', `/api/flows/${flow.id}/trigger`, { chat_id: other.chatId })).body.run
    const bad = await call(a, 'POST', `/api/connections/${conn}/cancel-all-flow-runs`, { confirmation_name: 'loja centro' })
    expect([bad.status, bad.body.error.details.error_code]).toEqual([422, 'confirmation_mismatch'])
    expect((await call(a, 'POST', `/api/connections/${crypto.randomUUID()}/cancel-all-flow-runs`, { confirmation_name: 'x' })).status).toBe(404)
    expect((await call(a, 'POST', `/api/connections/${conn}/cancel-all-flow-runs`, { confirmation_name: 'Loja Centro' })).body).toEqual({ cancelled: 1 })
    const status = async (id: string) => (await db.select().from(flowRuns).where(eq(flowRuns.id, id)))[0]!.status
    expect([await status(r1.id), await status(r2.id)]).toEqual(['cancelled', 'running'])
  })

  it('pause da rota de fluxos congela runs em espera (FlowControl) e activate retoma', async () => {
    const a = await owner()
    const flow = await activeFlow(a)
    const ch = await chat(a)
    const run = (await call(a, 'POST', `/api/flows/${flow.id}/trigger`, { chat_id: ch.chatId })).body.run
    const deadline = new Date(Date.now() + 3_600_000).toISOString()
    await db.update(flowRuns).set({ status: 'waiting', wait: { kind: 'reply', handles: { reply: 'source', timeout: 'timeout' }, deadline_at: deadline } }).where(eq(flowRuns.id, run.id))
    const paused = await call(a, 'POST', `/api/flows/${flow.id}/pause`)
    expect(paused.body).toMatchObject({ flow: { status: 'paused' }, paused_runs: 1 })
    expect((await db.select().from(flowRuns).where(eq(flowRuns.id, run.id)))[0]!.status).toBe('paused')
    expect(cancelledTimers.some((t) => t.runId === run.id)).toBe(true)
    expect((await call(a, 'POST', `/api/flows/${flow.id}/activate`)).body.flow.status).toBe('active')
    expect((await db.select().from(flowRuns).where(eq(flowRuns.id, run.id)))[0]!.status).toBe('waiting')
  })
})
