import { describe, expect, it } from 'vitest'
import type { MassDispatchRunnerDeps } from '@crm/core'
import { createRegistry } from '../../registry'
import { MASS_DISPATCH_QUEUE, bullTickScheduler, createMassDispatchProcessor, massDispatchTickJobId, registerMassDispatchJob } from './index'

describe('job mass-dispatch', () => {
  it('registra a fila com uma tentativa', () => {
    const reg = registerMassDispatchJob(createRegistry(), {} as MassDispatchRunnerDeps)
    expect(reg.queues).toEqual([{ name: MASS_DISPATCH_QUEUE, opts: { defaultJobOptions: { attempts: 1 } } }])
    expect(reg.workers.map((w) => w.name)).toEqual([MASS_DISPATCH_QUEUE])
  })

  it('recusa job inválido e sem configuração', async () => {
    const proc = createMassDispatchProcessor({} as MassDispatchRunnerDeps)
    await expect(proc({ data: { kind: 'tick' } } as never)).rejects.toThrow('dispatchId inválido')
    await expect(proc({ data: { kind: 'x', dispatchId: 'd' } } as never)).rejects.toThrow('job desconhecido')
    await expect(createMassDispatchProcessor(() => undefined)({ data: { kind: 'prepare', dispatchId: 'd' } } as never)).rejects.toThrow(/configureMassDispatch/)
  })

  it('tick vai com dispatchId nos dados e jobId sem ":"', async () => {
    const added: Array<{ name: string; data: unknown; opts: { jobId: string; delay: number } }> = []
    const schedule = bullTickScheduler(() => ({ add: async (name: string, data: unknown, opts: never) => (added.push({ name, data, opts }), {}) }) as never)
    await schedule({ kind: 'tick', dispatchId: 'd1', targetId: 't1' }, 1500)
    expect(added[0]).toMatchObject({ name: 'tick', data: { kind: 'tick', dispatchId: 'd1', targetId: 't1' }, opts: { delay: 1500 } })
    expect(added[0]!.opts.jobId).toMatch(/^tick-d1-t1-\d+$/)
    expect(massDispatchTickJobId({ kind: 'tick', dispatchId: 'a', targetId: 'b' }, 5)).toBe('tick-a-b-5')
  })
})
