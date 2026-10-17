// Montagem de produção da API num lugar só (T125): o `server.ts` e os testes de montagem usam a MESMA função.
// config → crypto → banco (migrations + preços de IA) → Redis → WaGateway (WA_GATEWAY=rpc|fake) → filas sob demanda
// (`flow-step`, `flow-timer`, `meta-capi`) → controle/gatilhos de fluxo → storage → deps do `createApp`.
import { join } from 'node:path'
import {
  bullTimerScheduler,
  capiSalePublisher,
  defineQueue,
  FlowControl,
  FlowEngine,
  FlowTriggers,
  FsExportFileStore,
  INVOICES_JOB_OPTIONS,
  INVOICES_QUEUE,
  invoiceSalePublisher,
  META_CAPI_QUEUE,
  RealtimePublisher,
  registerAttendanceFinishedTrigger,
  type FlowStepJobData,
  type FlowTimerJobData,
  type InvoiceEnqueue,
  type InvoiceJobData,
  type MetaCapiSaleJobData,
  type TimerScheduler,
  type UtmifyEnqueue,
  type UtmifyJobData,
  UTMIFY_JOB_OPTIONS,
  UTMIFY_QUEUE,
  utmifySalePublisher,
} from '@crm/core'
import { createDb, ensureDefaultAiPrices, runMigrations, type Database } from '@crm/db'
import { bullConnection, createLogger, FsBlobStore, initCredentialsCrypto, redisConnection, type Logger } from '@crm/node-kit'
import { createWaGatewayFromEnv, type WaGatewayFromEnv } from '@crm/wa-gateway-rpc'
import type { RedisClient } from './app'
import { loadApiConfig, type ApiConfig } from './config'
import type { AppDeps } from './lib/types'

type Env = Record<string, string | undefined>

/** Opções de job da fila `meta-capi` (as mesmas do worker, T104). */
export const META_CAPI_JOB_OPTS = { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } } as const

export interface CreateProductionApiOptions {
  /** Default `process.env`. */
  env?: Env
  logger?: Logger
  /** Banco já aberto (testes); default `createDb(DATABASE_URL)`. Fechado no `close` só se foi criado aqui. */
  db?: Database
  /** Roda as migrations. Default true. */
  migrate?: boolean
}

export interface ProductionApi {
  config: ApiConfig
  logger: Logger
  db: Database
  redis: RedisClient
  wa: WaGatewayFromEnv
  /** Deps do `createApp` exatamente como em produção. */
  deps: AppDeps
  /** Desliga os ouvintes de processo ("atendimento finalizado"). */
  dispose(): void
  /** Fecha filas e o WaGateway; depois o banco (se é nosso) e o Redis. */
  close(): Promise<void>
}

