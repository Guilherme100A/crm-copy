// Sonda do AC-T126-01: roda DENTRO de um vitest filho (config de packages/core via mergeConfig), um processo por arquivo.
// Cada arquivo de fixture enfileira jobs na MESMA fila (`t126-probe`) e registra quais jobs o SEU worker consumiu.
// Agenda determinística: depois de uma barreira (os dois arquivos vivos), A liga o worker na hora; B enfileira e só
// liga o worker 3 s depois. Com prefixos iguais, o worker de A pega os jobs de B nesse intervalo; isolados, nunca.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineQueue, defineWorker } from '../../../../packages/core/src/jobs/queues'
import { redisConnection } from '../../../../packages/node-kit/src/redis'
import * as dbTesting from '../../../../packages/db/src/testing'

const QUEUE = 't126-probe'
const JOBS = 20
const B_WORKER_DELAY_MS = 3_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runProbe(label: 'A' | 'B') {
  const out = process.env.T126_OUT
  const tag = process.env.T126_TAG
  if (!out || !tag) throw new Error('T126_OUT/T126_TAG ausentes (a sonda só roda pelo teste AC-T126-01)')
  const other = label === 'A' ? 'B' : 'A'
  const fromSetup = { crm: process.env.CRM_QUEUE_PREFIX ?? null, wa: process.env.WA_QUEUE_PREFIX ?? null }
  // Controle negativo: força o MESMO prefixo nos dois arquivos (como antes da T126) para provar que a sonda detecta o roubo.
  if (process.env.T126_SHARED_PREFIX) process.env.CRM_QUEUE_PREFIX = process.env.T126_SHARED_PREFIX
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helper = (dbTesting as any).testQueuePrefix?.() ?? null

  const redis = redisConnection()
  redis.on('error', () => {})
  const queue = defineQueue<{ from: string; i: number }>(QUEUE)
  const consumed: Array<{ from: string; i: number }> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let worker: any = null
  const startWorker = () => {
    worker = defineWorker<{ from: string; i: number }>(QUEUE, async (job) => void consumed.push(job.data), { concurrency: 5 })
  }
  try {
    // barreira: os dois arquivos vivos ao mesmo tempo
    await redis.set(`${tag}:ready:${label}`, '1', 'EX', 120)
    const t0 = Date.now()
    while (!(await redis.get(`${tag}:ready:${other}`))) {
      if (Date.now() - t0 > 60_000) throw new Error(`barreira: arquivo ${other} não apareceu em 60 s`)
      await sleep(100)
    }
    if (label === 'A') startWorker()
    await queue.addBulk(Array.from({ length: JOBS }, (_, i) => ({ name: 'probe', data: { from: label, i }, opts: { jobId: `${label}-${i}` } })))
    if (label === 'B') {
      await sleep(B_WORKER_DELAY_MS)
      startWorker()
    }
    // espera o próprio lote (ou desiste) e dá folga para jobs alheios aparecerem
    const t1 = Date.now()
    while (consumed.filter((j) => j.from === label).length < JOBS && Date.now() - t1 < 20_000) await sleep(100)
    await sleep(1_500)
  } finally {
    await worker?.close().catch(() => {})
    await queue.obliterate({ force: true }).catch(() => {})
    await queue.close().catch(() => {})
    await redis.quit().catch(() => redis.disconnect())
  }
  writeFileSync(
    join(out, `${label}.json`),
    JSON.stringify({ label, fromSetup, used: process.env.CRM_QUEUE_PREFIX, helper, queuePrefix: queue.opts.prefix, consumed }, null, 2),
  )
}
