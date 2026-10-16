import { describe, expect, it } from 'vitest'
import { nextOccurrence, nextOccurrenceAfter, runAtProblem, scheduleJobId, SCHEDULE_MAX_MS } from './rules'

const SP = 'America/Sao_Paulo'

describe('janela de 31 dias (AC-T64-01)', () => {
  const now = new Date('2026-10-16T12:00:00Z')
  it('passado e agora → past; até 31 dias inclusive vale; além → too_far', () => {
    expect(runAtProblem(new Date('2026-10-16T11:59:59Z'), now)).toBe('past')
    expect(runAtProblem(now, now)).toBe('past')
    expect(runAtProblem(new Date(now.getTime() + 60_000), now)).toBeNull()
    expect(runAtProblem(new Date(now.getTime() + SCHEDULE_MAX_MS), now)).toBeNull()
    expect(runAtProblem(new Date(now.getTime() + SCHEDULE_MAX_MS + 1), now)).toBe('too_far')
  })
})

describe('próxima ocorrência no fuso da empresa (AC-T64-03)', () => {
  it('diária, semanal e mensal mantêm a hora local', () => {
    const at = new Date('2026-10-16T12:30:00Z') // 09:30 em São Paulo
    expect(nextOccurrence(at, 'daily', SP)!.toISOString()).toBe('2026-10-17T12:30:00.000Z')
    expect(nextOccurrence(at, 'weekly', SP)!.toISOString()).toBe('2026-10-23T12:30:00.000Z')
    expect(nextOccurrence(at, 'monthly', SP)!.toISOString()).toBe('2026-11-16T12:30:00.000Z')
    expect(nextOccurrence(at, 'one_off', SP)).toBeNull()
  })

  it('mensal limita ao fim do mês e vira o ano', () => {
    expect(nextOccurrence(new Date('2026-01-31T15:00:00Z'), 'monthly', SP)!.toISOString()).toBe('2026-02-28T15:00:00.000Z')
    expect(nextOccurrence(new Date('2026-12-15T15:00:00Z'), 'monthly', SP)!.toISOString()).toBe('2027-01-15T15:00:00.000Z')
  })

  it('a hora local se mantém na troca de horário de verão (Nova York)', () => {
    // 2026-11-01: fim do horário de verão nos EUA. 09:00 local = 13:00Z antes e 14:00Z depois.
    expect(nextOccurrence(new Date('2026-10-31T13:00:00Z'), 'daily', 'America/New_York')!.toISOString()).toBe('2026-11-01T14:00:00.000Z')
  })

  it('pula ocorrências que o atraso já passou; segundos preservados', () => {
    const at = new Date('2026-10-10T12:00:05Z')
    expect(nextOccurrenceAfter(at, 'daily', SP, new Date('2026-10-16T13:00:00Z'))!.toISOString()).toBe('2026-10-17T12:00:05.000Z')
  })

  it('jobId determinístico sem ":"', () => {
    expect(scheduleJobId({ scheduleId: 'abc', runAt: '2026-10-16T12:00:00.000Z' })).toBe(`schedule-abc-${Date.parse('2026-10-16T12:00:00Z')}`)
  })
})
