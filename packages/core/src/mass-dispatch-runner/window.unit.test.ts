import { describe, expect, it } from 'vitest'
import { intervalMs } from './runner'
import { isWithinWindow, nextAllowedTime, nextDayWindowStart, zonedDayStart, zonedTime } from './window'

const sp = { weekdays: [1, 2, 3, 4, 5], windowStart: '08:00', windowEnd: '18:00', timeZone: 'America/Sao_Paulo' }

describe('janela de envio', () => {
  it('dentro/fora da janela e dos dias', () => {
    expect(isWithinWindow(new Date('2026-10-19T13:00:00Z'), sp)).toBe(true) // seg 10:00
    expect(isWithinWindow(new Date('2026-10-19T21:00:00Z'), sp)).toBe(false) // seg 18:00 (fim exclusivo)
    expect(isWithinWindow(new Date('2026-10-18T13:00:00Z'), sp)).toBe(false) // domingo
  })

  it('próximo horário permitido e retomada no próximo dia', () => {
    expect(nextAllowedTime(new Date('2026-10-19T13:00:00Z'), sp).toISOString()).toBe('2026-10-19T13:00:00.000Z')
    expect(nextAllowedTime(new Date('2026-10-19T10:00:00Z'), sp).toISOString()).toBe('2026-10-19T11:00:00.000Z') // 07:00 → 08:00
    expect(nextAllowedTime(new Date('2026-10-23T22:00:00Z'), sp).toISOString()).toBe('2026-10-26T11:00:00.000Z') // sex 19:00 → seg
    expect(nextDayWindowStart(new Date('2026-10-23T13:00:00Z'), sp).toISOString()).toBe('2026-10-26T11:00:00.000Z')
    expect(nextAllowedTime(new Date('2026-10-19T13:00:00Z'), { ...sp, timeZone: 'Asia/Tokyo' }).toISOString()).toBe('2026-10-19T23:00:00.000Z')
  })

  it('início do dia local e hora local com horário de verão', () => {
    expect(zonedDayStart(new Date('2026-10-19T02:00:00Z'), 'America/Sao_Paulo').toISOString()).toBe('2026-10-18T03:00:00.000Z')
    expect(zonedTime(2026, 7, 1, 8, 0, 'Europe/Lisbon').toISOString()).toBe('2026-07-01T07:00:00.000Z')
    expect(zonedTime(2026, 1, 1, 8, 0, 'Europe/Lisbon').toISOString()).toBe('2026-01-01T08:00:00.000Z')
  })

  it('intervalo aleatório entre mín e máx', () => {
    expect(intervalMs(10, 20, () => 0)).toBe(10_000)
    expect(intervalMs(10, 20, () => 0.5)).toBe(15_000)
    expect(intervalMs(10, 20, () => 0.999)).toBe(19_990)
    expect(intervalMs(5, 5, () => 0.7)).toBe(5_000)
  })
})
