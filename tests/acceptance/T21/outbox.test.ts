// AC-T21-01 (eventos válidos e na ordem por sessão), AC-T21-04 (buffer com Redis fora) e AC-T21-05 (detach).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { JID, eventsMod, fakeManager, fakeQueue, newRedis, port, rand, readEvents, transportMod, waitFor } from './support'

let redis: any
let attachEventOutbox: any
let FakeTransport: any
const streams: string[] = []
const outboxes: any[] = []

beforeAll(async () => {
  redis = await newRedis()
  ;({ attachEventOutbox } = await eventsMod())
  ;({ FakeTransport } = await transportMod())
})

afterAll(async () => {
  for (const o of outboxes) o.detach?.()
  if (streams.length) await redis.del(...streams).catch(() => {})
  await redis?.quit().catch(() => {})
})

function setup(opts: Record<string, unknown> = {}) {
  const stream = `t21:${rand()}:wsm:events`
  streams.push(stream)
  const manager = fakeManager()
  const queue = fakeQueue()
  const outbox = attachEventOutbox(manager, queue, (opts.redis as any) ?? redis, { stream, retryMs: 20, ...opts })
  outboxes.push(outbox)
  return { stream, manager, queue, outbox }
}

describe('T21 — eventos no stream (AC-T21-01)', () => {
  it('AC-T21-01 recebida, status, estado/conexão, QR, pareamento, contato e LID↔PN viram WaEvent válidos, na ordem', async () => {
    const { stream, manager, queue, outbox } = setup()
    const sid = `sess-${rand()}`
    const t = new FakeTransport()

    manager.emit('state', { sessionId: sid, from: 'NEW', to: 'WARMING' })
    manager.emit('qr', { sessionId: sid, qr: 'data:image/png;base64,iVBORw0KGgo=' })
    manager.emit('pairing-code', { sessionId: sid, code: 'ABCD1234' })
    manager.emit('connected', { sessionId: sid, transport: t, state: 'WARMING' })
    t.receive({ id: 'IN-1', from: JID('5511999998888'), text: 'olá', type: 'conversation' })
    queue.rows.set('out-1', { id: 'out-1', sessionId: sid, transportMessageId: 'WAID-1', status: 'delivered' })
    queue.emit('status', { messageId: 'out-1', sessionId: sid, from: 'sent', to: 'delivered' })
    t.emitContact({ jid: JID('5511977776666'), name: 'Maria' })
    t.emitLidMapping('112233445566@lid', '+5511977776666')
    manager.emit('disconnected', { sessionId: sid, reason: 'transient', statusCode: 515 })

    await outbox.flush()
    const events = await readEvents(redis, stream)
    expect(events.map((e) => e.type)).toEqual([
      'session.state',
      'session.qr',
      'session.pairing_code',
      'session.connection',
      'message.inbound',
      'message.status',
      'contact.upsert',
      'contact.lid_mapping',
      'session.connection',
    ])
    for (const e of events) {
      expect(e.v).toBe(1)
      expect(e.session_id).toBe(sid)
      expect(typeof e.at).toBe('string')
    }
    const [state, qr, pairing, open, inbound, status, contact, lid, close] = events
    expect(state).toMatchObject({ from: 'NEW', to: 'WARMING' })
    expect(typeof qr.qr).toBe('string')
    expect(pairing.code).toBe('ABCD1234')
    expect(open.state).toBe('open')
    expect(inbound.message).toMatchObject({ id: 'IN-1', from: JID('5511999998888'), text: 'olá', from_me: false })
    expect(status).toMatchObject({ message_id: 'out-1', status: 'delivered', transport_message_id: 'WAID-1' })
    expect(contact.contact).toMatchObject({ jid: JID('5511977776666'), name: 'Maria' })
    expect(lid.lid).toBe('112233445566@lid')
    expect(String(lid.pn)).toContain('5511977776666')
    expect(close).toMatchObject({ state: 'close', reason: 'transient' })
  })

  it('AC-T21-01 a ordem é preservada por sessão com duas sessões intercaladas', async () => {
    const { stream, manager, outbox } = setup()
    const a = new FakeTransport()
    const b = new FakeTransport()
    manager.emit('connected', { sessionId: 'sA', transport: a, state: 'STABLE' })
    manager.emit('connected', { sessionId: 'sB', transport: b, state: 'STABLE' })
    for (let i = 0; i < 20; i++) {
      a.receive({ id: `A-${i}`, from: JID('5511900000001'), text: `a${i}` })
      b.receive({ id: `B-${i}`, from: JID('5511900000002'), text: `b${i}` })
    }
    await outbox.flush()
    const events = (await readEvents(redis, stream)).filter((e) => e.type === 'message.inbound')
    expect(events.filter((e) => e.session_id === 'sA').map((e) => e.message.id)).toEqual(Array.from({ length: 20 }, (_, i) => `A-${i}`))
    expect(events.filter((e) => e.session_id === 'sB').map((e) => e.message.id)).toEqual(Array.from({ length: 20 }, (_, i) => `B-${i}`))
  })

  it('AC-T21-01 histórico vira history.batch com mensagens historical: true (aceito por parseWaEvent)', async () => {
    const { stream, manager, outbox } = setup()
    const t = new FakeTransport()
    manager.emit('connected', { sessionId: 'sH', transport: t, state: 'STABLE' })
    t.emitHistory({
      messages: [
        { id: 'H-1', from: JID('5511900000009'), from_me: false, timestamp: 1_700_000_000_000, type: 'conversation', text: 'antiga', key: { remoteJid: JID('5511900000009'), fromMe: false, id: 'H-1' } },
      ],
    })
    await outbox.flush()
    const batch = (await readEvents(redis, stream)).find((e) => e.type === 'history.batch')
    expect(batch, 'history.batch não publicado').toBeDefined()
    expect(batch.messages.map((m: any) => m.id)).toContain('H-1')
    for (const m of batch.messages) expect(m.historical).toBe(true)
  })

  it('AC-T21-01 usa XADD com MAXLEN ~ no stream wsm:events por padrão', async () => {
    const xadd = vi.fn(async () => '1-0')
    const manager = fakeManager()
    const outbox = attachEventOutbox(manager, undefined, { xadd }, { retryMs: 20 })
    outboxes.push(outbox)
    manager.emit('qr', { sessionId: 'sQ', qr: 'data:image/png;base64,AAA=' })
    await outbox.flush()
    expect(xadd).toHaveBeenCalledTimes(1)
    const args = xadd.mock.calls[0] as unknown as unknown[]
    expect(args[0]).toBe('wsm:events')
    expect(args.slice(1, 4)).toEqual(['MAXLEN', '~', 100000])
    expect(args.slice(4, 6)).toEqual(['*', 'event'])
    const { parseWaEvent } = await port()
    expect(parseWaEvent(JSON.parse(String(args[6]))).type).toBe('session.qr')
  })
})

