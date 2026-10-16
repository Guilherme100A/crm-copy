// Ponta a ponta (T47): XADD no stream → StreamConsumer → projeção das conexões → Postgres (banco descartável, Redis db 1).
import { randomBytes } from 'node:crypto'
import { companies, companyMembers, connections, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../../boot/start'
import { createRegistry, registry as processRegistry } from '../../registry'
import { WA_EVENT_FIELD } from '../framework'
import { CONNECTION_EVENT_TYPES, registerConnectionsConsumer } from './index'

let temp: TempDatabase
let db: Database
const redis = redisConnection()

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis.disconnect()
  await temp?.drop()
})

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('consumidor de conexões', () => {
  it('o registry do processo (worker de produção) tem os handlers de session.*', () => {
    const ids = processRegistry.handlers.filter((h) => h.opts.id?.startsWith('connections:')).map((h) => `${h.type}:${h.opts.id}`)
    expect(ids).toEqual(CONNECTION_EVENT_TYPES.map((t) => `${t}:connections:${t}`))
  })

  it('open → close pelo stream: projeta crm.connections, publica a queda, alerta e e-mail; reentrega não duplica', async () => {
    const tag = randomBytes(4).toString('hex')
    const [co] = await db.insert(companies).values({ name: `C ${tag}`, slug: `c-${tag}` }).returning()
    const [u] = await db.insert(users).values({ email: `owner-${tag}@x.test`, passwordHash: 'x', name: 'Dona' }).returning()
    await db.insert(companyMembers).values({ companyId: co!.id, userId: u!.id, role: 'owner' })
    const sessionId = `s-${tag}`
    const [conn] = await db.insert(connections).values({ companyId: co!.id, sessionId, name: 'Conexão teste' }).returning()
    const stream = `test:wsm:events:${tag}`
    const published: Array<{ companyId: string; type: string }> = []
    const mailer = new MemoryMailer()
    const reg = registerConnectionsConsumer(createRegistry(), {
      db,
      publisher: { publish: async (companyId, type) => void published.push({ companyId, type }) },
      mailer,
      appName: 'MeuCRM',
    })
    const app = await startWorker({ registry: reg, db, redis, consumer: { stream, group: `g-${tag}`, blockMs: 50 }, handleSignals: false, exitProcess: false })
    try {
      const at = (s: number) => new Date(Date.parse('2026-10-16T12:00:00.000Z') + s * 1000).toISOString()
      await redis.xadd(stream, '*', WA_EVENT_FIELD, JSON.stringify({ v: 1, type: 'session.connection', session_id: sessionId, at: at(0), state: 'open' }))
      const close = JSON.stringify({ v: 1, type: 'session.connection', session_id: sessionId, at: at(30), state: 'close', reason: 'transient' })
      await redis.xadd(stream, '*', WA_EVENT_FIELD, close)
      await redis.xadd(stream, '*', WA_EVENT_FIELD, close)
      // evento de uma sessão que não é do CRM (AC-T47-05)
      await redis.xadd(stream, '*', WA_EVENT_FIELD, JSON.stringify({ v: 1, type: 'session.connection', session_id: 'fora-do-crm', at: at(31), state: 'close' }))
      await until(async () => published.some((p) => p.type === 'connection.disconnected_alert') && mailer.sent.length > 0)
      await new Promise((r) => setTimeout(r, 400))
      const [row] = await db.select().from(connections).where(eq(connections.id, conn!.id))
      expect(row).toMatchObject({ connectionState: 'close', lastDisconnectReason: 'transient' })
      expect(row!.disconnectedAt?.toISOString()).toBe(at(30))
      expect(published.every((p) => p.companyId === co!.id)).toBe(true)
      expect(published.filter((p) => p.type === 'connection.connected')).toHaveLength(1)
      expect(published.filter((p) => p.type === 'connection.disconnected')).toHaveLength(1)
      expect(published.filter((p) => p.type === 'connection.disconnected_alert')).toHaveLength(1)
      expect(mailer.sent).toHaveLength(1)
      expect(mailer.sent[0]!.to).toEqual([`owner-${tag}@x.test`])
      expect(mailer.sent[0]!.subject).toContain('MeuCRM')
    } finally {
      await app.stop()
      await redis.del(stream)
    }
  })
})
