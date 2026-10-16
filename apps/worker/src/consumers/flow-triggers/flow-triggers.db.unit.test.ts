// Ponta a ponta: XADD no stream → ingest de chats (T33) → crm.inbound → gatilhos (T61) → run do fluxo no Postgres.
import { randomBytes } from 'node:crypto'
import { FlowControl, FlowEngine, FlowStore, FlowTriggers, type FlowStepJobData } from '@crm/core'
import { companies, connectionFlowConfigs, connections, createDb, flowRuns, keywordTriggers, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startWorker } from '../../boot/start'
import { createRegistry } from '../../registry'
import { onCrmInbound, registerChatsConsumer } from '../chats'
import { WA_EVENT_FIELD } from '../framework'
import { configureFlowTriggers, flowTriggers, registerFlowTriggersConsumer } from './index'

let temp: TempDatabase
let db: Database
const redis = redisConnection()

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
  redis.disconnect()
})

async function until<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}

const node = (id: string, type: string) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions: [] })

async function publishedFlow(companyId: string, name: string): Promise<string> {
  const store = new FlowStore(db)
  const flow = await store.createFlow({ companyId }, { name })
  const def = { schema: 'crm.flow/v1' as const, entry: 'start', nodes: [node('start', 'start')], edges: [], variables: [], refs: {} }
  await store.fromDefinition({ companyId }, flow.id, def as Parameters<FlowStore['fromDefinition']>[2])
  await store.publish({ companyId }, flow.id)
  return flow.id
}

describe('consumidor de gatilhos de fluxo', () => {
  it('primeira mensagem dispara boas-vindas; palavra-chave tem prioridade e cancela o run; reentrega não duplica', async () => {
    const slug = `c-t61-${randomBytes(4).toString('hex')}`
    const [company] = await db.insert(companies).values({ name: slug, slug }).returning({ id: companies.id })
    const companyId = company!.id
    const sessionId = `s-${randomBytes(4).toString('hex')}`
    const stream = `test:wsm:events:${randomBytes(4).toString('hex')}`
    const [connection] = await db.insert(connections).values({ companyId, sessionId, name: 'Conexão gatilhos' }).returning({ id: connections.id })
    const welcome = await publishedFlow(companyId, 'Boas-vindas')
    const menu = await publishedFlow(companyId, 'Menu')
    const [cfg] = await db.insert(connectionFlowConfigs).values({ companyId, connectionId: connection!.id, welcomeFlowId: welcome }).returning()
    await db.insert(keywordTriggers).values({ companyId, configId: cfg!.id, flowId: menu, conditions: [{ keyword: 'menu', match_type: 'equals' }] })

    const steps: FlowStepJobData[] = []
    const engine = new FlowEngine({ db, wa: {} as never, enqueue: async (j) => void steps.push(j) })
    const control = new FlowControl({ db, timers: { schedule: async () => undefined, cancel: async () => undefined } })
    const off = registerFlowTriggersConsumer(new FlowTriggers({ db, engine, control }))
    const registry = registerChatsConsumer(createRegistry(), {
      db,
      publisher: { publish: async () => undefined },
      resolveConnection: async (sid) => (sid === sessionId ? { companyId, connectionId: connection!.id } : null),
    })
    const app = await startWorker({ registry, db, redis, consumer: { stream, group: `g-${slug}`, blockMs: 50 }, handleSignals: false, exitProcess: false })
    const event = (id: string, text: string) => ({
      v: 1,
      type: 'message.inbound',
      session_id: sessionId,
      at: new Date().toISOString(),
      message: { id, from: '5511977775555@s.whatsapp.net', from_me: false, timestamp: Date.now(), type: 'conversation', text },
    })
    try {
      await redis.xadd(stream, '*', WA_EVENT_FIELD, JSON.stringify(event('WA-T61-1', 'olá')))
      await redis.xadd(stream, '*', WA_EVENT_FIELD, JSON.stringify(event('WA-T61-1', 'olá')))
      const first = await until(async () => (await db.select().from(flowRuns).where(eq(flowRuns.companyId, companyId)))[0])
      expect(first).toMatchObject({ flowId: welcome, status: 'running', trigger: { type: 'welcome' } })
      expect(steps).toEqual([{ runId: first.id, expectedSeq: 0 }])

      await redis.xadd(stream, '*', WA_EVENT_FIELD, JSON.stringify(event('WA-T61-2', 'Menu')))
      const second = await until(async () => (await db.select().from(flowRuns).where(eq(flowRuns.flowId, menu)))[0])
      expect(second.trigger).toMatchObject({ type: 'keyword' })
      await new Promise((r) => setTimeout(r, 200))
      const all = await db.select().from(flowRuns).where(eq(flowRuns.companyId, companyId))
      expect(all.map((r) => [r.flowId, r.status]).sort()).toEqual(
        [
          [welcome, 'cancelled'],
          [menu, 'running'],
        ].sort(),
      )
    } finally {
      off()
      await app.stop()
      await redis.del(stream)
    }
  })

  it('falha nos gatilhos é registrada e não derruba o ingest nem os outros ouvintes', async () => {
    const slug = `c-t61-${randomBytes(4).toString('hex')}`
    const [company] = await db.insert(companies).values({ name: slug, slug }).returning({ id: companies.id })
    const companyId = company!.id
    const sessionId = `s-${randomBytes(4).toString('hex')}`
    const stream = `test:wsm:events:${randomBytes(4).toString('hex')}`
    const [connection] = await db.insert(connections).values({ companyId, sessionId, name: 'Conexão falha' }).returning({ id: connections.id })
    const error = vi.fn()
    const after: string[] = []
    const off = registerFlowTriggersConsumer({ handleInbound: async () => Promise.reject(new Error('boom')) } as unknown as FlowTriggers, { error })
    const offAfter = onCrmInbound((e) => void after.push(e.message_id))
    const registry = registerChatsConsumer(createRegistry(), {
      db,
      publisher: { publish: async () => undefined },
      resolveConnection: async (sid) => (sid === sessionId ? { companyId, connectionId: connection!.id } : null),
    })
    const app = await startWorker({ registry, db, redis, consumer: { stream, group: `g-${slug}`, blockMs: 50 }, handleSignals: false, exitProcess: false })
    try {
      const msg = { id: 'WA-T61-ERR', from: '5511977774444@s.whatsapp.net', from_me: false, timestamp: Date.now(), type: 'conversation', text: 'oi' }
      await redis.xadd(stream, '*', WA_EVENT_FIELD, JSON.stringify({ v: 1, type: 'message.inbound', session_id: sessionId, at: new Date().toISOString(), message: msg }))
      await until(async () => (after.length ? true : undefined))
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: 'boom' }), expect.any(String))
    } finally {
      off()
      offAfter()
      await app.stop()
      await redis.del(stream)
    }
  })

  it('o consumidor do processo ignora o crm.inbound até configureFlowTriggers({ db })', () => {
    configureFlowTriggers({ db: undefined as never })
    expect(flowTriggers()).toBeUndefined()
    configureFlowTriggers({ db })
    expect(flowTriggers()).toBeInstanceOf(FlowTriggers)
    configureFlowTriggers({ db: undefined as never })
  })
})
