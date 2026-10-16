// Redis real (REDIS_URL, db 1) com prefixo aleatório (SPEC 3.10).
import { randomBytes } from 'node:crypto'
import { bullConnection, CRM_QUEUE_PREFIX } from '@crm/node-kit'
import { afterAll, describe, expect, it } from 'vitest'
import { assertQueueName, CRM_DEFAULT_JOB_OPTIONS, crmQueuePrefix, defineQueue, defineWorker, InvalidQueueNameError } from './queues'

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

  it('cria a fila com o prefixo do ambiente (crm em produção) e os defaults de retenção e backoff', async () => {
    const q = defineQueue('flow-step', { connection: bullConnection() })
    closers.push(() => q.close())
    expect(q.name).toBe('flow-step')
    expect(q.opts.prefix).toBe(crmQueuePrefix())
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

describe('T121 prefixo das filas', () => {
  it('crmQueuePrefix: CRM_QUEUE_PREFIX do ambiente, senão crm (produção)', () => {
    expect(crmQueuePrefix({})).toBe(CRM_QUEUE_PREFIX)
    expect(crmQueuePrefix({ CRM_QUEUE_PREFIX: '  ' })).toBe('crm')
    expect(crmQueuePrefix({ CRM_QUEUE_PREFIX: 'crm-t-1-abc' })).toBe('crm-t-1-abc')
  })

  it('AC-T121-02: a config de teste define prefixos únicos por execução (CRM e wa-engine)', () => {
    // prefixo da execução (vitest.config.ts) + sufixo do arquivo (test-setup.ts, T126)
    expect(process.env.CRM_QUEUE_PREFIX).toMatch(/^crm-t-\d+-[a-z0-9]+-f[0-9a-f]{8}-[0-9a-f]{4}$/)
    expect(process.env.WA_QUEUE_PREFIX).toMatch(/^wsm-t-\d+-[a-z0-9]+-f[0-9a-f]{8}-[0-9a-f]{4}$/)
    expect(defineQueue('prefix-check').opts.prefix).toBe(process.env.CRM_QUEUE_PREFIX)
  })

  it('o prefixo é lido na criação: mudar o ambiente depois vale para as filas novas', async () => {
    const before = process.env.CRM_QUEUE_PREFIX
    process.env.CRM_QUEUE_PREFIX = `crm-t-late-${randomBytes(3).toString('hex')}`
    try {
      const q = defineQueue('late-prefix')
      const w = defineWorker('late-prefix', async () => undefined, { autorun: false })
      closers.push(() => q.close(), () => w.close())
      expect(q.opts.prefix).toBe(process.env.CRM_QUEUE_PREFIX)
      expect(w.opts.prefix).toBe(process.env.CRM_QUEUE_PREFIX)
    } finally {
      process.env.CRM_QUEUE_PREFIX = before
    }
  })

  it('AC-T121-01: dois workers com prefixos diferentes no MESMO Redis db só processam os jobs do próprio prefixo', async () => {
    const pa = `crm-t-a-${randomBytes(3).toString('hex')}`
    const pb = `crm-t-b-${randomBytes(3).toString('hex')}`
    const seen: Record<string, string[]> = { a: [], b: [] }
    const before = process.env.CRM_QUEUE_PREFIX
    const make = (key: 'a' | 'b', p: string) => {
      process.env.CRM_QUEUE_PREFIX = p
      const q = defineQueue<{ tag: string }>('isolation')
      const w = defineWorker<{ tag: string }>('isolation', async (job) => void seen[key]!.push(job.data.tag))
      closers.push(() => w.close(), () => q.close())
      return { q, w }
    }
    try {
      const a = make('a', pa)
      const b = make('b', pb)
      await Promise.all([a.w.waitUntilReady(), b.w.waitUntilReady()])
      await a.q.add('j', { tag: 'para-a-1' })
      await b.q.add('j', { tag: 'para-b-1' })
      await a.q.add('j', { tag: 'para-a-2' })
      const deadline = Date.now() + 10_000
      while (seen.a!.length + seen.b!.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
      await new Promise((r) => setTimeout(r, 200))
      expect(seen.a!.sort()).toEqual(['para-a-1', 'para-a-2'])
      expect(seen.b).toEqual(['para-b-1'])
    } finally {
      process.env.CRM_QUEUE_PREFIX = before
    }
  })
})
