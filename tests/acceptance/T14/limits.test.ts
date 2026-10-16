// AC-T14-05: limite diário segue o cronograma a partir de warmup_started_at; o serviço de limites só reduz
// (fator 0,5 após 403) e nunca ultrapassa o cronograma.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migratedWaDb, newSession, safetyMod, warmupMod, type WaDb } from './support'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-15T12:00:00.000Z')
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

let pg: WaDb
let w: any
let s: any
let limits: any

beforeAll(async () => {
  w = await warmupMod()
  s = await safetyMod()
  pg = await migratedWaDb()
  limits = new s.SessionLimitsService(pg.db, { now: () => NOW })
})

afterAll(async () => {
  await pg?.close()
})

describe('T14 — cronograma de warm-up', () => {
  it('AC-T14-05 cronograma padrão: 7 dias, 20 no dia 0, crescimento 1,8×; sem limite depois do dia 7', () => {
    expect(w.warmupDailyLimit(0)).toBe(20)
    expect(w.warmupDailyLimit(1)).toBe(36)
    expect(w.warmupDailyLimit(2)).toBe(65)
    expect(w.warmupDailyLimit(6)).toBe(Math.round(20 * 1.8 ** 6))
    expect(w.warmupDailyLimit(7)).toBeNull()
    for (let d = 1; d < 7; d++) expect(w.warmupDailyLimit(d)).toBeGreaterThan(w.warmupDailyLimit(d - 1))
  })

  it('AC-T14-05 o dia do cronograma é contado a partir de warmup_started_at', () => {
    expect(w.computeWarmup({ startedAt: ago(0.5), now: NOW })).toMatchObject({ day: 0, dailyLimit: 20, complete: false })
    expect(w.computeWarmup({ startedAt: ago(2.5), now: NOW })).toMatchObject({ day: 2, dailyLimit: 65, complete: false })
    expect(w.computeWarmup({ startedAt: ago(10), now: NOW })).toMatchObject({ dailyLimit: null, complete: true })
  })
})

describe('T14 — SessionLimitsService', () => {
  it('AC-T14-05 limite diário efetivo = cronograma do dia (desde warmup_started_at), abaixo do configurado', async () => {
    const sid = newSession(pg.tmp.url, { warmupStartedAt: ago(2.5) })
    const v = await limits.get(sid)
    expect(v.warmupDailyLimit).toBe(65)
    expect(v.effective.perDay).toBe(65)
    expect(v.effective.perDay).toBeLessThanOrEqual(v.configured.perDay)
  })

  it('AC-T14-05 warm-up concluído: vale o limite configurado', async () => {
    const sid = newSession(pg.tmp.url, { warmupStartedAt: ago(10) })
    const v = await limits.get(sid)
    expect(v.warmupDailyLimit).toBeNull()
    expect(v.effective.perDay).toBe(v.configured.perDay)
  })

  it('AC-T14-05 após 403 o fator cai para 0,5 e os limites efetivos são reduzidos', async () => {
    const sid = newSession(pg.tmp.url, { warmupStartedAt: ago(10) })
    const before = await limits.get(sid)
    expect(s.FORBIDDEN_REDUCTION_FACTOR).toBe(0.5)
    const after = await limits.reduceAfterForbidden(sid)
    expect(after.reductionFactor).toBe(0.5)
    expect(after.reductionReason).toBeTruthy()
    expect(after.effective.perDay).toBe(Math.floor(before.effective.perDay * 0.5))
    expect(after.effective.perHour).toBe(Math.floor(before.effective.perHour * 0.5))
  })

  it('AC-T14-05 o serviço só reduz: fator >= 1 é ignorado e reduções acumulam', async () => {
    const sid = newSession(pg.tmp.url, { warmupStartedAt: ago(10) })
    await limits.reduce(sid, 0.5, 'teste')
    const up = await limits.reduce(sid, 2, 'tentativa de aumento')
    expect(up.reductionFactor).toBe(0.5)
    const same = await limits.reduce(sid, 1, 'neutro')
    expect(same.reductionFactor).toBe(0.5)
    const down = await limits.reduce(sid, 0.5, 'de novo')
    expect(down.reductionFactor).toBe(0.25)
  })

  it('AC-T14-05 com redução durante o warm-up, o limite fica abaixo do cronograma reduzido', async () => {
    const sid = newSession(pg.tmp.url, { warmupStartedAt: ago(2.5) })
    const v = await limits.reduceAfterForbidden(sid)
    expect(v.effective.perDay).toBeLessThanOrEqual(65)
    expect(v.effective.perDay).toBe(Math.floor(65 * 0.5))
  })

  it('AC-T14-05 nunca ultrapassa o cronograma, mesmo com limite configurado manualmente alto', async () => {
    const sid = newSession(pg.tmp.url, { warmupStartedAt: ago(1.2) })
    const v = await limits.set(sid, { perDay: 100_000, perHour: 10_000, perMinute: 1_000 })
    expect(v.configured.perDay).toBe(100_000)
    expect(v.effective.perDay).toBe(36)
    // em todos os dias do warm-up o efetivo fica <= cronograma
    for (let d = 0; d < 7; d++) {
      const svc = new s.SessionLimitsService(pg.db, { now: () => new Date(ago(1.2).getTime() + (d + 0.5) * DAY) })
      const view = await svc.get(sid)
      expect(view.effective.perDay, `dia ${d}`).toBeLessThanOrEqual(w.warmupDailyLimit(d))
    }
  })

  it('AC-T14-05 sessão sem warmup_started_at começa no dia 0 do cronograma', async () => {
    const sid = newSession(pg.tmp.url, { warmupStartedAt: null })
    const v = await limits.get(sid)
    expect(v.effective.perDay).toBeLessThanOrEqual(20)
  })
})
