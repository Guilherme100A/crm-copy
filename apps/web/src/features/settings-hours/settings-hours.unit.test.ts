import { describe, expect, it } from 'vitest'
import {
  addInterval,
  hoursErrors,
  hoursPayload,
  intervalErrors,
  MAX_INTERVALS,
  newInterval,
  parseTime,
  setDayActive,
  sortByDay,
  type HoursForm,
} from './validation'

const base: HoursForm = { active: false, action_type: 'message', message_text: '', flow_id: '', business_hours: [] }

describe('horários: validação igual à do servidor (AC-T53-04)', () => {
  it('parseTime aceita HH:MM e 24:00', () => {
    expect(parseTime('00:00')).toBe(0)
    expect(parseTime('09:30')).toBe(570)
    expect(parseTime('24:00')).toBe(1440)
    expect(parseTime('24:01')).toBeNull()
    expect(parseTime('9:00')).toBeNull()
    expect(parseTime('25:00')).toBeNull()
  })

  it('intervalErrors: dia 0–6, início ≠ 24:00, fim > início', () => {
    expect(intervalErrors(newInterval(1))).toEqual({})
    expect(intervalErrors({ day_of_week: 7, start_time: '09:00', end_time: '18:00' })).toEqual({ day_of_week: 'day' })
    expect(intervalErrors({ day_of_week: 1, start_time: '24:00', end_time: '24:00' })).toEqual({
      start_time: 'time',
      end_time: 'endBeforeStart',
    })
    expect(intervalErrors({ day_of_week: 1, start_time: '18:00', end_time: '09:00' })).toEqual({
      end_time: 'endBeforeStart',
    })
    expect(intervalErrors({ day_of_week: 1, start_time: '09:00', end_time: '09:00' })).toEqual({
      end_time: 'endBeforeStart',
    })
    expect(intervalErrors({ day_of_week: 1, start_time: 'xx', end_time: '24:00' })).toEqual({ start_time: 'time' })
    expect(intervalErrors({ day_of_week: 1, start_time: '09:00', end_time: '' })).toEqual({ end_time: 'time' })
  })

  it('erros com os paths do 422: mensagem/fluxo obrigatórios só com o sistema ativo', () => {
    expect(hoursErrors(base)).toEqual({})
    expect(hoursErrors({ ...base, active: true })).toEqual({ message_text: 'messageRequired' })
    expect(hoursErrors({ ...base, active: true, action_type: 'flow' })).toEqual({ flow_id: 'flowRequired' })
    expect(hoursErrors({ ...base, active: true, message_text: 'Volto já' })).toEqual({})
    const bad = { ...base, business_hours: [newInterval(1), { ...newInterval(2), end_time: '08:00' }] }
    expect(hoursErrors(bad)).toEqual({ 'business_hours.1.end_time': 'endBeforeStart' })
  })
})

describe('horários: grade semanal (AC-T53-04)', () => {
  it('novo intervalo padrão 09:00–18:00, agrupado no dia, até 70', () => {
    expect(newInterval(3)).toEqual({ day_of_week: 3, start_time: '09:00', end_time: '18:00', active: true })
    let list = addInterval([], 3)
    list = addInterval(list, 1)
    list = addInterval(list, 3)
    list = addInterval(list, 5)
    expect(list.map((h) => h.day_of_week)).toEqual([1, 3, 3, 5])
    const full = Array.from({ length: MAX_INTERVALS }, () => newInterval(0))
    expect(addInterval(full, 1)).toHaveLength(MAX_INTERVALS)
  })

  it('toggle do dia liga/desliga só os intervalos daquele dia; ordem do servidor por dia', () => {
    const list = [newInterval(1), newInterval(2), newInterval(1)]
    expect(setDayActive(list, 1, false).map((h) => h.active)).toEqual([false, true, false])
    expect(
      sortByDay([newInterval(5), { ...newInterval(1), start_time: '13:00' }, newInterval(1)]).map(
        (h) => `${h.day_of_week} ${h.start_time}`,
      ),
    ).toEqual(['1 13:00', '1 09:00', '5 09:00'])
  })

  it('payload do PUT: texto vazio e fluxo vazio viram null', () => {
    expect(hoursPayload({ ...base, business_hours: [newInterval(1)] })).toEqual({
      active: false,
      action_type: 'message',
      message_text: null,
      flow_id: null,
      business_hours: [{ day_of_week: 1, start_time: '09:00', end_time: '18:00', active: true }],
    })
  })
})
