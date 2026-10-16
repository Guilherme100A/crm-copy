// Outbox com fakes (manager = EventEmitter, FakeTransport, fila fake, Redis fake) e um teste contra o Redis real.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { FsBlobStore, redisConnection, sha256Hex } from '@crm/node-kit'
import { parseWaEvent, type WaEvent } from '@crm/wa-port'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { MediaService } from '../media'
import { FakeTransport, type TransportEvent } from '../transport'
import { attachEventOutbox, OUTBOX_EVENT_FIELD, type OutboxManager, type OutboxQueue } from './outbox'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function blobStore() {
  const dir = mkdtempSync(join(tmpdir(), 'crm-outbox-'))
  dirs.push(dir)
  return new FsBlobStore({ dir })
}

class FakeRedis {
  readonly entries: { stream: string; args: (string | number)[]; event: WaEvent }[] = []
  failures = 0
  async xadd(...args: (string | number)[]) {
    if (this.failures > 0) {
      this.failures--
      throw new Error('Connection is closed.')
    }
    const json = String(args.at(-1))
    this.entries.push({ stream: String(args[0]), args, event: parseWaEvent(json) })
    return `${this.entries.length}-0`
  }
  types(sessionId?: string) {
    return this.entries.filter((e) => !sessionId || e.event.session_id === sessionId).map((e) => e.event.type)
  }
}

class FakeQueue extends EventEmitter implements OutboxQueue {
  readonly views = new Map<string, { transportMessageId: string | null; lastError: string | null }>()
  async get(id: string) {
    return this.views.get(id) ?? { transportMessageId: null, lastError: null }
  }
}

function setup(opts: { media?: MediaService; retryMs?: number } = {}) {
  const manager = new EventEmitter()
  const queue = new FakeQueue()
  const redis = new FakeRedis()
  const outbox = attachEventOutbox(manager as unknown as OutboxManager, queue, redis, { retryMs: opts.retryMs ?? 10, ...(opts.media ? { media: opts.media } : {}) })
  const transport = new FakeTransport()
  const connect = (sessionId: string, t = transport) => {
    t.open()
    manager.emit('connected', { sessionId, transport: t, state: 'WARMING' })
  }
  return { manager, queue, redis, outbox, transport, connect }
}

