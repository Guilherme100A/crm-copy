// Ponta a ponta: XADD no stream → StreamConsumer → ingest de chats → Postgres (banco descartável, Redis db 1).
import { randomBytes, randomUUID } from 'node:crypto'
import { chats, companies, createDb, messages, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWorker } from '../../boot/start'
import { createRegistry } from '../../registry'
import { WA_EVENT_FIELD } from '../framework'
import { onCrmInbound, registerChatsConsumer } from './index'

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

describe('consumidor de chats', () => {
  it('evento no stream vira contato, chat e mensagem; reentrega não duplica; crm.inbound sai uma vez', async () => {
    const slug = `c-${randomBytes(4).toString('hex')}`
    const [company] = await db.insert(companies).values({ name: slug, slug }).returning({ id: companies.id })
    const companyId = company!.id
    const sessionId = `s-${randomBytes(4).toString('hex')}`
    const stream = `test:wsm:events:${randomBytes(4).toString('hex')}`
    const published: string[] = []
    const inbound: string[] = []
    const off = onCrmInbound((e) => void inbound.push(e.message_id))

    const registry = registerChatsConsumer(createRegistry(), {
      db,
      publisher: { publish: async (_c, type) => void published.push(type) },
      resolveConnection: async (sid) => (sid === sessionId ? { companyId, connectionId: randomUUID() } : null),
    })
    const app = await startWorker({ registry, db, redis, consumer: { stream, group: `g-${slug}`, blockMs: 50 }, handleSignals: false, exitProcess: false })
    try {
      const event = {
        v: 1,
        type: 'message.inbound',
        session_id: sessionId,
        at: '2026-10-16T12:00:00.000Z',
        message: { id: 'WA-E2E-1', from: '5511977776666@s.whatsapp.net', from_me: false, timestamp: 1_760_616_000_000, type: 'conversation', text: 'olá' },
      }
      await redis.xadd(stream, '*', WA_EVENT_FIELD, JSON.stringify(event))
      await redis.xadd(stream, '*', WA_EVENT_FIELD, JSON.stringify(event))
      const row = await until(async () => (await db.select().from(messages).where(eq(messages.waMessageId, 'WA-E2E-1')))[0])
      await new Promise((r) => setTimeout(r, 300))
      expect(await db.select().from(messages).where(eq(messages.companyId, companyId))).toHaveLength(1)
      const [chat] = await db.select().from(chats).where(eq(chats.id, row.chatId))
      expect(chat).toMatchObject({ status: 'waiting', unreadCount: 1 })
      expect(published).toEqual(['chat.created', 'message.created', 'contact.updated'])
      expect(inbound).toEqual([row.id])
    } finally {
      off()
      await app.stop()
      await redis.del(stream)
    }
  })
})
