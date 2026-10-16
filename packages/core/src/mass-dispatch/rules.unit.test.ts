import { describe, expect, it } from 'vitest'
import { MassDispatchError, parseSchedule, parseWeekdays, quotaPeriod, warmupCapacity } from './rules'

const defaults = { timeZone: 'America/Sao_Paulo', now: new Date('2026-10-16T12:00:00Z') }
const fieldOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    return (err as MassDispatchError).details?.fields as Array<{ path: string }>
  }
  throw new Error('não lançou')
}

describe('agenda', () => {
  it('padrões e normalização', () => {
    expect(parseSchedule({ weekdays: '5,1,1' }, defaults)).toEqual({
      weekdays: [1, 5],
      windowStart: '08:00',
      windowEnd: '18:00',
      timeZone: 'America/Sao_Paulo',
      intervalMinSeconds: 5,
      intervalMaxSeconds: 30,
      dailyLimit: null,
      startsSchedulingAt: defaults.now,
    })
    expect(parseWeekdays(['0', 6])).toEqual([0, 6])
    expect(parseWeekdays('[2,3]')).toEqual([2, 3])
  })

  it('erros de validação', () => {
    expect(fieldOf(() => parseSchedule({ weekdays: [] }, defaults))[0]!.path).toBe('weekdays')
    expect(fieldOf(() => parseSchedule({ weekdays: [7] }, defaults))[0]!.path).toBe('weekdays')
    expect(fieldOf(() => parseSchedule({ weekdays: [1], window_start: '18:00', window_end: '18:00' }, defaults))[0]!.path).toBe('window_end')
    expect(fieldOf(() => parseSchedule({ weekdays: [1], window_start: '25:00' }, defaults))[0]!.path).toBe('window_start')
    expect(fieldOf(() => parseSchedule({ weekdays: [1], interval_min_seconds: 30, interval_max_seconds: 10 }, defaults))[0]!.path).toBe('interval_max_seconds')
    expect(fieldOf(() => parseSchedule({ weekdays: [1], interval_max_seconds: 121 }, defaults))[0]!.path).toBe('interval_max_seconds')
    expect(fieldOf(() => parseSchedule({ weekdays: [1], daily_limit: 0 }, defaults))[0]!.path).toBe('daily_limit')
    expect(fieldOf(() => parseSchedule({ weekdays: [1], time_zone: 'Lua/Base' }, defaults))[0]!.path).toBe('time_zone')
    expect(fieldOf(() => parseSchedule({ weekdays: [1], starts_scheduling_at: 'ontem' }, defaults))[0]!.path).toBe('starts_scheduling_at')
  })

  it('período no fuso e capacidade de warm-up', () => {
    expect(quotaPeriod(new Date('2026-11-01T02:00:00Z'), 'America/Sao_Paulo')).toBe('2026-10')
    expect(quotaPeriod(new Date('2026-11-01T02:00:00Z'), 'UTC')).toBe('2026-11')
    const now = new Date('2026-10-16T12:00:00Z')
    expect(warmupCapacity(null, now)).toBe(20)
    expect(warmupCapacity(now.toISOString(), now)).toBe(20)
    expect(warmupCapacity(new Date(now.getTime() - 2 * 86_400_000), now)).toBe(65)
    expect(warmupCapacity(new Date(now.getTime() - 7 * 86_400_000), now)).toBeNull()
  })
})
