import { describe, expect, it } from 'vitest'
import { chatScopeFor, normalizeHexColor, scopeAllows } from '../departments'
import { intervalErrors, isOpen, localDayMinute, parseTime } from './is-open'

// 2026-10-14 é quarta-feira (day_of_week 3). Manaus = UTC−4, São Paulo = UTC−3 (sem horário de verão).
const at = (utc: string) => new Date(utc)
const weekday = {
  active: true,
  business_hours: [
    { day_of_week: 3, start_time: '08:00', end_time: '12:00', active: true },
    { day_of_week: 3, start_time: '14:00', end_time: '18:00', active: true },
    { day_of_week: 3, start_time: '19:00', end_time: '20:00', active: false },
  ],
}

describe('AC-T31-02 isOpen', () => {
  it('vários intervalos no dia, no fuso de São Paulo', () => {
    expect(isOpen(weekday, at('2026-10-14T11:00:00Z'), 'America/Sao_Paulo')).toBe(true) // 08:00
    expect(isOpen(weekday, at('2026-10-14T14:59:00Z'), 'America/Sao_Paulo')).toBe(true) // 11:59
    expect(isOpen(weekday, at('2026-10-14T15:00:00Z'), 'America/Sao_Paulo')).toBe(false) // 12:00 = fim fechado
    expect(isOpen(weekday, at('2026-10-14T16:30:00Z'), 'America/Sao_Paulo')).toBe(false) // 13:30 almoço
    expect(isOpen(weekday, at('2026-10-14T17:00:00Z'), 'America/Sao_Paulo')).toBe(true) // 14:00
    expect(isOpen(weekday, at('2026-10-14T20:59:00Z'), 'America/Sao_Paulo')).toBe(true) // 17:59
    expect(isOpen(weekday, at('2026-10-14T21:00:00Z'), 'America/Sao_Paulo')).toBe(false) // 18:00
    expect(isOpen(weekday, at('2026-10-14T22:30:00Z'), 'America/Sao_Paulo')).toBe(false) // 19:30 intervalo inativo
  })

  it('o mesmo instante em Manaus é uma hora antes', () => {
    // 15:00Z = 12:00 em SP (fechado) e 11:00 em Manaus (aberto)
    expect(isOpen(weekday, at('2026-10-14T15:00:00Z'), 'America/Sao_Paulo')).toBe(false)
    expect(isOpen(weekday, at('2026-10-14T15:00:00Z'), 'America/Manaus')).toBe(true)
    // 16:00Z = 12:00 em Manaus → fechado
    expect(isOpen(weekday, at('2026-10-14T16:00:00Z'), 'America/Manaus')).toBe(false)
    expect(isOpen(weekday, at('2026-10-14T11:59:00Z'), 'America/Manaus')).toBe(false) // 07:59
    expect(isOpen(weekday, at('2026-10-14T12:00:00Z'), 'America/Manaus')).toBe(true) // 08:00
  })

  it('o dia da semana vem do fuso (virada de dia)', () => {
    // 2026-10-15 02:00Z = quarta 23:00 em SP; quinta 02:00 em UTC
    expect(localDayMinute(at('2026-10-15T02:00:00Z'), 'America/Sao_Paulo')).toEqual({ day: 3, minute: 23 * 60 })
    const late = { active: true, business_hours: [{ day_of_week: 3, start_time: '22:00', end_time: '24:00' }] }
    expect(isOpen(late, at('2026-10-15T02:59:00Z'), 'America/Sao_Paulo')).toBe(true) // 23:59 qua
    expect(isOpen(late, at('2026-10-15T03:00:00Z'), 'America/Sao_Paulo')).toBe(false) // 00:00 qui
  })

  it('config inativa = sempre aberto; sem intervalos no dia = fechado', () => {
    expect(isOpen({ ...weekday, active: false }, at('2026-10-14T05:00:00Z'), 'America/Sao_Paulo')).toBe(true)
    expect(isOpen(weekday, at('2026-10-15T15:00:00Z'), 'America/Sao_Paulo')).toBe(false) // quinta
  })
})

describe('intervalos', () => {
  it('parseTime e erros', () => {
    expect(parseTime('00:00')).toBe(0)
    expect(parseTime('24:00')).toBe(1440)
    expect(parseTime('25:00')).toBeNull()
    expect(parseTime('9:00')).toBeNull()
    expect(intervalErrors({ day_of_week: 1, start_time: '09:00', end_time: '18:00' })).toEqual({})
    expect(intervalErrors({ day_of_week: 7, start_time: '09:00', end_time: '18:00' })).toHaveProperty('day_of_week')
    expect(intervalErrors({ day_of_week: 1, start_time: '18:00', end_time: '09:00' })).toHaveProperty('end_time')
    expect(intervalErrors({ day_of_week: 1, start_time: '24:00', end_time: '24:00' })).toHaveProperty('start_time')
  })
})

describe('AC-T31-04 chatScopeFor', () => {
  it('membro com seleção vê só ela; sem seleção vê todos; owner/admin sempre todos', () => {
    expect(chatScopeFor({ role: 'member', department_ids: ['d1', 'd1'], connection_ids: ['c1'] })).toEqual({ departments: ['d1'], connections: ['c1'] })
    expect(chatScopeFor({ role: 'member', department_ids: ['d1'] })).toEqual({ departments: ['d1'], connections: 'all' })
    expect(chatScopeFor({ role: 'member' })).toEqual({ departments: 'all', connections: 'all' })
    expect(chatScopeFor({ role: 'admin', department_ids: ['d1'] })).toEqual({ departments: 'all', connections: 'all' })
    expect(chatScopeFor({ role: 'owner', connectionIds: ['c1'] })).toEqual({ departments: 'all', connections: 'all' })
  })

  it('scopeAllows', () => {
    const s = chatScopeFor({ role: 'member', department_ids: ['d1'], connection_ids: ['c1'] })
    expect(scopeAllows(s, { department_id: 'd1', connection_id: 'c1' })).toBe(true)
    expect(scopeAllows(s, { department_id: 'd2' })).toBe(false)
    expect(scopeAllows(s, { connection_id: 'c2' })).toBe(false)
    expect(scopeAllows(s, { department_id: null })).toBe(true)
  })
})

describe('cor', () => {
  it('normaliza hex', () => {
    expect(normalizeHexColor('#3b82f6')).toBe('#3B82F6')
    expect(normalizeHexColor('#abc')).toBe('#AABBCC')
    for (const bad of ['azul', '#12345', '#GGGGGG', '3B82F6']) expect(normalizeHexColor(bad)).toBeNull()
  })
})
