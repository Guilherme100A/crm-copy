// AC-T20-03 (sequência do deliver e retry) e AC-T20-04 (403 → PAUSED, fila pausada, health_event, limites × 0,5).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'
import {
  FAST,
  REDIS_URL,
  antibanMod,
  fakeTransport,
  healthMod,
  migratedWaDb,
  newSession,
  queueMod,
  rand,
  safetyMod,
  sendMod,
  sessionStatus,
  sleep,
  waitFor,
  type WaDb,
} from './support'

let pg: WaDb
let S: any
let MessageQueue: any
const open: any[] = []

beforeAll(async () => {
  S = await sendMod()
  ;({ MessageQueue } = await queueMod())
  pg = await migratedWaDb()
})

afterEach(async () => {
  for (const q of open.splice(0)) await q.close().catch(() => {})
})

afterAll(async () => {
  await pg?.close()
})

/** Antiban espião que registra a sequência de chamadas. */
function spyAntiban(log: string[], decision = { allowed: true, delayMs: 250 }) {
  return {
    mode: 'real',
    beforeSend: vi.fn(async (key: string) => {
      log.push(`beforeSend:${key}`)
      return decision
    }),
    afterSend: vi.fn((key: string, _to: string, _c: unknown, id?: string) => void log.push(`afterSend:${key}:${id}`)),
    afterSendFailed: vi.fn((key: string, error?: string) => void log.push(`afterSendFailed:${key}:${error}`)),
    onDelivered: vi.fn(),
    stats: vi.fn(() => ({})),
  }
}

const TO = '5511988887777@s.whatsapp.net'

describe('T20 — deliver (AC-T20-03)', () => {
  it('AC-T20-03 chama beforeSend, a espera (delay do antiban), sendMessage e afterSend, nessa ordem', async () => {
    const log: string[] = []
    const antiban = spyAntiban(log)
    const transport = fakeTransport()
    const send = transport.sendMessage
    transport.sendMessage = async (to: string, c: unknown) => {
      log.push('sendMessage')
      return send(to, c)
    }
    S.bindTransportSession(transport, 'sess-X')
    const deliver = S.createDeliver({ antiban, sleep: async (ms: number) => void log.push(`sleep:${ms}`) })
    const r = await deliver(transport, TO, { text: 'oi' })
    expect(log).toEqual(['beforeSend:sess-X', 'sleep:250', 'sendMessage', `afterSend:sess-X:${r.messageId}`])
    expect(antiban.afterSendFailed).not.toHaveBeenCalled()
  })

  it('AC-T20-03 falha no envio → afterSendFailed (sem afterSend) e o erro é repassado', async () => {
    const log: string[] = []
    const antiban = spyAntiban(log, { allowed: true, delayMs: 0 })
    const transport = fakeTransport()
    transport.failNext(new Error('socket fechado'))
    S.bindTransportSession(transport, 'sess-Y')
    const deliver = S.createDeliver({ antiban, sleep: async () => {} })
    await expect(deliver(transport, TO, { text: 'oi' })).rejects.toThrow('socket fechado')
    expect(log).toEqual(['beforeSend:sess-Y', 'afterSendFailed:sess-Y:socket fechado'])
    expect(antiban.afterSend).not.toHaveBeenCalled()
  })

  it('AC-T20-03 antiban bloqueando → AntibanBlockedError e nada é enviado', async () => {
    const log: string[] = []
    const antiban = spyAntiban(log, { allowed: false, delayMs: 0, reason: 'rajada' } as any)
    const transport = fakeTransport()
    S.bindTransportSession(transport, 'sess-Z')
    const deliver = S.createDeliver({ antiban, sleep: async () => {} })
    await expect(deliver(transport, TO, { text: 'oi' })).rejects.toBeInstanceOf(S.AntibanBlockedError)
    expect(transport.sent).toHaveLength(0)
  })

  it('AC-T20-03 falha no deliver real segue o fluxo de retry da fila (retrying → sent)', async () => {
    const sid = newSession(pg.tmp.url)
    const log: string[] = []
    const antiban = spyAntiban(log, { allowed: true, delayMs: 0 })
    const transport = fakeTransport()
    transport.failNext(new Error('timeout transitório'))
    S.bindTransportSession(transport, sid)
    const q = new MessageQueue({
      db: pg.db,
      connection: { url: REDIS_URL },
      prefix: `t20${rand()}`,
      ...FAST,
      getTransport: () => transport,
      deliver: S.createDeliver({ antiban, sleep: async () => {} }),
    })
    q.on?.('error', () => {})
    open.push(q)
    await q.startSession(sid)
    const view = await q.enqueue({ sessionId: sid, phone: '+5511977776666', content: { text: 'com retry' } })
    await waitFor(async () => (await q.get(view.id)).status === 'sent', 15_000, 'sent após retry')
    expect((await q.get(view.id)).attempts).toBe(2)
    expect(antiban.afterSendFailed).toHaveBeenCalledTimes(1)
    expect(antiban.afterSend).toHaveBeenCalledTimes(1)
    const tos = sqlOk(pg.tmp.url, `SELECT to_status::text FROM public.message_events WHERE message_id = ${lit(view.id)} ORDER BY id;`).map((r) => r[0])
    expect(tos).toEqual(expect.arrayContaining(['retrying', 'sent']))
  })
})

