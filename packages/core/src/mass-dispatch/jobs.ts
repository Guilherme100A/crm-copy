// Jobs dos disparos na fila `mass-dispatch` (prefixo `crm`). A T60 só enfileira a preparação e remove os pendentes no
// cancelamento; os jobs de envio são da T74 e precisam carregar `dispatchId` nos dados para o cancelamento achá-los.
import type { Queue } from 'bullmq'
import type { MassDispatchJobs } from './service'

export const MASS_DISPATCH_QUEUE = 'mass-dispatch'

export interface MassDispatchJobData {
  kind: 'prepare' | (string & {})
  dispatchId: string
  [key: string]: unknown
}

/** `jobId` da preparação (sem `:`). */
export const massDispatchPrepareJobId = (dispatchId: string) => `prepare-${dispatchId}`

/** Implementação BullMQ: prepara com jobId determinístico; cancela os waiting/delayed/prioritized do disparo. */
export function bullMassDispatchJobs(queue: () => Queue<MassDispatchJobData>): MassDispatchJobs {
  return {
    async enqueuePrepare(dispatchId) {
      await queue().add('prepare', { kind: 'prepare', dispatchId }, { jobId: massDispatchPrepareJobId(dispatchId), attempts: 1 })
    },
    async cancel(dispatchId) {
      const q = queue()
      const jobs = await q.getJobs(['waiting', 'delayed', 'prioritized', 'waiting-children'])
      await Promise.all(jobs.filter((j) => j?.data?.dispatchId === dispatchId).map((j) => j.remove().catch(() => undefined)))
    },
  }
}
