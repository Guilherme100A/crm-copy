import { describe, expect, it, vi } from 'vitest'
import { createRegistry } from '../../registry'
import { SCHEDULES_QUEUE, bullScheduleEnqueuer, createSchedulesProcessor, queuePrefix, registerSchedulesJob } from './index'

describe('job schedules', () => {
  it('processor valida o job; sem dependências falha com mensagem clara', async () => {
    const processor = createSchedulesProcessor(() => undefined)
    await expect(processor({ data: { scheduleId: 's1', runAt: '2026-10-16T12:00:00.000Z' } } as never)).rejects.toThrow(/configureSchedules/)
    const withDeps = createSchedulesProcessor({ db: {} as never, send: { send: vi.fn() }, flows: { startRun: vi.fn() }, enqueue: vi.fn() })
    await expect(withDeps({ data: { scheduleId: 's1', runAt: 'ontem' } } as never)).rejects.toThrow(/job inválido/)
  })

  it('enfileira delayed com jobId determinístico e sem retry', async () => {
    const add = vi.fn(async () => undefined)
    await bullScheduleEnqueuer(() => ({ add }) as never)({ scheduleId: 'abc', runAt: '2026-10-16T12:00:00.000Z' }, 5000)
    expect(add).toHaveBeenCalledWith('run', { scheduleId: 'abc', runAt: '2026-10-16T12:00:00.000Z' }, { jobId: `schedule-abc-${Date.parse('2026-10-16T12:00:00Z')}`, delay: 5000, attempts: 1 })
    await bullScheduleEnqueuer(() => ({ add }) as never)({ scheduleId: 'abc', runAt: '2026-10-16T12:00:00.000Z' }, -10)
    expect((add.mock.calls[1] as unknown[])[2]).toMatchObject({ delay: 0 })
  })

  it('registra fila e worker schedules; prefixo do env', () => {
    const reg = registerSchedulesJob(createRegistry())
    expect(reg.queues.map((q) => q.name)).toEqual([SCHEDULES_QUEUE])
    expect(reg.workers.map((w) => w.name)).toEqual([SCHEDULES_QUEUE])
    expect(queuePrefix({ CRM_QUEUE_PREFIX: ' crm-t-1 ' })).toBe('crm-t-1')
    expect(queuePrefix({})).toBeUndefined()
  })
})
