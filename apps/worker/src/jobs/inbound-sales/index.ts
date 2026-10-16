// Job `inbound-sales` (T73): processa cada evento aceito por `POST /api/hooks/sales/:token` (jobId `ise-<eventId>`,
// replay `ise-<eventId>-r<n>`). Falha de mapeamento vira evento `failed` (não relança); erro de infraestrutura
// relança para o BullMQ tentar de novo.
import { INBOUND_SALES_QUEUE, InboundSalesProcessor, type InboundSaleJobData, type InboundSaleResult, type InboundSalesProcessorOptions } from '@crm/core'
import type { Database } from '@crm/db'
import type { Job, Processor } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export { INBOUND_SALES_QUEUE } from '@crm/core'
export const INBOUND_SALES_QUEUE_OPTS = { defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5_000 } } } as const

type InboundSalesDeps = Partial<Omit<InboundSalesProcessorOptions, 'db'>> & { db?: Database }
let configured: InboundSalesDeps = {}
let processProcessor: InboundSalesProcessor | undefined

/**
 * Dependências do processo: `db`, o `publisher` do realtime e o `capiEnqueue` da fila `meta-capi`. Em produção, passe
 * o publisher envelopado pela T125 (`capiSalePublisher`, Purchase da venda criada aprovada) e `metaCapiEnqueuer()`
 * (Purchase da venda que passa de pendente a aprovada).
 */
export function configureInboundSales(deps: InboundSalesDeps): void {
  configured = { ...configured, ...deps }
  processProcessor = undefined
}

export function inboundSalesProcessor(): InboundSalesProcessor | undefined {
  if (processProcessor) return processProcessor
  const { db, ...rest } = configured
  if (!db) return undefined
  processProcessor = new InboundSalesProcessor({ ...rest, db })
  return processProcessor
}

export function createInboundSalesProcessor(deps: { processor: () => Pick<InboundSalesProcessor, 'process'> | undefined }): Processor<InboundSaleJobData, InboundSaleResult> {
  return async (job: Pick<Job<InboundSaleJobData>, 'data'>) => {
    const p = deps.processor()
    if (!p) throw new Error('inbound-sales: dependências não configuradas (configureInboundSales({ db, publisher }))')
    return p.process(job.data)
  }
}

/** Registra fila e worker `inbound-sales`. Com `deps.processor`, usa esse (testes); sem, o do processo. */
export function registerInboundSalesJob(registry: WorkerRegistry, deps?: { processor: Pick<InboundSalesProcessor, 'process'> }): WorkerRegistry {
  registry.queue(INBOUND_SALES_QUEUE, INBOUND_SALES_QUEUE_OPTS)
  registry.worker<InboundSaleJobData, InboundSaleResult>(INBOUND_SALES_QUEUE, createInboundSalesProcessor({ processor: () => deps?.processor ?? inboundSalesProcessor() }))
  return registry
}
