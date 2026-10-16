// Ponta a ponta (AC-T20-04): MessageQueue (T14) → deliver real → transporte responde 403 →
// sessão PAUSED, fila pausada, health_event forbidden_403, limites × 0,5 e nenhuma retomada automática.
import { randomBytes } from 'node:crypto'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PassthroughAntibanAdapter } from '../antiban/adapter'
import { createDb, healthEvents, sessions, type Database } from '../db'
import { HealthMonitor } from '../health/monitor'
import { MessageQueue } from '../queue/queue'
import { SessionLimitsService } from '../safety/limits'
import { FakeTransport } from '../transport'
import { bindTransportSession, createDeliver } from './deliver'

let tmp: TempDatabase
let db: Database
let queue: MessageQueue | undefined
let monitor: HealthMonitor | undefined

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, set: 'wa' })
  db = createDb(tmp.url, { max: 8 })
}, 120_000)

afterEach(async () => {
  monitor?.stop()
  await queue?.close()
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('403 no envio', () => {
  it('pausa a sessão e a fila, grava forbidden_403, reduz limites pela metade e não retoma sozinho', async () => {
    const [s] = await db.insert(sessions).values({ name: 's', status: 'STABLE', warmupStartedAt: new Date(Date.now() - 30 * 86_400_000) }).returning()
    const sessionId = s!.id
    const transport = new FakeTransport()
    transport.open()
    bindTransportSession(transport, sessionId)
    const limits = new SessionLimitsService(db)
    queue = new MessageQueue({
      db,
      prefix: `wsm_test_${randomBytes(4).toString('hex')}`,
      getTransport: () => transport,
      backoffDelayMs: 20,
      holdDelayMs: 20,
      deliver: createDeliver({
        antiban: new PassthroughAntibanAdapter({ warn: () => undefined }),
        health: { recordSignal: (id, type, detail) => monitor!.recordSignal(id, type, detail) },
        limits,
      }),
    })
    monitor = new HealthMonitor({ db, queueControl: queue, intervalMs: 0 })

    // Formato do Boom do Baileys: `output.statusCode`.
    transport.failNextSend(Object.assign(new Error('forbidden'), { output: { statusCode: 403 } }))
    const msg = await queue.enqueue({ sessionId, phone: '+5511999990300', content: { text: 'oi' } })

    const statusOf = async () => (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0]!.status
    await waitFor(async () => (await statusOf()) === 'PAUSED')
    await waitFor(() => queue!.isPaused(sessionId))
    // O monitor faz: transição → pausa da fila → grava auto_paused; espera a gravação terminar.
    const typesOf = async () => (await db.select().from(healthEvents).where(eq(healthEvents.sessionId, sessionId))).map((e) => e.type)
    await waitFor(async () => (await typesOf()).includes('auto_paused'))
    const types = await typesOf()
    expect(types).toContain('forbidden_403')
    expect(types).toContain('auto_paused')
    expect((await limits.get(sessionId)).reductionFactor).toBe(0.5)

    // A mensagem não foi entregue e fica na fila (retentativa) enquanto a sessão está pausada.
    expect(transport.sent).toHaveLength(0)
    expect(['retrying', 'queued']).toContain((await queue.get(msg.id)).status)

    // Nenhuma retomada automática: reavaliar, esperar e reavaliar de novo mantém PAUSED.
    await monitor.evaluate(sessionId)
    await new Promise((r) => setTimeout(r, 200))
    await monitor.evaluate(sessionId)
    expect(await statusOf()).toBe('PAUSED')
    expect(await queue.isPaused(sessionId)).toBe(true)
    expect(transport.sent).toHaveLength(0)
  })
})
