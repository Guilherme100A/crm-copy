import { describe, expect, it } from 'vitest'
import {
  computeWarmup,
  DAY_MS,
  DEFAULT_WARMUP_SCHEDULE,
  isWarmupComplete,
  resolveWarmupSchedule,
  warmupDailyLimit,
  warmupScheduleFromEnv,
  warmupScheduleTable,
} from './index'

const t0 = new Date('2026-01-01T00:00:00Z')
const at = (days: number) => new Date(t0.getTime() + days * DAY_MS)

describe('warm-up (AC-T10-01)', () => {
  it('defaults do WarmUpConfig do baileys-antiban', () => {
    expect(DEFAULT_WARMUP_SCHEDULE).toEqual({ warmUpDays: 7, day1Limit: 20, growthFactor: 1.8 })
  })

  it.each([
    [0, 0, 0, 20, false],
    [0.5, 7, 0, 20, false],
    [1, 14, 1, 36, false],
    [3.5, 50, 3, 117, false],
    [6.99, 99, 6, 680, false],
    [7, 100, 7, null, true],
    [30, 100, 30, null, true],
  ])('idade %s dias → %s%% (dia %s, limite %s)', (days, percent, day, dailyLimit, complete) => {
    expect(computeWarmup({ startedAt: t0, now: at(days) })).toEqual({ percent, day, dailyLimit, complete })
  })

  it('sem início → 0%; relógio antes do início não fica negativo', () => {
    expect(computeWarmup({ startedAt: null, now: t0 })).toMatchObject({ percent: 0, complete: false, dailyLimit: 20 })
    expect(computeWarmup({ startedAt: t0, now: at(-1) })).toMatchObject({ percent: 0, day: 0 })
  })

  it('cronograma configurável', () => {
    const schedule = { warmUpDays: 5, day1Limit: 30, growthFactor: 2 }
    expect(computeWarmup({ startedAt: t0, now: at(2), schedule })).toEqual({ percent: 40, day: 2, dailyLimit: 120, complete: false })
    expect(isWarmupComplete(t0, at(5), schedule)).toBe(true)
    expect(warmupScheduleTable(schedule).map((r) => r.dailyLimit)).toEqual([30, 60, 120, 240, 480])
    expect(warmupDailyLimit(5, schedule)).toBeNull()
  })

  it('limite diário cresce monotonicamente com o cronograma', () => {
    const limits = warmupScheduleTable().map((r) => r.dailyLimit)
    expect(limits).toEqual([20, 36, 65, 117, 210, 378, 680])
    for (let i = 1; i < limits.length; i++) expect(limits[i]!).toBeGreaterThan(limits[i - 1]!)
  })

  it('validação e env', () => {
    expect(() => resolveWarmupSchedule({ warmUpDays: 0 })).toThrow(RangeError)
    expect(() => resolveWarmupSchedule({ growthFactor: 0.5 })).toThrow(RangeError)
    expect(warmupScheduleFromEnv({})).toEqual(DEFAULT_WARMUP_SCHEDULE)
    expect(warmupScheduleFromEnv({ WARMUP_DAYS: '10', WARMUP_DAY1_LIMIT: '5', WARMUP_GROWTH_FACTOR: '' })).toEqual({
      warmUpDays: 10,
      day1Limit: 5,
      growthFactor: 1.8,
    })
  })
})
