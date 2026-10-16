// Integração com Postgres e Redis locais (banco descartável, prefixo Redis aleatório). Fork dos testes do ai-manager.
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createDb, sessions, type Database, type SessionStatus } from '../db'
import { eq } from 'drizzle-orm'
import { FakeTransport, type OutgoingContent, type WaTransport } from '../transport'
import { MessageQueue, type DeliverFn, type MessageQueueOptions } from './queue'
import { MessageTransitionError, MessageNotFoundError } from './states'

// O deliver real (antiban → transporte) é da T20; aqui a entrega vai direto ao FakeTransport.
const realDeliver: DeliverFn = (t, to, c) => t.sendMessage(to, c)

let tmp: TempDatabase
let db: Database
let queue: MessageQueue | undefined

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_queue' })
  db = createDb(tmp.url, { max: 6 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

afterEach(async () => {
  await queue?.close()
  queue = undefined
})

let transport: FakeTransport

beforeEach(() => {
  transport = new FakeTransport()
  transport.open()
})

async function createSession(status: SessionStatus = 'WARMING'): Promise<string> {
  const phone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const [row] = await db.insert(sessions).values({ name: 's', phone, status }).returning()
  return row!.id
}

function makeQueue(opts: Partial<MessageQueueOptions> = {}): MessageQueue {
  queue = new MessageQueue({
    db,
    prefix: `wsm_test_${randomBytes(4).toString('hex')}`,
    getTransport: () => transport,
    deliver: realDeliver,
    backoffDelayMs: 50,
    holdDelayMs: 50,
    ...opts,
  })
  return queue
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (pred(v)) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting; last=${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const text = (t: string): OutgoingContent => ({ text: t })

describe('MessageQueue', () => {
  it('queued → processing → sent com eventos; receipts → delivered → read', async () => {
    const sessionId = await createSession()
    const q = makeQueue()
    const msg = await q.enqueue({ sessionId, phone: '+5511999990001', content: text('oi') })
    expect(msg.status).toBe('queued')
    const sent = await waitFor(() => q.get(msg.id), (m) => m.status === 'sent')
    expect(sent.transportMessageId).toBe(transport.sent[0]!.messageId)
    expect(sent.attempts).toBe(1)
    expect(sent.sentAt).not.toBeNull()
    expect(transport.sent[0]!.to).toBe('5511999990001@s.whatsapp.net')

    await q.handleReceipt(sessionId, { messageId: sent.transportMessageId!, status: 'delivered' })
    await q.handleReceipt(sessionId, { messageId: sent.transportMessageId!, status: 'read' })
    const read = await q.get(msg.id)
    expect(read.status).toBe('read')
    expect(read.deliveredAt).not.toBeNull()
    expect(read.readAt).not.toBeNull()
    const events = await q.events(msg.id)
    expect(events.map((e) => [e.from, e.to])).toEqual([
      [null, 'queued'],
      ['queued', 'processing'],
      ['processing', 'sent'],
      ['sent', 'delivered'],
      ['delivered', 'read'],
    ])
  })

  it('receipt read direto de sent grava delivered implícito; receipt antes do sent é aplicado depois', async () => {
    const sessionId = await createSession()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const deliver: DeliverFn = async (t, to, c) => {
      const res = await realDeliver(t, to, c)
      // receipt chega antes de a fila gravar `sent`
      await queue!.handleReceipt(sessionId, { messageId: res.messageId, status: 'read' })
      release()
      return res
    }
    const q = makeQueue({ deliver })
    const msg = await q.enqueue({ sessionId, phone: '+5511999990002', content: text('a') })
    await gate
    const m = await waitFor(() => q.get(msg.id), (v) => v.status === 'read')
    expect(m.deliveredAt).not.toBeNull()
  })

  it('concorrência 1 por sessão e ordem FIFO', async () => {
    const sessionId = await createSession()
    let active = 0
    let maxActive = 0
    const deliver: DeliverFn = async (t, to, c) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 30))
      active--
      return realDeliver(t, to, c)
    }
    const q = makeQueue({ deliver })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await q.enqueue({ sessionId, phone: '+5511999990003', content: text(`m${i}`) })).id)
    await waitFor(() => q.list({ sessionId, status: 'sent' }), (l) => l.length === 5)
    expect(maxActive).toBe(1)
    expect(transport.sent.map((s) => (s.content as { text: string }).text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })

  it('falha → retrying com backoff exponencial; 3 tentativas → failed com erro', async () => {
    const sessionId = await createSession()
    const calls: number[] = []
    const deliver: DeliverFn = async () => {
      calls.push(Date.now())
      throw new Error(`boom ${calls.length}`)
    }
    const q = makeQueue({ deliver, backoffDelayMs: 100 })
    const statuses: string[] = []
    q.on('status', (e) => statuses.push(e.to))
    const msg = await q.enqueue({ sessionId, phone: '+5511999990004', content: text('x') })
    const failed = await waitFor(() => q.get(msg.id), (m) => m.status === 'failed')
    expect(calls).toHaveLength(3)
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(90)
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(180)
    expect(failed.attempts).toBe(3)
    expect(failed.lastError).toBe('boom 3')
    expect(statuses).toEqual(['queued', 'processing', 'retrying', 'processing', 'retrying', 'processing', 'failed'])
    const events = (await q.events(msg.id)).map((e) => e.to)
    expect(events.filter((s) => s === 'retrying')).toHaveLength(2)
  })

  it('recupera na segunda tentativa', async () => {
    const sessionId = await createSession()
    transport.failNextSend(new Error('temp'))
    const q = makeQueue()
    const msg = await q.enqueue({ sessionId, phone: '+5511999990005', content: text('x') })
    const m = await waitFor(() => q.get(msg.id), (v) => v.status === 'sent')
    expect(m.attempts).toBe(2)
    expect(m.lastError).toBeNull()
  })

  it('cancel de queued → cancelled e nunca chega ao transporte; de sent → erro de transição', async () => {
    const sessionId = await createSession('PAUSED')
    const q = makeQueue()
    const msg = await q.enqueue({ sessionId, phone: '+5511999990006', content: text('x') })
    const cancelled = await q.cancel(msg.id)
    expect(cancelled.status).toBe('cancelled')
    await db.update(sessions).set({ status: 'WARMING' }).where(eq(sessions.id, sessionId))
    await q.resume(sessionId)
    const other = await q.enqueue({ sessionId, phone: '+5511999990006', content: text('y') })
    await waitFor(() => q.get(other.id), (v) => v.status === 'sent')
    expect(transport.sent.map((s) => (s.content as { text: string }).text)).toEqual(['y'])
    await expect(q.cancel(other.id)).rejects.toBeInstanceOf(MessageTransitionError)
    await expect(q.cancel('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(MessageNotFoundError)
  })

  it('sessão PAUSED: jobs ficam queued; resume processa em ordem', async () => {
    const sessionId = await createSession('PAUSED')
    const q = makeQueue()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await q.enqueue({ sessionId, phone: '+5511999990007', content: text(`p${i}`) })).id)
    expect(await q.isPaused(sessionId)).toBe(true)
    await new Promise((r) => setTimeout(r, 200))
    for (const id of ids) expect((await q.get(id)).status).toBe('queued')
    expect(transport.sent).toHaveLength(0)
    await db.update(sessions).set({ status: 'STABLE' }).where(eq(sessions.id, sessionId))
    await q.resume(sessionId)
    await waitFor(() => q.list({ sessionId, status: 'sent' }), (l) => l.length === 3)
    expect(transport.sent.map((s) => (s.content as { text: string }).text)).toEqual(['p0', 'p1', 'p2'])
  })

  it('pausa explícita antes do Worker existir não é desfeita por startSession/enqueue', async () => {
    const sessionId = await createSession('WARMING')
    const q = makeQueue()
    await q.pause(sessionId)
    const msgs = [
      await q.enqueue({ sessionId, phone: '+5511999990011', content: text('c0') }),
      await q.enqueue({ sessionId, phone: '+5511999990011', content: text('c1') }),
    ]
    await q.startSession(sessionId)
    await new Promise((r) => setTimeout(r, 300))
    expect(await q.isPaused(sessionId)).toBe(true)
    expect(transport.sent).toHaveLength(0)
    for (const m of msgs) expect((await q.get(m.id)).status).toBe('queued')
    await q.pause(sessionId)
    await q.resume(sessionId)
    await q.resume(sessionId)
    await waitFor(() => q.list({ sessionId, status: 'sent' }), (l) => l.length === 2)
    expect(transport.sent.map((m) => (m.content as { text: string }).text)).toEqual(['c0', 'c1'])
  })

  it('defesa: sessão PAUSED no banco sem pausa da fila → não entrega, não pausa a fila sozinha e segue ao voltar', async () => {
    const sessionId = await createSession('WARMING')
    const q = makeQueue()
    await q.startSession(sessionId)
    await db.update(sessions).set({ status: 'PAUSED' }).where(eq(sessions.id, sessionId))
    const msg = await q.enqueue({ sessionId, phone: '+5511999990008', content: text('z') })
    await new Promise((r) => setTimeout(r, 300))
    expect((await q.get(msg.id)).status).toBe('queued')
    expect(transport.sent).toHaveLength(0)
    expect(await q.isPaused(sessionId)).toBe(false)
    expect((await q.events(msg.id)).map((e) => e.to)).toEqual(['queued'])
    await db.update(sessions).set({ status: 'WARMING' }).where(eq(sessions.id, sessionId))
    await waitFor(() => q.get(msg.id), (v) => v.status === 'sent')
  })

  it('pause/resume com job segurado: resume rápido após PAUSED no banco sempre retoma (sem corrida)', async () => {
    const sessionId = await createSession('WARMING')
    const q = makeQueue()
    await q.startSession(sessionId)
    for (let round = 0; round < 5; round++) {
      await db.update(sessions).set({ status: 'PAUSED' }).where(eq(sessions.id, sessionId))
      void q.pause(sessionId)
      const m = await q.enqueue({ sessionId, phone: '+5511999990012', content: text(`r${round}`) })
      await new Promise((r) => setTimeout(r, 20 * round))
      await db.update(sessions).set({ status: 'WARMING' }).where(eq(sessions.id, sessionId))
      void q.resume(sessionId)
      await waitFor(() => q.get(m.id), (v) => v.status === 'sent', 3000)
    }
    expect(await q.isPaused(sessionId)).toBe(false)
  })

  it('close com job segurado devolve o job à espera; outra instância entrega depois', async () => {
    const sessionId = await createSession('WARMING')
    const prefix = `wsm_test_${randomBytes(4).toString('hex')}`
    // sem transporte: o job fica ativo, segurado no hold
    const q1 = new MessageQueue({ db, prefix, getTransport: () => undefined, deliver: realDeliver, holdDelayMs: 50 })
    const msg = await q1.enqueue({ sessionId, phone: '+5511999990013', content: text('h') })
    await new Promise((r) => setTimeout(r, 150))
    await q1.close()
    expect((await q1.store.get(msg.id)).status).toBe('queued')
    const q2 = makeQueue({ prefix })
    await q2.startSession(sessionId)
    await waitFor(() => q2.get(msg.id), (v) => v.status === 'sent')
    expect(transport.sent).toHaveLength(1)
  })

  it('sem transporte conectado a mensagem espera queued e segue quando conecta', async () => {
    const sessionId = await createSession('WARMING')
    const holder: { current?: WaTransport } = {}
    const q = makeQueue({ getTransport: () => holder.current })
    const msg = await q.enqueue({ sessionId, phone: '+5511999990009', content: text('w') })
    await new Promise((r) => setTimeout(r, 200))
    expect((await q.get(msg.id)).status).toBe('queued')
    holder.current = transport
    await waitFor(() => q.get(msg.id), (v) => v.status === 'sent')
  })

  it('enqueue valida telefone e sessão', async () => {
    const q = makeQueue()
    const sessionId = await createSession()
    await expect(q.enqueue({ sessionId, phone: '123', content: text('x') })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(q.enqueue({ sessionId: '00000000-0000-4000-8000-000000000000', phone: '+5511999990010', content: text('x') })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    })
  })
})
