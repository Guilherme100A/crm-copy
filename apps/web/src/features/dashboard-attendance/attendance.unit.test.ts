import { describe, expect, it } from 'vitest'
import { dashboardTab } from '@/features/dashboard/tabs'
import { HttpError } from '@/lib/http'
import type { AttendanceBlock, AttendanceUser } from './api'
import {
  ATTENDANCE_MAX_DAYS,
  MAX_SLICES,
  attendanceParams,
  bucketLabel,
  formatDuration,
  formatKpi,
  groupSlices,
  heatGrid,
  heatLevel,
  isRangeError,
  nextSort,
  peakCells,
  sortUsers,
  tooLong,
  trendOf,
  type Slice,
} from './logic'
import './register'

describe('tempos formatados s/min/h (AC-T87-02)', () => {
  it('segundos, minutos (com e sem segundos) e horas (com e sem minutos)', () => {
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(59.6)).toBe('1 min')
    expect(formatDuration(60)).toBe('1 min')
    expect(formatDuration(330)).toBe('5 min 30 s')
    expect(formatDuration(3599)).toBe('59 min 59 s')
    expect(formatDuration(3600)).toBe('1 h')
    expect(formatDuration(8100)).toBe('2 h 15 min')
    expect(formatDuration(90061)).toBe('25 h 1 min')
  })

  it('sem valor vira traço', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
  })

  it('KPI de tempo usa a duração; os demais, inteiro', () => {
    expect(formatKpi('response_time_seconds', 4500)).toBe('1 h 15 min')
    expect(formatKpi('new_leads', 1234)).toBe('1.234')
    expect(formatKpi('unanswered_chats', 0)).toBe('0')
  })
})

describe('tendência dos KPIs (AC-T87-02)', () => {
  const block = {
    inverted_kpis: ['unanswered_chats', 'response_time_seconds'],
    trends: {
      new_leads: { direction: 'up', delta_pct: 25 },
      unanswered_chats: { direction: 'up', delta_pct: 10 },
      response_time_seconds: { direction: 'down', delta_pct: -12.34 },
      resolved_leads: { direction: 'neutral', delta_pct: null },
    },
  } as unknown as Pick<AttendanceBlock, 'trends' | 'inverted_kpis'>

  it('subir é bom, exceto em "sem resposta" e tempo de resposta', () => {
    expect(trendOf(block, 'new_leads')).toEqual({ direction: 'up', good: true, label: '+25,0%' })
    expect(trendOf(block, 'unanswered_chats')).toMatchObject({ direction: 'up', good: false })
    expect(trendOf(block, 'response_time_seconds')).toEqual({ direction: 'down', good: true, label: '−12,3%' })
  })

  it('neutro ou ausente fica sem cor', () => {
    expect(trendOf(block, 'resolved_leads')).toEqual({ direction: 'neutral', good: null, label: '—' })
    expect(trendOf(block, 'attended_leads').good).toBeNull()
  })
})

describe('mapa de calor e pico (AC-T87-02)', () => {
  it('grade 7×24 com zero onde não veio célula; fora da faixa é ignorado', () => {
    const g = heatGrid([
      { weekday: 1, hour: 9, count: 5 },
      { weekday: 6, hour: 23, count: 2 },
      { weekday: 7, hour: 1, count: 9 },
      { weekday: 0, hour: 24, count: 9 },
    ])
    expect(g).toHaveLength(7)
    expect(g.every((r) => r.length === 24)).toBe(true)
    expect(g[1]![9]).toBe(5)
    expect(g[6]![23]).toBe(2)
    expect(g.flat().reduce((a, b) => a + b, 0)).toBe(7)
  })

  it('usa os picos da API (empates) e, sem eles, o maior valor', () => {
    const cells = [
      { weekday: 1, hour: 9, count: 5 },
      { weekday: 2, hour: 10, count: 5 },
      { weekday: 3, hour: 11, count: 1 },
    ]
    expect(peakCells({ peak: cells[0]!, peaks: [cells[0]!, cells[1]!], attendance_by_weekday_hour: cells })).toHaveLength(2)
    expect(peakCells({ peak: cells[0]!, peaks: [], attendance_by_weekday_hour: cells })).toEqual([cells[0]])
    expect(peakCells({ peak: null, peaks: [], attendance_by_weekday_hour: cells })).toEqual([cells[0], cells[1]])
    expect(peakCells({ peak: null, peaks: [], attendance_by_weekday_hour: [{ weekday: 0, hour: 0, count: 0 }] })).toEqual([])
  })

  it('nível da célula de 0 (vazio) a 4 (pico)', () => {
    expect(heatLevel(0, 10)).toBe(0)
    expect(heatLevel(1, 10)).toBe(1)
    expect(heatLevel(5, 10)).toBe(2)
    expect(heatLevel(10, 10)).toBe(4)
    expect(heatLevel(3, 0)).toBe(0)
  })
})

const user = (name: string, answered: number, attending: number, resolved: number, time: number | null, id: string | null = name): AttendanceUser => ({
  user_id: id,
  user_name: name,
  answered_chats: answered,
  attending_chats: attending,
  resolved_chats: resolved,
  average_response_seconds: time,
})

