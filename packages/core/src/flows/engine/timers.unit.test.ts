import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlowTimers, bullTimerScheduler, flowTimerJobId, type TimerScheduler } from './timers'
import { FlowWaitError, MAX_WAIT_MS, parseWait, waitDelay, waitForReply } from './waits'

const T0 = new Date('2026-10-16T12:00:00Z')
const now = () => T0

afterEach(() => vi.useRealTimers())

describe('esperas', () => {
  it('waitForReply/waitDelay montam o wait com prazo e handles', () => {
    expect(waitForReply({ delayMs: 60_000, now })).toEqual({
      kind: 'reply',
      handles: { reply: 'source', timeout: 'timeout' },
      deadline_at: '2026-10-16T12:01:00.000Z',
      delay_ms: 60_000,
    })
    expect(waitForReply({ now })).toMatchObject({ deadline_at: null })
    expect(waitDelay(1000, { handle: 'source', now })).toMatchObject({ kind: 'timer', handles: { timeout: 'source' }, deadline_at: '2026-10-16T12:00:01.000Z' })
  })

  it('prazo acima de 31 dias lança wait_too_long (com o código na mensagem); 31 dias exatos passam', () => {
    expect(() => waitForReply({ delayMs: MAX_WAIT_MS + 1, now })).toThrow(FlowWaitError)
    expect(() => waitDelay(MAX_WAIT_MS + 1)).toThrow(/^wait_too_long/)
    expect(() => waitForReply({ deadlineAt: new Date(T0.getTime() + 40 * 86_400_000), now })).toThrow(/wait_too_long/)
    expect(waitDelay(MAX_WAIT_MS, { now }).deadline_at).toBe(new Date(T0.getTime() + MAX_WAIT_MS).toISOString())
    expect(() => waitDelay(-1)).toThrow(/invalid_wait/)
  })

  it('parseWait aceita o formato solto (delay_ms, handle) e completa os defaults', () => {
    expect(parseWait({ kind: 'timer', handle: 'x', delay_ms: 5000 }, now)).toMatchObject({
      kind: 'timer',
      handles: { timeout: 'x' },
      deadline_at: '2026-10-16T12:00:05.000Z',
      timer_gen: 0,
    })
    expect(parseWait({ kind: 'reply' })).toMatchObject({ handles: { reply: 'source', timeout: 'timeout' }, deadline_at: null })
    expect(parseWait(null)).toBeNull()
  })
})

describe('timers', () => {
  it('jobId determinístico, sem ":"; a geração só aparece depois de um resume', () => {
    expect(flowTimerJobId({ runId: 'r', seq: 3 })).toBe('timer-r-seq-3')
    expect(flowTimerJobId({ runId: 'r', seq: 3, gen: 2 })).toBe('timer-r-seq-3-g2')
    expect(flowTimerJobId({ runId: 'r', seq: 3, gen: 1 })).not.toContain(':')
  })

  it('curto roda em processo; longo vai para o agendador; cancelar limpa os dois', async () => {
    vi.useFakeTimers()
    const fire = vi.fn(async () => undefined)
    const scheduler: TimerScheduler = { schedule: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) }
    const timers = new FlowTimers(fire, { scheduler, shortDelayMs: 5000 })
    expect(await timers.schedule({ runId: 'a', seq: 1 }, 1500)).toBe('local')
    expect(await timers.schedule({ runId: 'a', seq: 1 }, 1500)).toBe('local')
    expect(timers.pendingLocal).toBe(1)
    expect(await timers.schedule({ runId: 'b', seq: 1 }, 172_800_000)).toBe('queued')
    expect(scheduler.schedule).toHaveBeenCalledWith({ runId: 'b', seq: 1 }, 172_800_000)
    await vi.advanceTimersByTimeAsync(1500)
    expect(fire).toHaveBeenCalledTimes(1)
    await timers.schedule({ runId: 'c', seq: 1 }, 100)
    await timers.cancel({ runId: 'c', seq: 1 })
    await vi.advanceTimersByTimeAsync(200)
    expect(fire).toHaveBeenCalledTimes(1)
    expect(scheduler.cancel).toHaveBeenCalledWith({ runId: 'c', seq: 1 })
  })

  it('bullTimerScheduler: job delayed com o jobId e remove pelo mesmo id', async () => {
    const add = vi.fn(async () => undefined)
    const remove = vi.fn(async () => 1)
    const s = bullTimerScheduler({ add, remove })
    await s.schedule({ runId: 'r', seq: 2 }, 1234.4)
    expect(add).toHaveBeenCalledWith('flow-timer', { runId: 'r', seq: 2 }, { jobId: 'timer-r-seq-2', delay: 1234 })
    await s.cancel({ runId: 'r', seq: 2, gen: 1 })
    expect(remove).toHaveBeenCalledWith('timer-r-seq-2-g1')
  })
})
