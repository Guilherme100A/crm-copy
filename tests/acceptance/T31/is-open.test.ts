// AC-T31-02 — isOpen(config, now, timeZone): vários intervalos no dia, fuso da empresa e intervalo [início, fim).
import { beforeAll, describe, expect, it } from 'vitest'

let isOpen: (config: unknown, now: Date, tz: string) => boolean

beforeAll(async () => {
  const core: any = await import('@crm/core')
  expect(typeof core.isOpen, '@crm/core deve exportar isOpen').toBe('function')
  isOpen = core.isOpen
})

const SP = 'America/Sao_Paulo' // UTC-3
const MAO = 'America/Manaus' // UTC-4
// 2026-10-14 é quarta-feira (day_of_week 3)
const WED = 3
const config = (hours: Array<[number, string, string, boolean?]>, active = true) => ({
  active,
  business_hours: hours.map(([day_of_week, start_time, end_time, a = true]) => ({ day_of_week, start_time, end_time, active: a })),
})
const at = (utc: string) => new Date(`2026-10-14T${utc}:00Z`)
const atSec = (iso: string) => new Date(iso)

const TWO_SHIFTS = config([
  [WED, '08:00', '12:00'],
  [WED, '13:00', '18:00'],
])

describe('T31 — isOpen', () => {
  it.each([
    // [UTC, aberto em SP, aberto em Manaus]
    ['11:30', true, false], // SP 08:30 | MAO 07:30
    ['12:00', true, true], // SP 09:00 | MAO 08:00 (início incluído)
    ['14:59', true, true], // SP 11:59 | MAO 10:59
    ['15:00', false, true], // SP 12:00 (fim excluído) | MAO 11:00
    ['15:59', false, true], // SP 12:59 | MAO 11:59
    ['16:00', true, false], // SP 13:00 | MAO 12:00 (fim excluído)
    ['16:59', true, false], // SP 13:59 | MAO 12:59
    ['17:00', true, true], // SP 14:00 | MAO 13:00
    ['20:59', true, true], // SP 17:59 | MAO 16:59
    ['21:00', false, true], // SP 18:00 (fim excluído) | MAO 17:00
    ['22:00', false, false], // SP 19:00 | MAO 18:00 (fim excluído)
  ])('AC-T31-02 vários intervalos no dia, no fuso da empresa: %s UTC → SP %s, Manaus %s', (utc, sp, mao) => {
    expect(isOpen(TWO_SHIFTS, at(utc), SP), `SP ${utc}Z`).toBe(sp)
    expect(isOpen(TWO_SHIFTS, at(utc), MAO), `Manaus ${utc}Z`).toBe(mao)
  })

  it('AC-T31-02 minuto final é fechado: 11:59:59 aberto, 12:00:00 fechado (SP)', () => {
    expect(isOpen(TWO_SHIFTS, atSec('2026-10-14T14:59:59Z'), SP)).toBe(true)
    expect(isOpen(TWO_SHIFTS, atSec('2026-10-14T15:00:00Z'), SP)).toBe(false)
  })

  it('AC-T31-02 o dia da semana é o do fuso da empresa (UTC já é quinta, local ainda é quarta)', () => {
    const late = config([[WED, '22:00', '24:00']])
    const utcThursday = atSec('2026-10-15T02:30:00Z') // SP qua 23:30 | MAO qua 22:30
    expect(isOpen(late, utcThursday, SP)).toBe(true)
    expect(isOpen(late, utcThursday, MAO)).toBe(true)
    const thursdayOnly = config([[4, '00:00', '03:00']])
    expect(isOpen(thursdayOnly, utcThursday, SP)).toBe(false)
  })

  it('AC-T31-02 dia sem intervalo → fechado; intervalo inativo é ignorado', () => {
    expect(isOpen(TWO_SHIFTS, atSec('2026-10-15T15:00:00Z'), SP)).toBe(false) // quinta
    const withInactive = config([
      [WED, '08:00', '12:00', false],
      [WED, '13:00', '18:00'],
    ])
    expect(isOpen(withInactive, at('12:00'), SP)).toBe(false) // SP 09:00, intervalo inativo
    expect(isOpen(withInactive, at('17:00'), SP)).toBe(true) // SP 14:00
  })

  it('AC-T31-02 config inativa → sempre aberto', () => {
    const off = config([[WED, '08:00', '09:00']], false)
    expect(isOpen(off, at('22:00'), SP)).toBe(true)
    expect(isOpen(off, atSec('2026-10-18T05:00:00Z'), MAO)).toBe(true)
  })
})
