// Funil por bloco (`GET /api/flows/:id/funnel`) por HTTP, Postgres real: entradas por nó, paradas por status,
// período, filtro por conexão, nós removidos do rascunho e isolamento por empresa.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chats, connections, contacts, createDb, flowRunSteps, flowRuns, type Database, type FlowRunStatus } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
interface Who {
  cookie: string
  companyId: string
}

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { ...H, cookie: who.cookie, 'x-company-id': who.companyId }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: (await res.json()) as Json }
}

async function owner(): Promise<Who> {
  const email = `f${rnd()}@x.com`
  await app.request('/api/auth/register', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Ana', email, password: 's3nha-forte', password_confirmation: 's3nha-forte' }) })
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, 'x-forwarded-for': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email, password: 's3nha-forte' }),
  })
  const body = (await res.json()) as Json
  return { cookie: `crm_session=${/crm_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`, companyId: body.companies[0].id }
}

/** start → m1 → m2 (rascunho). */
async function flowWithTwoMessages(a: Who) {
  const flow = (await call(a, 'POST', '/api/flows', { name: `F${rnd()}` })).body.flow
  for (const id of ['m1', 'm2'])
    await call(a, 'POST', `/api/flows/${flow.id}/nodes`, { id, type: 'message', name: id.toUpperCase(), position: { x: 0, y: 0 }, actions: [{ type: 'send_message', config: { message_text: 'oi' } }] })
  await call(a, 'POST', `/api/flows/${flow.id}/connections`, { from: 'start', handle: 'source', to: 'm1' })
  await call(a, 'POST', `/api/flows/${flow.id}/connections`, { from: 'm1', handle: 'source', to: 'm2' })
  return flow as Json
}

async function connection(a: Who) {
  const [c] = await db.insert(connections).values({ companyId: a.companyId, sessionId: `s-${rnd()}`, name: 'Conexão' }).returning()
  return c!.id
}

/** Run com passos nos nós `path`; o nó atual é o último. */
async function run(a: Who, flowId: string, connectionId: string, status: FlowRunStatus, path: string[], startedAt = new Date()) {
  const [ct] = await db.insert(contacts).values({ companyId: a.companyId, name: 'Lead', phoneE164: `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}` }).returning()
  const [ch] = await db.insert(chats).values({ companyId: a.companyId, connectionId, contactId: ct!.id }).returning()
  const [r] = await db
    .insert(flowRuns)
    .values({ companyId: a.companyId, flowId, contactId: ct!.id, chatId: ch!.id, status, currentNodeKey: path.at(-1) ?? null, startedAt })
    .returning()
  // Dois passos no mesmo nó contam uma entrada só.
  const steps = path.flatMap((node, i) => [
    { companyId: a.companyId, runId: r!.id, seq: i, nodeKey: node, status: 'ok', idempotencyKey: `${r!.id}:${i}` },
    { companyId: a.companyId, runId: r!.id, seq: i, nodeKey: node, actionKey: 'a', status: 'ok', idempotencyKey: `${r!.id}:${i}:a` },
  ])
  if (steps.length) await db.insert(flowRunSteps).values(steps)
  return r!.id
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer({ from: 'no-reply@example.com' }), trustProxy: true, logger: createLogger({ level: 'silent' }) })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('GET /api/flows/:id/funnel', () => {
  it('conta entradas por nó, paradas por status, totais e conversão; filtra período e conexão', async () => {
    const a = await owner()
    const flow = await flowWithTwoMessages(a)
    const conn = await connection(a)
    const other = await connection(a)
    await run(a, flow.id, conn, 'completed', ['start', 'm1', 'm2'])
    await run(a, flow.id, conn, 'waiting', ['start', 'm1'])
    await run(a, flow.id, conn, 'failed', ['start', 'm1'])
    await run(a, flow.id, other, 'cancelled', ['start'])
    await run(a, flow.id, conn, 'waiting', ['start', 'old'])
    await run(a, flow.id, conn, 'completed', ['start', 'm1', 'm2'], new Date(Date.now() - 90 * 86_400_000))

    const res = await call(a, 'GET', `/api/flows/${flow.id}/funnel`)
    expect(res.status).toBe(200)
    const f = res.body.funnel
    expect(f.totals).toMatchObject({ started: 5, completed: 1, failed: 1, cancelled: 1, active: 2 })
    expect(f.conversion_rate).toBe(0.2)
    const node = (k: string) => f.nodes.find((n: Json) => n.node_key === k)
    expect(node('start')).toMatchObject({ is_entry: true, entered: 5, stopped_here: 1, stopped_by_status: { cancelled: 1 } })
    expect(node('m1')).toMatchObject({ name: 'M1', type: 'message', entered: 3, stopped_here: 2, stopped_by_status: { waiting: 1, failed: 1 }, drop_off_rate: 0.6667 })
    expect(node('m2')).toMatchObject({ entered: 1, stopped_here: 0, drop_off_rate: 0 })
    expect(f.removed_nodes).toEqual([expect.objectContaining({ node_key: 'old', entered: 1, stopped_here: 1 })])

    const byConn = (await call(a, 'GET', `/api/flows/${flow.id}/funnel?connection_id=${other}`)).body.funnel
    expect(byConn.totals).toMatchObject({ started: 1, cancelled: 1 })

    const from = new Date(Date.now() - 120 * 86_400_000).toISOString()
    const all = (await call(a, 'GET', `/api/flows/${flow.id}/funnel?from=${encodeURIComponent(from)}`)).body.funnel
    expect(all.totals).toMatchObject({ started: 6, completed: 2 })

    expect((await call(a, 'GET', `/api/flows/${flow.id}/funnel?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z`)).status).toBe(422)
  })

  it('fluxo de outra empresa → 404', async () => {
    const a = await owner()
    const b = await owner()
    const flow = await flowWithTwoMessages(a)
    expect((await call(b, 'GET', `/api/flows/${flow.id}/funnel`)).status).toBe(404)
  })
})
