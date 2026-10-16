// Postgres real: limites efetivos a partir de warmup_started_at, redução só para baixo (SPEC T14 AC-05).
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, messages, sessionLimits, sessions, type Database, type SessionStatus } from '../db'
import { DAY_MS, warmupDailyLimit } from '../warmup'
import {
  computeEffectiveLimits,
  DEFAULT_SEND_LIMITS,
  FORBIDDEN_REDUCTION_FACTOR,
  InvalidLimitsError,
  MIN_REDUCTION_FACTOR,
  SessionLimitsService,
  SessionNotFoundError,
} from './limits'

let tmp: TempDatabase
let db: Database
const NOW = new Date('2026-10-15T12:00:00.000Z')

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, set: 'wa' })
  db = createDb(tmp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

async function session(daysAgo: number | null, status: SessionStatus = 'WARMING'): Promise<string> {
  const warmupStartedAt = daysAgo === null ? null : new Date(NOW.getTime() - daysAgo * DAY_MS - 60_000)
  const [row] = await db.insert(sessions).values({ name: 's', status, warmupStartedAt }).returning()
  return row!.id
}

const service = () => new SessionLimitsService(db, { now: () => NOW })

describe('SessionLimitsService', () => {
  it('o limite diário segue o cronograma a partir de warmup_started_at e some ao fim do warm-up', async () => {
    for (const day of [0, 1, 3, 6]) {
      const v = await service().get(await session(day))
      expect(v.warmup.day).toBe(day)
      expect(v.warmupDailyLimit).toBe(warmupDailyLimit(day))
      expect(v.effective.perDay).toBe(Math.min(DEFAULT_SEND_LIMITS.perDay, warmupDailyLimit(day)!))
    }
    const done = await service().get(await session(8, 'STABLE'))
    expect(done.warmup.complete).toBe(true)
    expect(done.warmupDailyLimit).toBeNull()
    expect(done.effective.perDay).toBe(DEFAULT_SEND_LIMITS.perDay)
  })

  it('perDay nunca ultrapassa o cronograma, mesmo com limite manual maior', async () => {
    const id = await session(1)
    const v = await service().set(id, { perDay: 10_000 })
    expect(v.configured.perDay).toBe(10_000)
    expect(v.effective.perDay).toBe(warmupDailyLimit(1))
  })

  it('403 reduz pela metade; reduções só descem (com piso) e nunca aumentam', async () => {
    const svc = service()
    const id = await session(8, 'STABLE')
    expect(FORBIDDEN_REDUCTION_FACTOR).toBe(0.5)
    const a = await svc.reduceAfterForbidden(id)
    expect(a.reductionFactor).toBe(0.5)
    expect(a.reductionReason).toBe('forbidden_403')
    expect(a.effective.perDay).toBe(Math.floor(DEFAULT_SEND_LIMITS.perDay * 0.5))
    expect((await svc.reduce(id, 1.5, 'tentativa de aumento')).reductionFactor).toBe(0.5)
    expect((await svc.reduce(id, 1, 'neutro')).reductionFactor).toBe(0.5)
    expect((await svc.reduceAfterForbidden(id)).reductionFactor).toBe(0.25)
    for (let i = 0; i < 5; i++) await svc.reduceAfterForbidden(id)
    expect((await svc.get(id)).reductionFactor).toBe(MIN_REDUCTION_FACTOR)
    // Só a ação manual zera a redução.
    expect((await svc.set(id, { perMinute: 3 })).reductionFactor).toBe(1)
  })

  it('redução também vale para o limite do warm-up', async () => {
    const id = await session(2)
    const v = await service().reduceAfterForbidden(id)
    expect(v.effective.warmupDailyLimit).toBe(Math.floor(warmupDailyLimit(2)! * 0.5))
    expect(v.effective.perDay).toBeLessThanOrEqual(warmupDailyLimit(2)!)
  })

  it('DEGRADED aplica fator sem gravar', async () => {
    const id = await session(8, 'DEGRADED')
    const v = await service().get(id)
    expect(v.degraded).toBe(true)
    expect(v.effective.factor).toBe(0.5)
    expect(await db.select().from(sessionLimits).where(eq(sessionLimits.sessionId, id))).toEqual([])
  })

  it('valida entradas, sessão inexistente e conta envios outbound', async () => {
    const svc = service()
    const id = await session(8, 'STABLE')
    await expect(svc.set(id, { perDay: 0 })).rejects.toBeInstanceOf(InvalidLimitsError)
    await expect(svc.get('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(SessionNotFoundError)
    await expect(svc.get('nao-uuid')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    await db.insert(messages).values([
      { sessionId: id, phone: '+5511999990200', content: { text: 'a' } },
      { sessionId: id, phone: '+5511999990200', content: { text: 'b' }, status: 'cancelled' },
    ])
    expect(await svc.countOutbound(id, new Date(Date.now() - 60_000))).toBe(1)
  })

  it('computeEffectiveLimits nunca passa dos configurados', () => {
    const e = computeEffectiveLimits({ configured: { perMinute: 5, perHour: 100, perDay: 800 }, reductionFactor: 3, state: 'STABLE', warmupDailyLimit: 20 })
    expect(e).toMatchObject({ perMinute: 5, perHour: 100, perDay: 20, factor: 1 })
  })
})
