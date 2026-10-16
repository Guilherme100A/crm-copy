// Redis real (REDIS_URL, db 1) com prefixo aleatório (SPEC 3.10).
import { randomBytes } from 'node:crypto'
import { bullConnection, CRM_QUEUE_PREFIX } from '@crm/node-kit'
import { afterAll, describe, expect, it } from 'vitest'
import { assertQueueName, CRM_DEFAULT_JOB_OPTIONS, defineQueue, defineWorker, InvalidQueueNameError } from './queues'

const prefix = `crm-test-${randomBytes(4).toString('hex')}`
const closers: (() => Promise<void>)[] = []

afterAll(async () => {
  for (const close of closers) await close()
})

describe('defineQueue / defineWorker', () => {
  it('rejeita nomes com ":" e fora do padrão', () => {
    expect(() => assertQueueName('session:abc')).toThrow(InvalidQueueNameError)
    expect(() => assertQueueName('Flow Step')).toThrow(InvalidQueueNameError)
    expect(() => defineQueue('a:b')).toThrow(InvalidQueueNameError)
    expect(() => defineWorker('a:b', async () => undefined)).toThrow(InvalidQueueNameError)
    expect(assertQueueName('flow-step')).toBe('flow-step')
  })

  it('cria a fila com prefixo crm por padrão e os defaults de retenção e backoff', async () => {
    const q = defineQueue('flow-step', { connection: bullConnection() })
    closers.push(() => q.close())
    expect(q.name).toBe('flow-step')
    expect(q.opts.prefix).toBe(CRM_QUEUE_PREFIX)
    expect(q.defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: CRM_DEFAULT_JOB_OPTIONS.removeOnComplete,
      removeOnFail: CRM_DEFAULT_JOB_OPTIONS.removeOnFail,
    })
  })

  it('worker processa job da fila com o mesmo prefixo e força maxRetriesPerRequest null', async () => {
    const q = defineQueue<{ n: number }>('unit-sum', { prefix })
    const done = new Promise<number>((resolve) => {
      const w = defineWorker<{ n: number }, number>('unit-sum', async (job) => job.data.n * 2, { prefix })
      w.on('completed', (_job, result) => resolve(result))
      closers.push(() => w.close())
      expect(w.opts.prefix).toBe(prefix)
      expect(w.opts.removeOnComplete).toEqual(CRM_DEFAULT_JOB_OPTIONS.removeOnComplete)
    })
    closers.push(() => q.close())
    await q.add('x', { n: 21 })
    await expect(done).resolves.toBe(42)
  })
})
