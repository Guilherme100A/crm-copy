// T126 (AC-T126-01): sonda de isolamento de filas entre arquivos de teste. Cada arquivo que a usa enfileira jobs
// marcados com a sua tag numa fila de NOME FIXO e consome com um worker próprio; com o prefixo por arquivo, o worker
// só vê os jobs do próprio arquivo. Usada por jobs/queue-isolation-{a,b}.db.unit.test.ts, que rodam em paralelo.
import { randomUUID } from 'node:crypto'
import { bullConnection } from '@crm/node-kit'
import { crmQueuePrefix, defineQueue, defineWorker } from './jobs/queues'

export const PROBE_QUEUE = 'isolation-probe'

export interface ProbeResult {
  prefix: string
  tag: string
  seen: string[]
}

/** Enfileira `count` jobs com a tag do arquivo e espera o worker do arquivo consumi-los; devolve as tags vistas. */
export async function runQueueIsolationProbe(tag: string, opts: { count?: number; lingerMs?: number; waitMs?: number } = {}): Promise<ProbeResult> {
  const count = opts.count ?? 20
  const connection = bullConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  const queue = defineQueue<{ tag: string; n: number }>(PROBE_QUEUE, { connection })
  const seen: string[] = []
  let mine = 0
  let done!: () => void
  const allMine = new Promise<void>((r) => (done = r))
  const worker = defineWorker<{ tag: string; n: number }>(
    PROBE_QUEUE,
    async (job) => {
      seen.push(job.data.tag)
      if (job.data.tag === tag && ++mine === count) done()
    },
    { connection, concurrency: 4 },
  )
  try {
    await worker.waitUntilReady()
    const run = randomUUID().slice(0, 8)
    for (let n = 0; n < count; n++) await queue.add('probe', { tag, n }, { jobId: `${tag}-${run}-${n}` })
    // Com prefixo dividido o outro arquivo rouba jobs e os nossos não chegam todos: não espera para sempre.
    await Promise.race([allMine, new Promise((r) => setTimeout(r, opts.waitMs ?? 20_000))])
    // Janela extra: se houvesse prefixo dividido, jobs do outro arquivo chegariam aqui também.
    await new Promise((r) => setTimeout(r, opts.lingerMs ?? 1500))
    return { prefix: crmQueuePrefix(), tag, seen }
  } finally {
    await worker.close()
    await queue.obliterate({ force: true }).catch(() => undefined)
    await queue.close()
  }
}