export async function createProductionApiDeps(opts: CreateProductionApiOptions = {}): Promise<ProductionApi> {
  const env = opts.env ?? process.env
  const config = loadApiConfig(env)
  const logger = opts.logger ?? createLogger({ level: config.LOG_LEVEL, base: { service: 'api' } })
  initCredentialsCrypto({ key: config.CREDENTIALS_KEY })

  const ownsDb = !opts.db
  const db = opts.db ?? createDb(config.DATABASE_URL)
  if (opts.migrate ?? true) await runMigrations(db)
  await ensureDefaultAiPrices(db)
  const redis = redisConnection({ url: config.REDIS_URL })

  // T46: WaGateway real (WA_GATEWAY=rpc → wa-worker por RPC + stream) ou FakeWaGateway (WA_GATEWAY=fake).
  const wa = createWaGatewayFromEnv(env, { redis, logger })
  await wa.rpc?.refreshCapabilities().catch((err: unknown) => logger.warn({ err }, 'não foi possível consultar as capacidades do wa-worker'))
  logger.info({ wa_gateway: wa.mode }, 'WaGateway configurado')

  // T43/T46: filas `flow-step`/`flow-timer` da API criadas sob demanda aqui, para o shutdown fechá-las.
  const connection = bullConnection({ url: config.REDIS_URL })
  let stepQueue: ReturnType<typeof defineQueue<FlowStepJobData>> | undefined
  let timerQueue: ReturnType<typeof defineQueue<FlowTimerJobData>> | undefined
  const timerQueueOf = () => (timerQueue ??= defineQueue<FlowTimerJobData>('flow-timer', { connection }))
  // jobId igual ao do worker (T25): `run-<id>-seq-<n>` (o BullMQ recusa `:`).
  const flowStepEnqueue = async (job: FlowStepJobData) => {
    stepQueue ??= defineQueue<FlowStepJobData>('flow-step', { connection })
    await stepQueue.add('flow-step', job, { jobId: `run-${job.runId}-seq-${job.expectedSeq}` })
  }
  const timers: TimerScheduler = {
    schedule: (data, delayMs) => bullTimerScheduler(timerQueueOf()).schedule(data, delayMs),
    cancel: (data) => bullTimerScheduler(timerQueueOf()).cancel(data),
  }
  const flowControl = new FlowControl({ db, timers, enqueueStep: flowStepEnqueue, logger })

  // T120: resolver um chat (rota de chats, T48) dispara o fluxo de "atendimento finalizado" da conexão (T61). A API só
  // CRIA o run e enfileira o 1º flow-step; os passos rodam no worker.
  // Motor só dos gatilhos (com enqueue); o da rota de execuções segue o padrão dela (sem enqueue próprio).
  const flowEngine = new FlowEngine({ db, wa: wa.gateway, enqueue: flowStepEnqueue, hooks: flowControl.engineHooks(), logger })
  const offAttendance = registerAttendanceFinishedTrigger(new FlowTriggers({ db, engine: flowEngine, control: flowControl, waGateway: wa.gateway, logger }), logger)

  // T120: o MESMO STORAGE_DIR do worker (mídia na raiz, export/import em exports/).
  const storageDir = env.STORAGE_DIR?.trim() || './storage'
  const blobStore = new FsBlobStore({ dir: storageDir })
  const exportFiles = new FsExportFileStore({ dir: join(storageDir, 'exports') })

  // T125: venda registrada pela API (`sale.recorded`) → job `meta-capi` no worker (Purchase aos pixels com
  // `auto_send_sales`; dedupe por `sale-<id>`). Mesmas opções de job da fila do worker; fila criada no primeiro uso.
  let capiQueue: ReturnType<typeof defineQueue<MetaCapiSaleJobData>> | undefined
  const salesPublisher = capiSalePublisher(new RealtimePublisher({ redis }), {
    enqueue: async (data, o) => {
      capiQueue ??= defineQueue<MetaCapiSaleJobData>(META_CAPI_QUEUE, { connection, defaultJobOptions: META_CAPI_JOB_OPTS })
      await capiQueue.add(META_CAPI_QUEUE, data, { jobId: o.jobId })
    },
    logger,
  })

  const deps: AppDeps = {
    db,
    redis,
    logger,
    sessionTtlDays: config.AUTH_SESSION_TTL_DAYS,
    cookieSecure: config.NODE_ENV === 'production',
    trustProxy: config.TRUST_PROXY,
    waGateway: wa.gateway,
    flowStepEnqueue,
    flowControl,
    blobStore,
    exportFiles,
    salesPublisher,
  }

  // T112: emissão de NF. O emissor é encadeado no publisher das vendas (depois do CAPI), como no worker: a venda aprovada
  // com `note_issuer_id` enfileira o job `invoices`; a reemissão (`POST /api/sales/:id/reemit-invoice`) usa a mesma fila.
  let invoicesQueue: ReturnType<typeof defineQueue<InvoiceJobData>> | undefined
  const invoicesEnqueue: InvoiceEnqueue = async (data, o) => {
    invoicesQueue ??= defineQueue<InvoiceJobData>(INVOICES_QUEUE, { connection, defaultJobOptions: INVOICES_JOB_OPTIONS })
    await invoicesQueue.add(INVOICES_QUEUE, data, { jobId: o.jobId })
  }
  deps.salesPublisher = invoiceSalePublisher(salesPublisher, { enqueue: invoicesEnqueue, logger })
  deps.invoicesEnqueue = invoicesEnqueue

  // T113: envio à UTMify. Encadeado depois da NF, como no worker: a venda aprovada com `utmify_integration_id` (criada
  // pela API) e a que passa a reembolsada (PATCH /api/sales/:id, `sale.updated` do SalesService) enfileiram o job `utmify`.
  let utmifyQueue: ReturnType<typeof defineQueue<UtmifyJobData>> | undefined
  const utmifyEnqueue: UtmifyEnqueue = async (data, o) => {
    utmifyQueue ??= defineQueue<UtmifyJobData>(UTMIFY_QUEUE, { connection, defaultJobOptions: UTMIFY_JOB_OPTIONS })
    await utmifyQueue.add(UTMIFY_QUEUE, data, { jobId: o.jobId })
  }
  deps.salesPublisher = utmifySalePublisher(deps.salesPublisher, { enqueue: utmifyEnqueue, logger })

  return {
    config,
    logger,
    db,
    redis,
    wa,
    deps,
    dispose: offAttendance,
    close: async () => {
      await Promise.allSettled([stepQueue?.close(), timerQueue?.close(), capiQueue?.close(), invoicesQueue?.close(), utmifyQueue?.close(), wa.close()])
      await Promise.allSettled([ownsDb ? db.$client.end() : undefined, redis.quit()])
    },
  }
}
