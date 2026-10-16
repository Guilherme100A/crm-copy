import { describe, expect, it } from 'vitest'
import { evaluateCondition, evaluateRules, nextSmartInterval, parseLocalDateTime, parseNumber, pickDistributorOutput, type ConditionFacts } from './rules'

const TZ = 'America/Sao_Paulo'
// Segunda-feira, 19/10/2026 10:30 em São Paulo.
const NOW = new Date('2026-10-19T13:30:00Z')

const facts = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  now: NOW,
  timeZone: TZ,
  labels: { ids: new Set(['l1']), names: new Set(['vip']) },
  chat: { status: 'attending', assignedUserId: 'u1' },
  contact: { name: 'Maria Silva', phone: '+5511999990000', email: 'maria@x.com', customFields: { plano: 'Ouro', idade: '30' } },
  globals: { g_limite: '10,5' },
  replyType: 'audio',
  render: (s) => s.replace('{x}', '42'),
  ...over,
})

describe('números', () => {
  it('vírgula, ponto e milhar', () => {
    expect(parseNumber('1,5')).toBe(1.5)
    expect(parseNumber('1.234,56')).toBe(1234.56)
    expect(parseNumber('10.5')).toBe(10.5)
    expect(parseNumber(' 7 ')).toBe(7)
    expect(parseNumber('abc')).toBeNull()
    expect(parseNumber('')).toBeNull()
  })
})

describe('condição', () => {
  const ok = (rule: Record<string, unknown>, f = facts()) => evaluateCondition(rule as never, f)

  it('sistema: etiqueta, dia, hora, data e janela', () => {
    expect(ok({ category: 'system', systemSubtype: 'tag', tagName: 'VIP' })).toBe(true)
    expect(ok({ category: 'system', systemSubtype: 'tag', tagId: 'l2' })).toBe(false)
    expect(ok({ category: 'system', systemSubtype: 'tag', tagId: 'l2', operator: 'different' })).toBe(true)
    expect(ok({ category: 'system', systemSubtype: 'weekday', weekday: 'monday' })).toBe(true)
    expect(ok({ category: 'system', systemSubtype: 'weekday', weekday: 'sunday', operator: 'different' })).toBe(true)
    expect(ok({ category: 'system', systemSubtype: 'time', time: 10, operator: 'during' })).toBe(true)
    expect(ok({ category: 'system', systemSubtype: 'time', time: 10, timeMinute: 31, operator: 'before' })).toBe(true)
    expect(ok({ category: 'system', systemSubtype: 'time', time: 10, timeMinute: 30, operator: 'after' })).toBe(false)
    expect(ok({ category: 'system', systemSubtype: 'date', date: '2026-10-19', operator: 'during' })).toBe(true)
    expect(ok({ category: 'system', systemSubtype: 'date', date: '2026-10-20', operator: 'before' })).toBe(true)
    expect(ok({ category: 'system', systemSubtype: 'date', date: '2026-10-18', operator: 'after' })).toBe(true)
    expect(ok({ category: 'system', systemSubtype: 'message_window', operator: 'closed' })).toBe(true)
  })

  it('fuso: 23:30 em SP já é terça em UTC, mas a regra vê segunda', () => {
    const late = facts({ now: new Date('2026-10-20T02:30:00Z') })
    expect(ok({ category: 'system', systemSubtype: 'weekday', weekday: 'monday' }, late)).toBe(true)
    expect(ok({ category: 'system', systemSubtype: 'time', time: 23, operator: 'during' }, late)).toBe(true)
  })

  it('atendimento, atendente, campos, campo personalizado e global', () => {
    expect(ok({ category: 'attendance', attendanceStatus: 'in_progress' })).toBe(true)
    expect(ok({ category: 'attendance', attendanceStatus: 'waiting' })).toBe(false)
    expect(ok({ category: 'attendance', attendanceStatus: 'waiting' }, facts({ chat: null }))).toBe(false)
    expect(ok({ category: 'attendant', user_ids: ['u2', 'u1'] })).toBe(true)
    expect(ok({ category: 'field', fieldName: 'name', operator: 'starts_with', value: 'maria' })).toBe(true)
    expect(ok({ category: 'field', fieldName: 'email', operator: 'not_contains', value: 'gmail' })).toBe(true)
    expect(ok({ category: 'field', fieldName: 'phone', operator: 'has_value' })).toBe(true)
    expect(ok({ category: 'field', fieldName: 'name', operator: 'type', value: 'audio' })).toBe(true)
    expect(ok({ category: 'custom_field', fieldName: 'plano', operator: 'equal', value: 'ouro' })).toBe(true)
    expect(ok({ category: 'custom_field', fieldName: 'idade', operator: 'greater_or_equal', value: '29,5' })).toBe(true)
    expect(ok({ category: 'custom_field', fieldName: 'idade', operator: 'less_than', value: '{x}' })).toBe(true)
    expect(ok({ category: 'global_variable', fieldName: 'limite', operator: 'numeric_equal', value: '10.5' })).toBe(true)
    expect(ok({ category: 'global_variable', fieldName: 'g_limite', operator: 'greater_than', value: 'abc' })).toBe(false)
  })

  it('all / any', () => {
    const yes = { category: 'attendant', user_ids: ['u1'] }
    const no = { category: 'attendant', user_ids: ['u9'] }
    expect(evaluateRules('all', [yes, no] as never, facts())).toBe(false)
    expect(evaluateRules('any', [yes, no] as never, facts())).toBe(true)
    expect(evaluateRules('all', [], facts())).toBe(false)
  })
})

