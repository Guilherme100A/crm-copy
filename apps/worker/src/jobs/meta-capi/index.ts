// Job `meta-capi` (T104): envia o `Purchase` de cada venda registrada (`sale.recorded`) para os pixels da empresa com
// `auto_send_sales`. O dedupe é do `capi_event_log` (`event_id = sale-<id>`): reprocessar o job não reenvia.
// Falha da Meta fica gravada no log do evento (status `failed`) e o job lança para o BullMQ tentar de novo.
import {
  CapiService,
  META_CAPI_QUEUE,
  defineQueue,
  sendSaleToPixels,
  type CapiSaleEnqueue,
  type CapiSaleOutcome,
  type CapiServiceOptions,
  type MetaCapiSaleJobData,
} from '@crm/core'
import type { Database } from '@crm/db'
import type { Job, Processor } from 'bullmq'
import type { WorkerRegistry } from '../../registry'

export { META_CAPI_QUEUE } from '@crm/core'

export const META_CAPI_QUEUE_OPTS = { defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } } } as const

type MetaCapiDeps = Partial<Omit<CapiServiceOptions, 'db'>> & { db?: Database }
let configured: MetaCapiDeps = {}

/** Dependências do processo (`db` obrigatório; Graph/`fetch`/`testEventCode` opcionais). */
export function configureMetaCapi(deps: MetaCapiDeps): void {
  configured = { ...configured, ...deps }
}

export function createMetaCapiProcessor(deps: { deps: () => MetaCapiDeps }): Processor<MetaCapiSaleJobData, CapiSaleOutcome[]> {
  return async (job: Pick<Job<MetaCapiSaleJobData>, 'data'>) => {
    const { db, ...opts } = deps.deps()
    if (!db) throw new Error('meta-capi: dependências não configuradas (configureMetaCapi({ db }))')
    const out = await sendSaleToPixels({ db, capi: new CapiService({ ...opts, db }) }, job.data)
    const failed = out.filter((o) => o.result.status === 'failed')
    if (failed.length) throw new Error(`meta-capi: ${failed.length} envio(s) falharam: ${failed.map((f) => (f.result.status === 'failed' ? f.result.error : '')).join('; ')}`)
    return out
  }
}

/** `enqueue` do `capiSalePublisher` a partir da fila `meta-capi` (prefixo `CRM_QUEUE_PREFIX`). */
export function metaCapiEnqueuer(queue = defineQueue<MetaCapiSaleJobData>(META_CAPI_QUEUE, META_CAPI_QUEUE_OPTS)): CapiSaleEnqueue {
  return async (data, opts) => {
    await queue.add(META_CAPI_QUEUE, data, { jobId: opts.jobId })
  }
}

/** Registra fila e worker `meta-capi`. Com `deps`, usa essas (testes); sem, as do processo. */
export function registerMetaCapiJob(registry: WorkerRegistry, deps?: MetaCapiDeps): WorkerRegistry {
  registry.queue(META_CAPI_QUEUE, META_CAPI_QUEUE_OPTS)
  registry.worker<MetaCapiSaleJobData, CapiSaleOutcome[]>(META_CAPI_QUEUE, createMetaCapiProcessor({ deps: () => deps ?? configured }))
  return registry
}
