// Postgres real (SPEC 3.10): banco descartável migrado; transporte FakeTransport/BaileysTransport com socket fake.
import { EventEmitter } from 'node:events'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, generateCredentialsKey } from '@crm/node-kit'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { healthEvents, proxies, sessionCredentials } from '../db'
import { ProxyService } from '../proxy'
import { BaileysTransport, FakeTransport } from '../transport'
import { SessionManager, type SessionManagerOptions } from './manager'

const cipher = createCipher({ key: generateCredentialsKey() })
let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true, set: 'wa' })
  db = createDb(temp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

function setup(extra: Partial<SessionManagerOptions> = {}) {
  const fakes = new Map<string, FakeTransport[]>()
  const sleeps: number[] = []
  const manager = new SessionManager({
    db,
    cipher,
    transportFactory: (id) => {
      const t = new FakeTransport()
      fakes.set(id, [...(fakes.get(id) ?? []), t])
      return t
    },
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  })
  const last = (id: string) => fakes.get(id)!.at(-1)!
  return { manager, fakes, sleeps, last }
}

const events = (id: string) => db.select({ type: healthEvents.type }).from(healthEvents).where(eq(healthEvents.sessionId, id)).orderBy(healthEvents.id)
const credCount = async (id: string) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(sessionCredentials).where(eq(sessionCredentials.sessionId, id)))[0]!.n

async function openSession(m: ReturnType<typeof setup>) {
  const s = await m.manager.create({ name: 'chip' })
  await m.manager.startQr(s.id)
  m.last(s.id).open()
  await m.manager.whenIdle()
  return s.id
}

