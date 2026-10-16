// Postgres e Redis locais: concorrência global entre instâncias e receipts → antiban.onDelivered (SPEC T14).
import { randomBytes } from 'node:crypto'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb, sessions, type Database } from '../db'
import { FakeTransport } from '../transport'
import { MessageQueue, type DeliverFn } from './queue'

let tmp: TempDatabase
let db: Database
const queues: MessageQueue[] = []

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, set: 'wa' })
  db = createDb(tmp.url, { max: 8 })
}, 120_000)

afterEach(async () => {
  for (const q of queues.splice(0)) await q.close()
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

async function createSession(): Promise<string> {
  const [row] = await db.insert(sessions).values({ name: 's', status: 'STABLE' }).returning()
  return row!.id
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('MessageQueue entre instâncias', () => {
  it('duas instâncias (dois Workers) na mesma fila nunca processam duas mensagens da sessão ao mesmo tempo', async () => {
    const sessionId = await createSession()
    const prefix = `wsm_test_${randomBytes(4).toString('hex')}`
    const transport = new FakeTransport()
    transport.open()
    let active = 0
    let maxActive = 0
    const byInstance = { a: 0, b: 0 }
    const deliverAs =
      (who: 'a' | 'b'): DeliverFn =>
      async (t, to, c) => {
        active++
        maxActive = Math.max(maxActive, active)
        byInstance[who]++
        await new Promise((r) => setTimeout(r, 25))
        active--
        return t.sendMessage(to, c)
      }
    const a = new MessageQueue({ db, prefix, getTransport: () => transport, deliver: deliverAs('a'), holdDelayMs: 20 })
    const b = new MessageQueue({ db, prefix, getTransport: () => transport, deliver: deliverAs('b'), holdDelayMs: 20 })
    queues.push(a, b)
    await Promise.all([a.startSession(sessionId), b.startSession(sessionId)])
    const ids: string[] = []
    for (let i = 0; i < 12; i++) {
      const producer = i % 2 === 0 ? a : b
      ids.push((await producer.enqueue({ sessionId, phone: '+5511999990100', content: { text: `m${i}` } })).id)
    }
    await waitFor(async () => (await a.list({ sessionId, status: 'sent' })).length === ids.length)
    expect(maxActive).toBe(1)
    expect(transport.sent).toHaveLength(ids.length)
    expect(byInstance.a + byInstance.b).toBe(ids.length)
  })

  it('receipts chamam antiban.onDelivered com a sessão e o id do transporte', async () => {
    const sessionId = await createSession()
    const transport = new FakeTransport()
    transport.open()
    const onDelivered = vi.fn()
    const q = new MessageQueue({
      db,
      prefix: `wsm_test_${randomBytes(4).toString('hex')}`,
      getTransport: () => transport,
      deliver: (t, to, c) => t.sendMessage(to, c),
      antiban: { onDelivered },
      holdDelayMs: 20,
    })
    queues.push(q)
    const msg = await q.enqueue({ sessionId, phone: '+5511999990101', content: { text: 'oi' } })
    await waitFor(async () => (await q.get(msg.id)).status === 'sent')
    const wamid = (await q.get(msg.id)).transportMessageId!
    await q.handleReceipt(sessionId, { messageId: wamid, status: 'delivered' })
    await q.handleReceipt(sessionId, { messageId: wamid, status: 'read' })
    expect(onDelivered).toHaveBeenCalledTimes(2)
    expect(onDelivered).toHaveBeenCalledWith(sessionId, wamid)
    expect((await q.get(msg.id)).status).toBe('read')
    // Receipt que regrediria (delivered depois de read) não muda nada nem grava evento.
    const before = (await q.events(msg.id)).length
    await q.handleReceipt(sessionId, { messageId: wamid, status: 'delivered' })
    expect((await q.get(msg.id)).status).toBe('read')
    expect(await q.events(msg.id)).toHaveLength(before)
  })

  it('falha do antiban.onDelivered não impede o receipt', async () => {
    const sessionId = await createSession()
    const transport = new FakeTransport()
    transport.open()
    const q = new MessageQueue({
      db,
      prefix: `wsm_test_${randomBytes(4).toString('hex')}`,
      getTransport: () => transport,
      deliver: (t, to, c) => t.sendMessage(to, c),
      antiban: {
        onDelivered: () => {
          throw new Error('antiban fora')
        },
      },
      holdDelayMs: 20,
    })
    queues.push(q)
    const msg = await q.enqueue({ sessionId, phone: '+5511999990102', content: { text: 'oi' } })
    await waitFor(async () => (await q.get(msg.id)).status === 'sent')
    await q.handleReceipt(sessionId, { messageId: (await q.get(msg.id)).transportMessageId!, status: 'delivered' })
    expect((await q.get(msg.id)).status).toBe('delivered')
  })
})
