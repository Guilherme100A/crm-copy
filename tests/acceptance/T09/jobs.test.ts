// AC-T09-05: defineQueue cria filas com o prefixo do CRM (`CRM_QUEUE_PREFIX`, padrão `crm` — T121) e nome sem `:`; SIGTERM fecha workers e consumidores
// sem perder job ativo (o job termina antes do exit).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exec, tail } from '../helpers/exec'
import { REDIS_URL, core, kit, newRedis, rand, waitFor } from './support'

let redis: any
const toClose: any[] = []
// Prefixo do CRM: CRM_QUEUE_PREFIX do ambiente (a aceitação usa um por execução, T121); sem a variável, `crm`.
const PREFIX = process.env.CRM_QUEUE_PREFIX || 'crm'

beforeAll(async () => {
  redis = await newRedis()
})

afterAll(async () => {
  for (const q of toClose) {
    await q.obliterate?.({ force: true }).catch(() => {})
    await q.close?.().catch(() => {})
  }
  await redis?.quit().catch(() => {})
})

describe('T09 — defineQueue / defineWorker', () => {
  it('AC-T09-05 defineQueue cria fila com prefixo crm e o nome pedido', async () => {
    const { defineQueue } = await core()
    const { bullConnection } = await kit()
    const name = `t09-fila-${rand()}`
    const q = defineQueue(name, { connection: bullConnection({ url: REDIS_URL }) })
    toClose.push(q)
    expect(q.name).toBe(name)
    expect(q.opts?.prefix ?? q.qualifiedName?.split(':')[0]).toBe(PREFIX)
    await q.add('teste', { a: 1 })
    const keys: string[] = await redis.keys(`${PREFIX}:${name}:*`)
    expect(keys.length, `nenhuma chave ${PREFIX}:<fila>:* no Redis`).toBeGreaterThan(0)
    // sem a variável, o prefixo é `crm`
    const saved = process.env.CRM_QUEUE_PREFIX
    delete process.env.CRM_QUEUE_PREFIX
    try {
      const plain = defineQueue(`t09-padrao-${rand()}`, { connection: bullConnection({ url: REDIS_URL }) })
      toClose.push(plain)
      expect(plain.opts?.prefix).toBe('crm')
    } finally {
      if (saved !== undefined) process.env.CRM_QUEUE_PREFIX = saved
    }
  })

  it('AC-T09-05 nome de fila com ":" é rejeitado', async () => {
    const { defineQueue } = await core()
    const { bullConnection } = await kit()
    expect(() => defineQueue(`t09:invalida:${rand()}`, { connection: bullConnection({ url: REDIS_URL }) })).toThrow()
  })

  it('AC-T09-05 defineWorker processa jobs da fila crm com os defaults (removeOnComplete/Fail, backoff exponencial)', async () => {
    const { defineQueue, defineWorker } = await core()
    const { bullConnection } = await kit()
    const name = `t09-proc-${rand()}`
    const q = defineQueue(name, { connection: bullConnection({ url: REDIS_URL }) })
    toClose.push(q)
    const done: unknown[] = []
    const w = defineWorker(name, async (job: any) => void done.push(job.data), { connection: bullConnection({ url: REDIS_URL }) })
    try {
      expect(w.opts?.prefix).toBe(PREFIX)
      expect(() =>
        defineWorker(`t09:x:${rand()}`, async () => {}, { connection: bullConnection({ url: REDIS_URL }), autorun: false }),
      ).toThrow()
      const job = await q.add('soma', { n: 42 })
      await waitFor(() => done.length === 1, 10_000, 'job processado')
      expect(done[0]).toEqual({ n: 42 })
      const o = job.opts ?? {}
      expect(o.removeOnComplete, 'removeOnComplete ausente').toBeDefined()
      expect(o.removeOnFail, 'removeOnFail ausente').toBeDefined()
      expect(o.backoff?.type ?? o.backoff).toBe('exponential')
    } finally {
      await w.close()
    }
  })
})

describe('T09 — SIGTERM com job ativo', () => {
  it('AC-T09-05 SIGTERM fecha workers e consumidores e o job ativo termina antes do exit', async () => {
    const queue = `t09-sigterm-${rand()}`
    const r = exec('pnpm exec tsx tests/acceptance/T09/fixtures/sigterm-child.ts', {
      timeoutMs: 90_000,
      env: {
        NODE_OPTIONS: '--conditions=development',
        T09_REDIS_URL: REDIS_URL,
        T09_QUEUE: queue,
        T09_STREAM: `t09:${rand()}:wsm:events`,
        T09_JOB_MS: '1500',
      },
    })
    const lines = r.stdout.split(/\r?\n/).map((l) => l.trim())
    const at = (s: string) => lines.findIndex((l) => l === s || l.startsWith(`${s} `))
    expect(at('READY'), tail(r)).toBeGreaterThanOrEqual(0)
    expect(at('JOB_START'), tail(r)).toBeGreaterThanOrEqual(0)
    expect(at('SIGTERM_SENT'), tail(r)).toBeGreaterThan(at('JOB_START'))
    expect(at('JOB_DONE'), `job ativo não terminou antes do exit\n${tail(r)}`).toBeGreaterThan(at('SIGTERM_SENT'))
    expect(at('EXIT'), `processo não saiu após SIGTERM\n${tail(r)}`).toBeGreaterThan(at('JOB_DONE'))
    expect(lines[at('EXIT')], tail(r)).toBe('EXIT 0')
    expect(r.code, tail(r)).toBe(0)

    // o job não ficou ativo/pendente nem falhou
    const { defineQueue } = await core()
    const { bullConnection } = await kit()
    const q = defineQueue(queue, { connection: bullConnection({ url: REDIS_URL }) })
    toClose.push(q)
    const counts = await q.getJobCounts('active', 'waiting', 'delayed', 'failed')
    expect(counts).toEqual({ active: 0, waiting: 0, delayed: 0, failed: 0 })
  })
})
