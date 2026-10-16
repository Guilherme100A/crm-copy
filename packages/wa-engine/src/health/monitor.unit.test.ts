// HealthMonitor + SessionManager (T13) com Postgres local (banco descartável), FakeTransport e relógio injetado.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { generateCredentialsKey, resetCredentialsCrypto } from '@crm/node-kit'
import { createDb, healthEvents, messages, sessions, type Database } from '../db'
import { SessionManager, type TransportFactory } from '../session/manager'
import { FakeTransport } from '../transport'
import { DAY_MS } from '../warmup'
import { HealthMonitor, type HealthAlert } from './monitor'

interface FakeTransportFactory {
  factory: TransportFactory
  last(sessionId: string): FakeTransport | undefined
}

/** Factory de FakeTransport que guarda as instâncias por sessão (no ai-manager: sessions/transport-factory.ts). */
function createFakeTransportFactory(): FakeTransportFactory {
  const created = new Map<string, FakeTransport[]>()
  const factory: TransportFactory = (sessionId) => {
    const t = new FakeTransport()
    created.set(sessionId, [...(created.get(sessionId) ?? []), t])
    return t
  }
  return { factory, last: (sessionId) => created.get(sessionId)?.at(-1) }
}

let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const HOUR = 60 * 60 * 1000

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, set: 'wa', prefix: 'crm_test_health' })
  db = createDb(tmp.url, { max: 6 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

let clock: Date
let fakes: FakeTransportFactory
let manager: SessionManager
let monitor: HealthMonitor
let alerts: HealthAlert[]
let queuePaused: string[]
let managerStates: Array<{ from: string; to: string }>

beforeEach(async () => {
  await db.delete(sessions)
  clock = new Date()
  fakes = createFakeTransportFactory()
  alerts = []
  queuePaused = []
  managerStates = []
  monitor = new HealthMonitor({ db, logger: quiet, now: () => clock, intervalMs: 0, queueControl: { pause: (id) => void queuePaused.push(id) } })
  manager = new SessionManager({
    db,
    transportFactory: fakes.factory,
    sleep: async () => {},
    logger: quiet,
    now: () => clock,
    onConnected: monitor.onConnected,
    onDisconnected: monitor.onDisconnected,
    resumeState: monitor.resumeState,
  })
  monitor.attach(manager)
  monitor.on('alert', (a) => alerts.push(a))
  manager.on('state', (s) => managerStates.push({ from: s.from, to: s.to }))
})

afterEach(async () => {
  monitor.stop()
  await manager.stop()
})

const advance = (ms: number) => (clock = new Date(clock.getTime() + ms))
const status = async (id: string) => (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!.status
const eventTypes = async (id: string) => (await db.select().from(healthEvents).where(eq(healthEvents.sessionId, id))).map((e) => e.type)
const failures = async (id: string, n: number) => {
  for (let i = 0; i < n; i++) {
    await db.insert(messages).values({ sessionId: id, phone: '+5511999990002', content: { text: 'x' }, status: 'failed', createdAt: clock })
  }
}
const forbidden = (id: string) => db.insert(healthEvents).values({ sessionId: id, type: 'forbidden_403', createdAt: clock })

async function connected() {
  const s = await manager.create({ name: 's', phone: '+5511999990001' })
  await manager.startQr(s.id)
  fakes.last(s.id)!.open()
  await manager.whenIdle()
  return s.id
}

describe('HealthMonitor (T10)', () => {
  it('conexão nova fica em WARMING; warm-up 100% → STABLE', async () => {
    const id = await connected()
    expect(await status(id)).toBe('WARMING')
    expect((await monitor.getHealth(id)).warmupPercent).toBe(0)
    advance(3.5 * DAY_MS)
    expect(await monitor.evaluate(id)).toMatchObject({ state: 'WARMING', warmupPercent: 50 })
    advance(3.5 * DAY_MS)
    expect(await monitor.evaluate(id)).toMatchObject({ state: 'STABLE', warmupPercent: 100, label: 'Good' })
    expect(await eventTypes(id)).toContain('warmup_completed')
    expect(managerStates).toContainEqual({ from: 'WARMING', to: 'STABLE' })
  })

  it('score < 70 → DEGRADED com alerta; recuperado → volta ao estado anterior', async () => {
    const id = await connected()
    await failures(id, 5)
    const h = await monitor.evaluate(id)
    expect(h).toMatchObject({ state: 'DEGRADED', label: 'Warning', failed: 5 })
    expect(alerts.map((a) => a.type)).toContain('health_degraded')
    expect(alerts.find((a) => a.type === 'health_degraded')).toMatchObject({ sessionId: id, detail: { level: 'warning' } })
    expect(queuePaused).toEqual([])
    advance(25 * HOUR) // sinais saem da janela de 24h
    expect(await monitor.evaluate(id)).toMatchObject({ state: 'WARMING', score: 100 })
    expect(await eventTypes(id)).toEqual(expect.arrayContaining(['health_degraded', 'health_recovered']))
  })

  it('qualquer 403 → PAUSED automático, fila pausada, health_event e alertas; nunca sai de PAUSED sozinho', async () => {
    const id = await connected()
    await forbidden(id)
    expect(await monitor.evaluate(id)).toMatchObject({ state: 'PAUSED', forbidden403: 1 })
    expect(queuePaused).toEqual([id])
    expect(alerts.map((a) => a.type).sort()).toEqual(['forbidden_403', 'warmup_paused'])
    expect(managerStates).toContainEqual({ from: 'WARMING', to: 'PAUSED' })
    expect(await eventTypes(id)).toContain('auto_paused')
    advance(2 * DAY_MS)
    expect((await monitor.evaluate(id)).state).toBe('PAUSED')
  })

  it('resume manual: volta a WARMING/STABLE conforme warm-up e sinais anteriores não re-pausam', async () => {
    const id = await connected()
    await forbidden(id)
    await monitor.evaluate(id)
    advance(60_000)
    expect((await manager.resume(id)).status).toBe('WARMING')
    expect(await monitor.evaluate(id)).toMatchObject({ state: 'WARMING', forbidden403: 0 })
    await manager.pause(id)
    advance(8 * DAY_MS)
    expect((await manager.resume(id)).status).toBe('STABLE')
  })

  it('score < 40 → PAUSED com alerta crítico', async () => {
    const id = await connected()
    await failures(id, 10)
    for (let i = 0; i < 6; i++) await db.insert(healthEvents).values({ sessionId: id, type: 'disconnected', createdAt: clock })
    expect(await monitor.evaluate(id)).toMatchObject({ state: 'PAUSED', label: 'Critical' })
    expect(queuePaused).toEqual([id])
    const critical = alerts.find((a) => a.type === 'health_degraded')
    expect(critical?.detail).toMatchObject({ level: 'critical', paused: true })
    expect(alerts.map((a) => a.type)).toContain('error_burst')
  })

  it('queda com 403 na conexão: fila pausada, alerta forbidden_403 e sessão PAUSED', async () => {
    const id = await connected()
    await fakes.last(id)!.close('forbidden', 403)
    await manager.whenIdle()
    expect(await status(id)).toBe('PAUSED')
    expect(queuePaused).toEqual([id])
    expect(alerts.map((a) => a.type).sort()).toEqual(['forbidden_403', 'warmup_paused'])
  })

  it('queda transitória emite alerta disconnected', async () => {
    const id = await connected()
    await fakes.last(id)!.close('transient', 428)
    await manager.whenIdle()
    expect(alerts[0]).toMatchObject({ type: 'disconnected', sessionId: id, detail: { reason: 'transient', statusCode: 428 } })
  })

  it('recordSignal(forbidden_403) pausa na hora', async () => {
    const id = await connected()
    expect((await monitor.recordSignal(id, 'forbidden_403', { source: 'send' })).state).toBe('PAUSED')
  })

  it('timer periódico avalia sessões conectadas até a desconexão', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const m = new HealthMonitor({ db, logger: quiet, intervalMs: 1000 })
      const spy = vi.spyOn(m, 'evaluate').mockResolvedValue({} as never)
      const id = '00000000-0000-4000-8000-000000000001'
      await m.onConnected(id)
      spy.mockClear()
      vi.advanceTimersByTime(3000)
      expect(spy).toHaveBeenCalledTimes(3)
      await m.onDisconnected(id, { sessionId: id, reason: 'local' })
      vi.advanceTimersByTime(3000)
      expect(spy).toHaveBeenCalledTimes(3)
      m.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('getHealth: sessão inexistente → SESSION_NOT_FOUND', async () => {
    await expect(monitor.getHealth('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})