describe('intervalo inteligente', () => {
  it('por tempo', () => {
    expect(nextSmartInterval({ schedule_type: 'time', interval_value: 90, interval_unit: 'minutes' }, NOW, TZ)).toEqual({ at: new Date('2026-10-19T15:00:00Z'), delayMs: 5_400_000 })
    expect(nextSmartInterval({ schedule_type: 'time', interval_value: 2, interval_unit: 'days' }, NOW, TZ).delayMs).toBe(172_800_000)
  })

  it('por data local; passada segue agora', () => {
    expect(nextSmartInterval({ schedule_type: 'date', scheduled_date: '2026-10-20T09:00' }, NOW, TZ).at?.toISOString()).toBe('2026-10-20T12:00:00.000Z')
    expect(nextSmartInterval({ schedule_type: 'date', scheduled_date: '2026-10-01T09:00' }, NOW, TZ)).toEqual({ at: null, delayMs: 0 })
    expect(parseLocalDateTime('2026-10-20T09:00:00Z', TZ)?.toISOString()).toBe('2026-10-20T09:00:00.000Z')
  })

  it('semanal: dentro da faixa segue; fora vai ao próximo início, inclusive virando dia e semana', () => {
    const weekdays = { monday: { enabled: true, start_time: '09:00', end_time: '18:00' }, friday: { enabled: true, start_time: '14:00', end_time: '15:00' } }
    expect(nextSmartInterval({ schedule_type: 'weekly', weekly_schedule: weekdays }, NOW, TZ)).toEqual({ at: null, delayMs: 0 })
    // segunda 19:00 → sexta 14:00
    expect(nextSmartInterval({ schedule_type: 'weekly', weekly_schedule: weekdays }, new Date('2026-10-19T22:00:00Z'), TZ).at?.toISOString()).toBe('2026-10-23T17:00:00.000Z')
    // sexta 16:00 → segunda seguinte 09:00 (virada de semana)
    expect(nextSmartInterval({ schedule_type: 'weekly', weekly_schedule: weekdays }, new Date('2026-10-23T19:00:00Z'), TZ).at?.toISOString()).toBe('2026-10-26T12:00:00.000Z')
    // segunda 08:00 → mesmo dia 09:00
    expect(nextSmartInterval({ schedule_type: 'weekly', weekly_schedule: weekdays }, new Date('2026-10-19T11:00:00Z'), TZ).at?.toISOString()).toBe('2026-10-19T12:00:00.000Z')
    // virada de dia no fuso: domingo 23:30 local (segunda 02:30 UTC) → segunda 09:00 local
    expect(nextSmartInterval({ schedule_type: 'weekly', weekly_schedule: weekdays }, new Date('2026-10-19T02:30:00Z'), TZ).at?.toISOString()).toBe('2026-10-19T12:00:00.000Z')
  })
})

describe('distribuidor', () => {
  it('proporcional às quantidades, sempre o próximo e quantidade 0', () => {
    const outs = [{ id: 'a', quantity: 2 }, { id: 'b', quantity: 1 }]
    const counts: Record<string, number> = {}
    const seq: string[] = []
    for (let i = 0; i < 6; i++) {
      const id = pickDistributorOutput(outs, counts)!
      counts[id] = (counts[id] ?? 0) + 1
      seq.push(id)
    }
    expect(seq).toEqual(['a', 'a', 'b', 'a', 'a', 'b'])
    expect(pickDistributorOutput([{ id: 'a', quantity: 0 }, { id: 'b', quantity: 3 }], { b: 10 })).toBe('b')
    expect(pickDistributorOutput([{ id: 'a', quantity: 0 }, { id: 'b', quantity: 0 }], { a: 1 })).toBe('b')
    expect(pickDistributorOutput(outs, {}, { alwaysNext: true, lastId: 'b' })).toBe('a')
    expect(pickDistributorOutput(outs, {}, { alwaysNext: true, lastId: null })).toBe('a')
  })
})
