import { describe, expect, it, vi } from 'vitest'
import type { FlowControl } from '@crm/core'
import { createRegistry } from '../../registry'
import { FLOW_TIMER_QUEUE, createFlowTimerProcessor, registerFlowTimerJob } from './index'

describe('job flow-timer', () => {
  it('processor chama fireTimer com runId, seq e gen (0 por padrão); dados inválidos lançam', async () => {
    const fireTimer = vi.fn(async () => ({ advanced: false as const, reason: 'stale' as const }))
    const processor = createFlowTimerProcessor({ control: { fireTimer } as unknown as FlowControl })
    await expect(processor({ data: { runId: 'r', seq: 4 } } as never)).resolves.toEqual({ advanced: false, reason: 'stale' })
    expect(fireTimer).toHaveBeenCalledWith({ runId: 'r', seq: 4, gen: 0 })
    await expect(processor({ data: { seq: 1 } } as never)).rejects.toThrow(/inválidos/)
  })

  it('registra a fila e o worker flow-timer', () => {
    const reg = registerFlowTimerJob(createRegistry(), { control: { fireTimer: vi.fn() } as unknown as FlowControl })
    expect(reg.queues.map((q) => q.name)).toEqual([FLOW_TIMER_QUEUE])
    expect(reg.workers.map((w) => w.name)).toEqual([FLOW_TIMER_QUEUE])
  })
})