describe('T21 — Redis fora do ar (AC-T21-04)', () => {
  it('AC-T21-04 eventos ficam em buffer e saem, em ordem, quando o Redis volta; a sessão segue funcionando', async () => {
    let down = true
    const published: any[] = []
    const xadd = vi.fn(async (...args: unknown[]) => {
      if (down) throw new Error('connect ECONNREFUSED 127.0.0.1:6379')
      published.push(JSON.parse(String(args.at(-1))))
      return `${published.length}-0`
    })
    const manager = fakeManager()
    const outbox = attachEventOutbox(manager, undefined, { xadd }, { retryMs: 20 })
    outboxes.push(outbox)
    const t = new FakeTransport()
    // a emissão nunca lança, mesmo com o Redis fora
    expect(() => manager.emit('connected', { sessionId: 'sR', transport: t, state: 'STABLE' })).not.toThrow()
    for (let i = 0; i < 5; i++) expect(() => t.receive({ id: `R-${i}`, from: JID('5511900000003'), text: `r${i}` })).not.toThrow()
    await waitFor(() => xadd.mock.calls.length >= 2, 5_000, 'tentativas de XADD')
    expect(published).toHaveLength(0)
    expect(outbox.pending).toBeGreaterThan(0)
    expect(t.connected === false || t.closed === false).toBe(true)

    down = false
    await outbox.flush()
    expect(outbox.pending).toBe(0)
    expect(published.map((e) => e.type)).toEqual(['session.connection', ...Array(5).fill('message.inbound')])
    expect(published.filter((e) => e.type === 'message.inbound').map((e) => e.message.id)).toEqual(['R-0', 'R-1', 'R-2', 'R-3', 'R-4'])
  })
})

describe('T21 — detach (AC-T21-05)', () => {
  const TRANSPORT_EVENTS = ['message', 'receipt', 'contact', 'lid-mapping', 'presence', 'history']

  it('AC-T21-05 detach() remove todos os listeners do transporte, do manager e da fila', async () => {
    const manager = fakeManager()
    const queue = fakeQueue()
    const xadd = vi.fn(async () => '1-0')
    const outbox = attachEventOutbox(manager, queue, { xadd }, { retryMs: 20 })
    const t = new FakeTransport()
    manager.emit('connected', { sessionId: 'sD', transport: t, state: 'STABLE' })
    const attached = TRANSPORT_EVENTS.reduce((n, e) => n + t.listenerCount(e), 0)
    expect(attached, 'outbox não assinou o transporte').toBeGreaterThan(0)

    // o que foi emitido ANTES do detach pode terminar de publicar; o teste mede só o que vem depois
    await outbox.flush()
    outbox.detach()
    for (const e of TRANSPORT_EVENTS) expect(t.listenerCount(e), `listener de ${e}`).toBe(0)
    for (const e of ['connected', 'disconnected', 'state', 'qr', 'pairing-code']) expect(manager.listenerCount(e), `manager ${e}`).toBe(0)
    expect(queue.listenerCount('status')).toBe(0)

    // nada é publicado depois do detach
    const before = xadd.mock.calls.length
    t.receive({ id: 'X', from: JID('5511900000004'), text: 'depois' })
    manager.emit('qr', { sessionId: 'sD', qr: 'x' })
    await new Promise((r) => setTimeout(r, 100))
    const after = (xadd.mock.calls as unknown as unknown[][]).slice(before).map((c) => JSON.parse(String(c.at(-1))).type)
    expect(after, 'eventos publicados depois do detach').toEqual([])
  })
})