describe('T20 — 403 no envio (AC-T20-04)', () => {
  it('AC-T20-04 403 → sessão PAUSED, fila pausada, health_event forbidden_403 e limites × 0,5; sem retomada automática', async () => {
    const { HealthMonitor } = await healthMod()
    const { SessionLimitsService } = await safetyMod()
    const { createAntibanAdapter } = await antibanMod()
    const sid = newSession(pg.tmp.url)
    const limits = new SessionLimitsService(pg.db)
    const before = await limits.get(sid)
    const transport = fakeTransport()
    for (let i = 0; i < 5; i++) transport.failNext(Object.assign(new Error('forbidden'), { output: { statusCode: 403 } }))
    S.bindTransportSession(transport, sid)

    // fila (T14) → deliver real (ponto único) → HealthMonitor que controla a mesma fila.
    // A referência circular é resolvida pelo closure: o deliver só é chamado quando o worker processa.
    const queue = new MessageQueue({ db: pg.db, connection: { url: REDIS_URL }, prefix: `t20${rand()}`, ...FAST, getTransport: () => transport, deliver: (t: any, to: string, c: any) => realDeliver(t, to, c) })
    queue.on?.('error', () => {})
    open.push(queue)
    const health = new HealthMonitor({ db: pg.db, queueControl: queue, intervalMs: 0 })
    const realDeliver = S.createDeliver({ antiban: createAntibanAdapter({ mode: 'passthrough' }), sleep: async () => {}, health, limits })

    await queue.startSession(sid)
    await queue.enqueue({ sessionId: sid, phone: '+5511966665555', content: { text: 'vai dar 403' } })

    await waitFor(() => sessionStatus(pg.tmp.url, sid) === 'PAUSED', 15_000, 'sessão PAUSED')
    await waitFor(async () => (await queue.isPaused(sid)) === true, 5_000, 'fila pausada')
    const events = sqlOk(pg.tmp.url, `SELECT type FROM public.health_events WHERE session_id = ${lit(sid)} ORDER BY id;`).map((r) => r[0])
    expect(events).toContain('forbidden_403')
    // o deliver reduz os limites logo DEPOIS do sinal ao monitor (que já pausou): espera a gravação
    await waitFor(async () => (await limits.get(sid)).reductionFactor < 1, 5_000, 'limites reduzidos')
    const after = await limits.get(sid)
    expect(after.reductionFactor).toBe(0.5)
    expect(after.effective.perDay).toBe(Math.floor(before.effective.perDay * 0.5))

    // nenhuma retomada automática: reavaliar e esperar não tira de PAUSED
    await health.evaluate(sid)
    await sleep(500)
    await health.evaluate(sid)
    expect(sessionStatus(pg.tmp.url, sid)).toBe('PAUSED')
    expect(await queue.isPaused(sid)).toBe(true)
  })

  it('AC-T20-04 o 403 é reconhecido nas formas do Baileys/HTTP (output.statusCode, statusCode, status)', async () => {
    for (const err of [
      Object.assign(new Error('a'), { output: { statusCode: 403 } }),
      Object.assign(new Error('b'), { statusCode: 403 }),
      Object.assign(new Error('c'), { status: 403 }),
    ]) {
      const recordSignal = vi.fn()
      const reduce = vi.fn()
      const transport = fakeTransport()
      transport.failNext(err)
      S.bindTransportSession(transport, 'sess-403')
      const deliver = S.createDeliver({ antiban: spyAntiban([], { allowed: true, delayMs: 0 }), sleep: async () => {}, health: { recordSignal }, limits: { reduce } })
      await expect(deliver(transport, TO, { text: 'x' })).rejects.toBe(err)
      expect(recordSignal).toHaveBeenCalledWith('sess-403', 'forbidden_403', expect.anything())
      expect(reduce).toHaveBeenCalledWith('sess-403', 0.5, expect.any(String))
    }
  })

  it('AC-T20-04 erro comum (não 403) não pausa nem reduz limites', async () => {
    const recordSignal = vi.fn()
    const reduce = vi.fn()
    const transport = fakeTransport()
    transport.failNext(Object.assign(new Error('timeout'), { status: 500 }))
    S.bindTransportSession(transport, 'sess-500')
    const deliver = S.createDeliver({ antiban: spyAntiban([], { allowed: true, delayMs: 0 }), sleep: async () => {}, health: { recordSignal }, limits: { reduce } })
    await expect(deliver(transport, TO, { text: 'x' })).rejects.toThrow('timeout')
    expect(recordSignal).not.toHaveBeenCalled()
    expect(reduce).not.toHaveBeenCalled()
  })
})