describe('SessionManager', () => {
  it('abrir conexão → WARMING, health connected e credenciais cifradas (AC-T13-01)', async () => {
    const m = setup()
    const id = await openSession(m)
    expect((await m.manager.get(id)).status).toBe('WARMING')
    expect((await events(id)).map((e) => e.type)).toContain('connected')
    expect(await credCount(id)).toBeGreaterThan(0)
    const [row] = await db.select().from(sessionCredentials).where(eq(sessionCredentials.sessionId, id)).limit(1)
    expect(row!.ciphertext.toString('utf8')).not.toContain('noiseKey')
    await m.manager.stop()
  })

  it('stop() do processo não emite disconnected (reinício não é queda; T102), mas o hook onDisconnected roda', async () => {
    const hook = vi.fn()
    const m = setup({ onDisconnected: hook })
    const id = await openSession(m)
    const disconnected = vi.fn()
    m.manager.on('disconnected', disconnected)
    await m.manager.stop()
    expect(disconnected).not.toHaveBeenCalled()
    expect(hook).toHaveBeenCalledWith(id, expect.objectContaining({ reason: 'local' }))
    expect((await m.manager.get(id)).status).toBe('WARMING')
  })

  it('loggedOut, forbidden e transient com backoff (AC-T13-02)', async () => {
    const a = setup()
    const out = await openSession(a)
    const connects = a.last(out).connectCalls.length
    await a.last(out).close('loggedOut', 401)
    await a.manager.whenIdle()
    expect((await a.manager.get(out)).status).toBe('DISCONNECTED')
    expect(await credCount(out)).toBe(0)
    expect(a.last(out).connectCalls).toHaveLength(connects)

    const forb = await openSession(a)
    await a.last(forb).close('forbidden', 403)
    await a.manager.whenIdle()
    expect((await a.manager.get(forb)).status).toBe('PAUSED')

    const tr = await openSession(a)
    const reconnects: number[] = []
    a.manager.on('reconnect', (r) => r.sessionId === tr && reconnects.push(r.attempt))
    const fake = a.last(tr)
    for (let i = 0; i < 6; i++) {
      await fake.close('transient', 428)
      await a.manager.whenIdle()
    }
    expect(reconnects).toEqual([1, 2, 3, 4, 5])
    expect(a.sleeps.slice(-5)).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(fake.connectCalls).toHaveLength(6)
    expect((await a.manager.get(tr)).status).toBe('DISCONNECTED')
    expect((await events(tr)).map((e) => e.type)).toContain('reconnect_failed')
    await a.manager.stop()
  })

  it('reinício reconecta sessões com credenciais; PAUSED continua PAUSED (AC-T13-03)', async () => {
    const first = setup()
    const warming = await openSession(first)
    const paused = await openSession(first)
    await first.manager.pause(paused)
    const fresh = (await first.manager.create({ name: 'nova' })).id
    await first.manager.stop()
    expect((await first.manager.get(warming)).status).toBe('WARMING')

    const second = setup()
    await second.manager.start()
    await second.manager.whenIdle()
    expect(second.fakes.get(warming)?.[0]?.connectCalls).toHaveLength(1)
    expect(second.fakes.get(paused)?.[0]?.connectCalls).toHaveLength(1)
    expect(second.fakes.has(fresh)).toBe(false)
    second.last(paused).open()
    await second.manager.whenIdle()
    expect((await second.manager.get(paused)).status).toBe('PAUSED')
    await second.manager.stop()
  })

  it('pairing code só depois do 1º QR e uma vez por socket; QR em data URL (AC-T13-04)', async () => {
    const sock = { ev: new EventEmitter(), sendMessage: vi.fn(), end: vi.fn(), requestPairingCode: vi.fn(async () => 'ABCD1234') }
    const m = setup({ transportFactory: () => new BaileysTransport({ makeSocket: () => sock }) })
    const s = await m.manager.create({ name: 'pair' })
    const pending = m.manager.requestPairingCode(s.id, '+5511999998888')
    await m.manager.whenIdle()
    expect(sock.requestPairingCode).not.toHaveBeenCalled()
    sock.ev.emit('connection.update', { qr: 'q1' })
    sock.ev.emit('connection.update', { qr: 'q2' })
    expect(await pending).toEqual({ code: 'ABCD1234' })
    expect(sock.requestPairingCode).toHaveBeenCalledTimes(1)
    expect(sock.requestPairingCode).toHaveBeenCalledWith('5511999998888')
    await m.manager.stop()

    const q = setup()
    const s2 = await q.manager.create({ name: 'qr' })
    await q.manager.startQr(s2.id)
    q.last(s2.id).emitQr('2@abc')
    await q.manager.whenIdle()
    expect((await q.manager.getQr(s2.id)).qr).toMatch(/^data:image\/png;base64,/)
    await q.manager.stop()
  })

  it('restart e logout concorrentes em série; transição inválida (AC-T13-05)', async () => {
    const m = setup()
    const id = await openSession(m)
    const order: string[] = []
    const r = m.manager.restart(id).then(() => order.push('restart'))
    const l = m.manager.logout(id).then(() => order.push('logout'))
    await Promise.all([r, l])
    await m.manager.whenIdle()
    expect(order).toEqual(['restart', 'logout'])
    const [first, second] = m.fakes.get(id)!
    expect(first!.closed).toBe(true)
    expect(second!.connectCalls).toHaveLength(1)
    expect(second!.closed).toBe(true)
    expect((await m.manager.get(id)).status).toBe('DISCONNECTED')
    expect(await credCount(id)).toBe(0)

    const fresh = await m.manager.create({ name: 'x' })
    await expect(m.manager.resume(fresh.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    await m.manager.stop()
  })

  it('proxy indisponível nunca conecta direto; disponível passa a URL; sem proxy conecta direto (AC-T13-06)', async () => {
    const proxiesSvc = new ProxyService(db, cipher)
    const m = setup()

    const down = await proxiesSvc.create({ url: 'http://user:senha@10.1.1.1:8080' })
    await db.update(proxies).set({ available: false, lastError: 'timeout' }).where(eq(proxies.id, down.id))
    const s1 = await m.manager.create({ name: 'p1', proxyId: down.id })
    await expect(m.manager.startQr(s1.id)).rejects.toMatchObject({ code: 'PROXY_UNAVAILABLE' })
    await expect(m.manager.requestPairingCode(s1.id, '+5511999998888')).rejects.toMatchObject({ code: 'PROXY_UNAVAILABLE' })
    await m.manager.whenIdle()
    expect(m.fakes.get(s1.id)![0]!.connectCalls).toHaveLength(0)
    expect((await m.manager.get(s1.id)).status).toBe('DISCONNECTED')
    expect((await events(s1.id)).map((e) => e.type)).toContain('proxy_unavailable')

    const up = await proxiesSvc.create({ url: 'http://user:senha@10.1.1.2:8080' })
    expect(up.url).toBe('http://user:***@10.1.1.2:8080')
    const s2 = await m.manager.create({ name: 'p2', proxyId: up.id })
    await m.manager.startQr(s2.id)
    expect(m.last(s2.id).lastConnect?.proxyUrl).toBe('http://user:senha@10.1.1.2:8080')

    const s3 = await m.manager.create({ name: 'direto' })
    await m.manager.startQr(s3.id)
    expect(m.last(s3.id).lastConnect?.proxyUrl).toBeUndefined()
    expect(m.last(s3.id).lastConnect?.browser).toHaveLength(3)
    await m.manager.stop()
  })
})
