import { describe, expect, it } from 'vitest'
import type { RunJobDeps } from '@crm/core'
import { createRegistry } from '../../registry'
import { EXPORTS_QUEUE, IMPORTS_QUEUE, createExportsProcessor, registerExportsJob } from './index'

const fakeDeps = {} as RunJobDeps

describe('jobs exports/imports', () => {
  it('registra as duas filas com uma tentativa só e os dois workers', () => {
    const reg = registerExportsJob(createRegistry(), fakeDeps)
    expect(reg.queues.map((q) => q.name)).toEqual([EXPORTS_QUEUE, IMPORTS_QUEUE])
    expect(reg.queues.every((q) => q.opts.defaultJobOptions?.attempts === 1)).toBe(true)
    expect(reg.workers.map((w) => w.name)).toEqual(['exports', 'imports'])
  })

  it('processor recusa job sem jobId', async () => {
    const proc = createExportsProcessor(fakeDeps)
    await expect(proc({ data: {} } as never)).rejects.toThrow('exports: jobId inválido')
  })

  it('sem configureExports o worker do processo falha com mensagem clara', async () => {
    const reg = registerExportsJob(createRegistry())
    await expect(reg.workers[0]!.processor({ data: { jobId: 'x' } } as never)).rejects.toThrow(/configureExports/)
  })
})
