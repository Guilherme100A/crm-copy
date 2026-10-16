// Processo da API: carrega config, migra, cria o app e abre a porta (@hono/node-server).
import { serve } from '@hono/node-server'
import {
  bullTimerScheduler,
  defineQueue,
  FlowControl,
  FlowEngine,
  FlowTriggers,
  FsExportFileStore,
  registerAttendanceFinishedTrigger,
  type FlowStepJobData,
  type FlowTimerJobData,
  type TimerScheduler,
} from '@crm/core'
import { createDb, runMigrations } from '@crm/db'
import { ensureDefaultAiPrices } from '@crm/db'
import { join } from 'node:path'
import { bullConnection, createLogger, FsBlobStore, initCredentialsCrypto, redisConnection } from '@crm/node-kit'
import { createWaGatewayFromEnv } from '@crm/wa-gateway-rpc'
import { createApp } from './app'
import { loadApiConfig } from './config'
import { stopRealtimeHub } from './routes/events/index'

async function main() {
  const config = loadApiConfig()
  const logger = createLogger({ level: config.LOG_LEVEL, base: { service: 'api' } })
  initCredentialsCrypto({ key: config.CREDENTIALS_KEY })

  const db = createDb(config.DATABASE_URL)
  await runMigrations(db)
  await ensureDefaultAiPrices(db)
  const redis = redisConnection({ url: config.REDIS_URL })

  // T46: WaGateway real (WA_GATEWAY=rpc → wa-worker por RPC + stream) ou FakeWaGateway (WA_GATEWAY=fake).
  const wa = createWaGatewayFromEnv(process.env, { redis, logger })
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
  const storageDir = process.env.STORAGE_DIR?.trim() || './storage'
  const blobStore = new FsBlobStore({ dir: storageDir })
  const exportFiles = new FsExportFileStore({ dir: join(storageDir, 'exports') })

  const app = createApp({
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
  })

  const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
    logger.info({ port: info.port }, 'api listening')
  })

  // Conexões longas (SSE) não terminam sozinhas: depois desta folga são derrubadas para o `close` concluir.
  const DRAIN_MS = 1_000
  const sockets = server as unknown as { closeIdleConnections?: () => void; closeAllConnections?: () => void }

  let closing = false
  const shutdown = (signal: string) => {
    if (closing) return
    closing = true
    offAttendance()
    logger.info({ signal }, 'api shutting down')
    setTimeout(() => process.exit(1), 10_000).unref()
    // T117: o hub realtime (subscriber Redis) fecha antes do Redis de comandos.
    void stopRealtimeHub(redis)
      .catch((err: unknown) => logger.warn({ err }, 'failed to stop realtime hub'))
      .then(() => {
        server.close(() => {
          void Promise.allSettled([
            stepQueue?.close(),
            timerQueue?.close(),
            wa.close(),
          ])
            .then(() => Promise.allSettled([db.$client.end(), redis.quit()]))
            .then(() => process.exit(0))
        })
        sockets.closeIdleConnections?.()
        setTimeout(() => sockets.closeAllConnections?.(), DRAIN_MS).unref()
      })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  createLogger().fatal({ err }, 'api failed to start')
  process.exit(1)
})
