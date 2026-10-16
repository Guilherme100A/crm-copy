// AC-T121-01: dois workers do CRM com CRM_QUEUE_PREFIX diferentes no MESMO Redis db (1): um job enfileirado num
// prefixo só é processado pelo worker daquele prefixo. O prefixo é lido do ambiente NA CRIAÇÃO (sem passar `prefix`).
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
const rand = () => randomBytes(4).toString('hex')
const open: any[] = []
const original = process.env.CRM_QUEUE_PREFIX

afterAll(async () => {
  for (const x of open.reverse()) {
    await x.obliterate?.({ force: true }).catch(() => {})
    await x.close?.().catch(() => {})
  }
  if (original === undefined) delete process.env.CRM_QUEUE_PREFIX
  else process.env.CRM_QUEUE_PREFIX = original
})

async function waitFor(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timeout esperando ${what}`)
}

describe('T121 — prefixo de fila por ambiente (AC-T121-01)', () => {
  it('AC-T121-01 dois workers com prefixos diferentes no mesmo db só processam os jobs do próprio prefixo', async () => {
    const core: any = await import('@crm/core')
    const { bullConnection }: any = await import('@crm/node-kit')
    const name = `t121-fila-${rand()}` // MESMO nome de fila nos dois prefixos
    const pa = `t121a-${rand()}`
    const pb = `t121b-${rand()}`
    const seenA: string[] = []
    const seenB: string[] = []

    process.env.CRM_QUEUE_PREFIX = pa
    const qa = core.defineQueue(name, { connection: bullConnection({ url: REDIS_URL }) })
    const wa = core.defineWorker(name, async (job: any) => void seenA.push(job.data.tag), { connection: bullConnection({ url: REDIS_URL }) })
    process.env.CRM_QUEUE_PREFIX = pb
    const qb = core.defineQueue(name, { connection: bullConnection({ url: REDIS_URL }) })
    const wb = core.defineWorker(name, async (job: any) => void seenB.push(job.data.tag), { connection: bullConnection({ url: REDIS_URL }) })
    open.push(qa, qb, wa, wb)

    expect(qa.opts.prefix).toBe(pa)
    expect(qb.opts.prefix).toBe(pb)
    expect(wa.opts.prefix).toBe(pa)
    expect(wb.opts.prefix).toBe(pb)

    for (let i = 0; i < 5; i++) {
      await qa.add('j', { tag: `A${i}` })
      await qb.add('j', { tag: `B${i}` })
    }
    await waitFor(() => seenA.length === 5 && seenB.length === 5, 20_000, '10 jobs processados')
    await new Promise((r) => setTimeout(r, 500))
    expect(seenA.sort()).toEqual(['A0', 'A1', 'A2', 'A3', 'A4'])
    expect(seenB.sort()).toEqual(['B0', 'B1', 'B2', 'B3', 'B4'])
  })

  it('AC-T121-01 crmQueuePrefix lê o ambiente na chamada; sem variável o padrão é crm', async () => {
    const core: any = await import('@crm/core')
    const { bullConnection }: any = await import('@crm/node-kit')
    expect(typeof core.crmQueuePrefix).toBe('function')
    process.env.CRM_QUEUE_PREFIX = 'pref-um'
    expect(core.crmQueuePrefix()).toBe('pref-um')
    process.env.CRM_QUEUE_PREFIX = 'pref-dois'
    expect(core.crmQueuePrefix()).toBe('pref-dois')
    delete process.env.CRM_QUEUE_PREFIX
    expect(core.crmQueuePrefix()).toBe('crm')
    const q = core.defineQueue(`t121-padrao-${rand()}`, { connection: bullConnection({ url: REDIS_URL }) })
    open.push(q)
    expect(q.opts.prefix).toBe('crm')
    // prefix explícito continua tendo precedência
    process.env.CRM_QUEUE_PREFIX = 'ignorado'
    const qx = core.defineQueue(`t121-explicito-${rand()}`, { connection: bullConnection({ url: REDIS_URL }), prefix: 'explicito' })
    open.push(qx)
    expect(qx.opts.prefix).toBe('explicito')
  })
})
