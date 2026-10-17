// Job `meta-sync` (T101): monta o bundle do Gerenciador Meta (estrutura + insights por conta) e publica o progresso.
// Limite de uso da Meta (BUC > 75% ou erros 17/80004…) NÃO é falha: o job volta para `delayed` até o `retryAt`
// (`job.moveToDelayed` + `DelayedError`, BullMQ 6) e a API segue devolvendo o último bundle com aviso.
import {
  META_SYNC_QUEUE,
  metaConfigFromEnv,
  MetaBundleService,
  MetaProfilesService,
  MetaRateLimitedError,
  RealtimePublisher,
  defineQueue,
  InternalSalesService,
  type BundleEnvelope,
  type MetaBundleServiceOptions,
  type MetaSyncJobData,
} from '@crm/core'
import type { Database } from '@crm/db'
import { DelayedError, type Job, type Processor } from 'bullmq'
import type { Redis } from 'ioredis'
import type { WorkerRegistry } from '../../registry'

export { META_SYNC_QUEUE } from '@crm/core'

/** Retenção curta e sem retry do BullMQ: a falha de uma conta já vira `errors[]` no bundle. */
export const META_SYNC_QUEUE_OPTS = { defaultJobOptions: { attempts: 1 } } as const

export function createMetaSyncProcessor(deps: { service: () => Pick<MetaBundleService, 'runJob'> | undefined }): Processor<MetaSyncJobData, BundleEnvelope | null> {
  return async (job: Pick<Job<MetaSyncJobData>, 'data' | 'moveToDelayed'>, token?: string) => {
    const service = deps.service()
    if (!service) throw new Error('meta-sync: dependências não configuradas (configureMetaAds({ db, redis }))')
    try {
      return await service.runJob(job.data)
    } catch (err) {
      if (err instanceof MetaRateLimitedError) {
        await job.moveToDelayed(err.retryAt, token)
        throw new DelayedError(err.message)
      }
      throw err
    }
  }
}

type MetaAdsDeps = Partial<Omit<MetaBundleServiceOptions, 'db' | 'redis'>> & { db?: Database; redis?: Redis }
let configured: MetaAdsDeps = {}
let processService: MetaBundleService | undefined

/** Dependências do processo (`db` e `redis` obrigatórios; perfis/config Meta do ambiente; publisher do Redis). */
export function configureMetaAds(deps: MetaAdsDeps): void {
  configured = { ...configured, ...deps }
  processService = undefined
}

/** Serviço do processo; `undefined` enquanto `configureMetaAds({ db, redis })` não foi chamado. */
export function metaBundleService(): MetaBundleService | undefined {
  if (processService) return processService
  const { db, redis } = configured
  if (!db || !redis) return undefined
  processService = new MetaBundleService({
    ...configured,
    db,
    redis,
    profiles: configured.profiles ?? new MetaProfilesService({ db, config: metaConfigFromEnv() }),
    publisher: configured.publisher ?? new RealtimePublisher({ redis }),
    enqueue: configured.enqueue ?? metaSyncEnqueuer(),
    // T105: vendas internas × anúncios (mesma cotação do bundle).
    internalSales: configured.internalSales ?? new InternalSalesService({ db, ...(configured.fx ? { fx: configured.fx } : {}) }),
  })
  return processService
}

/** `enqueue` do serviço a partir da fila `meta-sync` (prefixo `CRM_QUEUE_PREFIX`). */
export function metaSyncEnqueuer(queue = defineQueue<MetaSyncJobData>(META_SYNC_QUEUE, META_SYNC_QUEUE_OPTS)): NonNullable<MetaBundleServiceOptions['enqueue']> {
  return async (data, opts) => {
    await queue.add(META_SYNC_QUEUE, data, { jobId: opts.jobId })
  }
}

/** Registra fila e worker `meta-sync`. Com `deps.service`, usa esse (testes); sem, o do processo. */
export function registerMetaAdsJob(registry: WorkerRegistry, deps?: { service: Pick<MetaBundleService, 'runJob'> }): WorkerRegistry {
  registry.queue(META_SYNC_QUEUE, META_SYNC_QUEUE_OPTS)
  registry.worker<MetaSyncJobData, BundleEnvelope | null>(META_SYNC_QUEUE, createMetaSyncProcessor({ service: () => deps?.service ?? metaBundleService() }))
  return registry
}