describe('attachEventOutbox', () => {
  it('AC-01: cada tipo de evento vira WaEvent válido no stream, na ordem de ocorrência da sessão', async () => {
    const { manager, queue, redis, outbox, transport, connect } = setup()
    manager.emit('qr', { sessionId: 's1', qr: 'raw-qr-payload' })
    manager.emit('pairing-code', { sessionId: 's1', code: 'ABCD1234' })
    manager.emit('state', { sessionId: 's1', from: 'NEW', to: 'WARMING' })
    connect('s1')
    transport.receive({ id: 'in-1', from: '5511999990001@s.whatsapp.net', text: 'oi' })
    transport.emitContact({ jid: '5511999990001@s.whatsapp.net', phone: '+5511999990001', name: 'Ana' })
    transport.emitLidMapping('123456@lid', '5511999990001@s.whatsapp.net')
    transport.emitPresence({ jid: '5511999990001@s.whatsapp.net', presence: 'composing' })
    transport.emitHistory({ messages: [transport.receive({ id: 'old-1', from: '5511999990002@s.whatsapp.net', text: 'antiga' })], sync_type: 'RECENT' })
    queue.views.set('m1', { transportMessageId: 'wamid-1', lastError: null })
    queue.emit('status', { messageId: 'm1', sessionId: 's1', from: 'processing', to: 'sent' })
    manager.emit('disconnected', { sessionId: 's1', reason: 'transient', statusCode: 428 })
    await outbox.flush()

    expect(redis.types('s1')).toEqual([
      'session.qr',
      'session.pairing_code',
      'session.state',
      'session.connection',
      'message.inbound',
      'contact.upsert',
      'contact.lid_mapping',
      'presence.update',
      'message.inbound',
      'history.batch',
      'message.status',
      'session.connection',
    ])
    const ev = redis.entries.map((e) => e.event)
    expect(ev[0]).toMatchObject({ type: 'session.qr', qr: expect.stringMatching(/^data:image\/png;base64,/) })
    expect(ev[3]).toMatchObject({ state: 'open' })
    expect(ev[4]).toMatchObject({ message: { id: 'in-1', text: 'oi', from_me: false } })
    expect(ev[4]).not.toHaveProperty('message.key')
    expect(ev[6]).toMatchObject({ lid: '123456@lid', pn: '+5511999990001' })
    expect(ev[9]).toMatchObject({ type: 'history.batch', sync_type: 'RECENT', messages: [{ id: 'old-1', historical: true }] })
    expect(ev[10]).toMatchObject({ message_id: 'm1', transport_message_id: 'wamid-1', status: 'sent' })
    expect(ev[11]).toMatchObject({ state: 'close', reason: 'transient', status_code: 428 })
    expect(redis.entries[0]!.args.slice(0, 6)).toEqual(['wsm:events', 'MAXLEN', '~', 100_000, '*', OUTBOX_EVENT_FIELD])
  })

  it('a ordem por sessão se mantém mesmo quando a mídia demora a baixar', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const media = new MediaService({
      blobStore: blobStore(),
      download: async () => {
        await gate
        return new Uint8Array([1, 2, 3])
      },
    })
    const { redis, outbox, transport, connect } = setup({ media })
    connect('s1')
    transport.receive({ id: 'img', from: '5511@s.whatsapp.net', type: 'imageMessage', media: { kind: 'image', mime: 'image/jpeg', size: 3, sha256: null } })
    transport.emitContact({ jid: '5511@s.whatsapp.net', phone: '+5511' })
    await new Promise((r) => setTimeout(r, 20))
    expect(redis.types('s1')).toEqual(['session.connection'])
    release()
    await outbox.flush()
    expect(redis.types('s1')).toEqual(['session.connection', 'message.inbound', 'contact.upsert'])
  })

  it('AC-02: imagem recebida é gravada no BlobStore e o evento traz key, mime, size e sha256', async () => {
    const store = blobStore()
    const bytes = new Uint8Array(randomBytes(64))
    const { redis, outbox, transport, connect } = setup({ media: new MediaService({ blobStore: store, getTransport: () => transport }) })
    connect('s1')
    transport.receive({ id: 'img-1', from: '5511@s.whatsapp.net', type: 'imageMessage', text: 'legenda', media: { kind: 'image', mime: 'image/jpeg', size: 64, sha256: null }, data: bytes })
    await outbox.flush()
    const ev = redis.entries.find((e) => e.event.type === 'message.inbound')!.event as Extract<WaEvent, { type: 'message.inbound' }>
    const m = ev.message.media!
    expect(m).toMatchObject({ session_id: 's1', message_id: 'img-1', mime: 'image/jpeg', size: 64, sha256: sha256Hex(bytes), status: 'ready' })
    expect(Buffer.from((await store.get(m.key!))!).equals(Buffer.from(bytes))).toBe(true)
  })

  it('AC-04: Redis indisponível não derruba a sessão; eventos ficam em buffer e saem quando ele volta', async () => {
    const { redis, outbox, transport, connect } = setup({ retryMs: 15 })
    redis.failures = 3
    connect('s1')
    expect(() => transport.receive({ id: 'a', from: '5511@s.whatsapp.net', text: '1' })).not.toThrow()
    transport.receive({ id: 'b', from: '5511@s.whatsapp.net', text: '2' })
    await new Promise((r) => setTimeout(r, 5))
    expect(outbox.pending).toBeGreaterThan(0)
    expect(redis.entries).toHaveLength(0)
    await outbox.flush()
    expect(outbox.pending).toBe(0)
    expect(redis.types('s1')).toEqual(['session.connection', 'message.inbound', 'message.inbound'])
    expect(redis.entries.map((e) => (e.event as { message?: { id: string } }).message?.id)).toEqual([undefined, 'a', 'b'])
  })

  it('AC-05: detach() remove todos os listeners do transporte, do manager e da fila', async () => {
    const { manager, queue, outbox, transport, connect, redis } = setup()
    connect('s1')
    const events: TransportEvent[] = ['message', 'receipt', 'contact', 'lid-mapping', 'presence', 'history']
    expect(events.some((e) => transport.listenerCount(e) > 0)).toBe(true)
    outbox.detach()
    for (const e of events) expect(transport.listenerCount(e)).toBe(0)
    for (const e of ['connected', 'disconnected', 'state', 'qr', 'pairing-code']) expect(manager.listenerCount(e)).toBe(0)
    expect(queue.listenerCount('status')).toBe(0)
    await outbox.flush()
    const before = redis.entries.length
    transport.receive({ id: 'depois', from: '5511@s.whatsapp.net', text: 'x' })
    await outbox.flush()
    expect(redis.entries).toHaveLength(before)
  })

  it('transporte novo na mesma sessão (restart) troca os listeners do antigo', async () => {
    const { redis, outbox, transport, connect } = setup()
    connect('s1')
    const second = new FakeTransport()
    connect('s1', second)
    expect(transport.listenerCount('message')).toBe(0)
    second.receive({ id: 'novo', from: '5511@s.whatsapp.net', text: 'x' })
    transport.receive({ id: 'velho', from: '5511@s.whatsapp.net', text: 'x' })
    await outbox.flush()
    expect(redis.entries.filter((e) => e.event.type === 'message.inbound').map((e) => (e.event as { message: { id: string } }).message.id)).toEqual(['novo'])
  })

  it('evento inválido é descartado com log, sem travar o buffer', async () => {
    const error = vi.fn()
    const manager = new EventEmitter()
    const redis = new FakeRedis()
    const outbox = attachEventOutbox(manager as unknown as OutboxManager, undefined, redis, { logger: { warn: vi.fn(), error } })
    manager.emit('pairing-code', { sessionId: 's1', code: '' })
    manager.emit('pairing-code', { sessionId: 's1', code: 'OK123456' })
    await outbox.flush()
    expect(redis.types()).toEqual(['session.pairing_code'])
    expect(error).toHaveBeenCalled()
  })
})

describe('outbox contra o Redis real', () => {
  it('XADD no stream com MAXLEN e campo event legível pelo consumidor', async () => {
    const redis = redisConnection()
    const stream = `test:wsm:events:${randomBytes(4).toString('hex')}`
    try {
      const manager = new EventEmitter()
      const outbox = attachEventOutbox(manager as unknown as OutboxManager, undefined, redis, { stream, maxLen: 1000 })
      manager.emit('state', { sessionId: 's1', from: 'WARMING', to: 'STABLE' })
      manager.emit('pairing-code', { sessionId: 's1', code: 'ZZ998877' })
      await outbox.flush()
      const entries = (await redis.xrange(stream, '-', '+')) as [string, string[]][]
      expect(entries).toHaveLength(2)
      const [, fields] = entries[0]!
      expect(fields[0]).toBe('event')
      expect(parseWaEvent(fields[1]!)).toMatchObject({ type: 'session.state', from: 'WARMING', to: 'STABLE' })
      outbox.detach()
    } finally {
      await redis.del(stream)
      await redis.quit()
    }
  })
})