describe('tabela por atendente ordenável (AC-T87-02)', () => {
  const rows = [user('Bruna', 5, 1, 3, 120), user('ana', 9, 0, 2, null), user('Carlos', 2, 4, 7, 30), user('Usuário removido', 1, 0, 0, 600, null)]
  const names = (r: AttendanceUser[]) => r.map((u) => u.user_name)

  it('ordena por nome (sem diferenciar maiúsculas), atendidos, em atendimento e resolvidos', () => {
    expect(names(sortUsers(rows, 'name', 'asc'))).toEqual(['ana', 'Bruna', 'Carlos', 'Usuário removido'])
    expect(names(sortUsers(rows, 'name', 'desc'))).toEqual(['Usuário removido', 'Carlos', 'Bruna', 'ana'])
    expect(names(sortUsers(rows, 'answered', 'desc'))).toEqual(['ana', 'Bruna', 'Carlos', 'Usuário removido'])
    expect(names(sortUsers(rows, 'attending', 'desc'))[0]).toBe('Carlos')
    expect(names(sortUsers(rows, 'resolved', 'asc'))).toEqual(['Usuário removido', 'ana', 'Bruna', 'Carlos'])
  })

  it('tempo: nulos sempre no fim, nos dois sentidos', () => {
    expect(names(sortUsers(rows, 'time', 'asc'))).toEqual(['Carlos', 'Bruna', 'Usuário removido', 'ana'])
    expect(names(sortUsers(rows, 'time', 'desc'))).toEqual(['Usuário removido', 'Bruna', 'Carlos', 'ana'])
  })

  it('não altera a lista original', () => {
    const copy = [...rows]
    sortUsers(rows, 'name', 'desc')
    expect(rows).toEqual(copy)
  })

  it('clique: mesma coluna inverte; coluna nova começa no sentido natural', () => {
    expect(nextSort({ key: 'answered', dir: 'desc' }, 'answered')).toEqual({ key: 'answered', dir: 'asc' })
    expect(nextSort({ key: 'answered', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' })
    expect(nextSort({ key: 'name', dir: 'asc' }, 'resolved')).toEqual({ key: 'resolved', dir: 'desc' })
    expect(nextSort({ key: 'name', dir: 'asc' }, 'time')).toEqual({ key: 'time', dir: 'asc' })
  })
})

describe('"Outros" acima do limite de fatias (AC-T87-03)', () => {
  const dep = (key: string, value: number): Slice => ({ key, label: key.toUpperCase(), value, color: '#123456' })

  it('até o limite, mantém todas as fatias (ordenadas, sem zeros)', () => {
    const rows = [dep('a', 1), dep('b', 5), dep('c', 0), dep('d', 3), dep('e', 2), dep('f', 4), dep('g', 6)]
    const out = groupSlices(rows, 'Outros')
    expect(out).toHaveLength(MAX_SLICES)
    expect(out.map((s) => s.key)).toEqual(['g', 'b', 'f', 'd', 'e', 'a'])
    expect(out.some((s) => s.others)).toBe(false)
  })

  it('acima do limite, mantém limite−1 e soma o resto em "Outros"', () => {
    const rows = [dep('a', 10), dep('b', 9), dep('c', 8), dep('d', 7), dep('e', 6), dep('f', 2), dep('g', 1), dep('h', 1)]
    const out = groupSlices(rows, 'Outros')
    expect(out).toHaveLength(MAX_SLICES)
    expect(out.slice(0, MAX_SLICES - 1).map((s) => s.key)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(out.at(-1)).toEqual({ key: 'others', label: 'Outros', value: 4, color: null, others: true })
    expect(out.reduce((n, s) => n + s.value, 0)).toBe(44)
  })

  it('o limite é configurável e exportado', () => {
    expect(MAX_SLICES).toBe(6)
    const out = groupSlices([dep('a', 3), dep('b', 2), dep('c', 1)], 'Others', 2)
    expect(out.map((s) => [s.key, s.value])).toEqual([
      ['a', 3],
      ['others', 3],
    ])
  })
})

describe('limite de 92 dias (AC-T87-04)', () => {
  it('92 dias passa, 93 mostra o aviso', () => {
    expect(ATTENDANCE_MAX_DAYS).toBe(92)
    expect(tooLong({ start_date: '2026-01-01', end_date: '2026-04-02' })).toBe(false) // 92 dias
    expect(tooLong({ start_date: '2026-01-01', end_date: '2026-04-03' })).toBe(true) // 93 dias
    expect(tooLong({ start_date: '2025-01-01', end_date: '2025-12-31' })).toBe(true)
  })

  it('o 422 do servidor em end_date vira o mesmo aviso; outros erros não', () => {
    const limit = new HttpError(422, 'VALIDATION_ERROR', 'x', { fields: [{ path: 'end_date', message: 'Atendimento limitado a 92 dias' }] })
    expect(isRangeError(limit)).toBe(true)
    expect(isRangeError(new HttpError(422, 'VALIDATION_ERROR', 'x', { fields: [{ path: 'start_date' }] }))).toBe(false)
    expect(isRangeError(new HttpError(500, 'INTERNAL', 'x'))).toBe(false)
    expect(isRangeError(new Error('x'))).toBe(false)
  })
})

describe('consulta e slot', () => {
  it('parâmetros: período e conexões sem repetição', () => {
    expect(attendanceParams({ start_date: '2026-03-01', end_date: '2026-03-07' }, [])).toEqual({ start_date: '2026-03-01', end_date: '2026-03-07' })
    expect(attendanceParams({ start_date: '2026-03-01', end_date: '2026-03-01' }, ['b', 'a', 'b']).connection_ids).toBe('b,a')
  })

  it('rótulos dos baldes por hora e por dia', () => {
    expect(bucketLabel('2026-03-09T13:00', 'hour')).toBe('13:00')
    expect(bucketLabel('2026-03-09', 'day')).toBe('09/03')
  })

  it('o painel de Atendimento ocupa o slot da T78', () => {
    expect(dashboardTab('attendance')?.name).toBe('AttendancePanel')
  })
})
