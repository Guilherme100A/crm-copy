import { describe, expect, it, vi } from 'vitest'
import type { FlowEngine } from '@crm/core'
import { createRegistry } from '../../registry'
import { FLOW_STEP_QUEUE, createFlowStepProcessor, flowStepEnqueuer, flowStepJobId, registerFlowStepJob } from './index'

describe('job flow-step', () => {
  it('processor chama engine.step com runId e expectedSeq; dados inválidos lançam', async () => {
    const step = vi.fn(async () => ({ executed: false as const, reason: 'stale' as const }))
    const processor = createFlowStepProcessor({ engine: { step } as unknown as FlowEngine })
    await expect(processor({ data: { runId: 'r1', expectedSeq: 3 } } as never)).resolves.toEqual({ executed: false, reason: 'stale' })
    expect(step).toHaveBeenCalledWith('r1', 3)
    await expect(processor({ data: { runId: 'r1' } } as never)).rejects.toThrow(/inválidos/)
  })

  it('jobId determinístico e sem ":" (BullMQ recusa)', async () => {
    expect(flowStepJobId({ runId: 'abc', expectedSeq: 2 })).toBe('run-abc-seq-2')
    const add = vi.fn(async () => undefined)
    await flowStepEnqueuer({ add } as never)({ runId: 'abc', expectedSeq: 2 })
    expect(add).toHaveBeenCalledWith(FLOW_STEP_QUEUE, { runId: 'abc', expectedSeq: 2 }, { jobId: 'run-abc-seq-2' })
  })

  it('registra fila e worker flow-step', () => {
    const reg = registerFlowStepJob(createRegistry(), { engine: { step: vi.fn() } as unknown as FlowEngine })
    expect(reg.queues.map((q) => q.name)).toEqual([FLOW_STEP_QUEUE])
    expect(reg.workers.map((w) => w.name)).toEqual([FLOW_STEP_QUEUE])
  })
})
