// Boot de produção do worker num lugar só (T120): o `main.ts` e os testes de montagem usam a MESMA função.
// config → crypto (`CREDENTIALS_KEY`) → migrations → WaGateway (WA_GATEWAY=rpc|fake) → módulos configurados →
// startWorker → `flow_run.updated`.
import { join } from 'node:path'
import { FsExportFileStore } from '@crm/core'
import { createDb, runMigrations, type Database } from '@crm/db'
import { ensureDefaultAiPrices } from '@crm/db'
import { createLogger, FsBlobStore, initCredentialsCrypto, redisConnection, type Logger } from '@crm/node-kit'
import { createWaGatewayFromEnv, type WaGatewayFromEnv } from '@crm/wa-gateway-rpc'
import type { Redis } from 'ioredis'
import { loadWorkerConfig, type WorkerConfig } from './config'
import { attachFlowRunEvents } from './flow-run-events'
import { configureWorkerProduction, type WorkerProduction, type WorkerProductionDeps } from './production'
import { startWorker, type WorkerApp } from './start'

type Env = Record<string, string | undefined>

export interface StartProductionWorkerOptions {
  /** Default `process.env`. */
  env?: Env
  logger?: Logger
  /** Banco já aberto (testes); default `createDb(DATABASE_URL)`. Fechado no stop só se foi criado aqui. */
  db?: Database
  /** Roda as migrations no boot. Default true. */
  migrate?: boolean
  /** Instala SIGTERM/SIGINT e sai do processo no fim. Default true (o `main.ts`); testes passam false. */
  handleSignals?: boolean
  /** Sobrepõe dependências da montagem (ex.: `llm` em testes). */
  overrides?: Partial<Omit<WorkerProductionDeps, 'db' | 'waGateway' | 'redis'>>
}

export interface ProductionWorker {
  config: WorkerConfig
  db: Database
  redis: Redis
  wa: WaGatewayFromEnv
  app: WorkerApp
  production: WorkerProduction
  stop(): Promise<void>
}

export async function startProductionWorker(opts: StartProductionWorkerOptions = {}): Promise<ProductionWorker> {
  const env = opts.env ?? process.env
  const config = loadWorkerConfig(env)
  const logger = opts.logger ?? createLogger({ level: config.LOG_LEVEL })
  if (config.CREDENTIALS_KEY) initCredentialsCrypto({ key: config.CREDENTIALS_KEY })
  else logger.warn({}, 'CREDENTIALS_KEY ausente: chaves BYOK não abrem e os ids de mídia não batem com os da API')

  const ownsDb = !opts.db
  const db = opts.db ?? createDb(config.DATABASE_URL)
  if (opts.migrate ?? true) await runMigrations(db)
  await ensureDefaultAiPrices(db)
  const wa = createWaGatewayFromEnv(env, { redis: config.REDIS_URL, logger })
  // Capacidades do backend: falha aqui não impede o boot (valem as do perfil).
  await wa.rpc?.refreshCapabilities().catch((err: unknown) => logger.warn({ err }, 'não foi possível consultar as capacidades do wa-worker'))
  logger.info({ wa_gateway: wa.mode }, 'WaGateway configurado')
  const redis = redisConnection({ url: config.REDIS_URL })

  const storage = config.STORAGE_DIR
  const production = configureWorkerProduction({
    db,
    waGateway: wa.gateway,
    redis,
    logger,
    env,
    ...(storage ? { blobStore: new FsBlobStore({ dir: storage }), files: new FsExportFileStore({ dir: join(storage, 'exports') }) } : {}),
    ...opts.overrides,
  })

  let offRunEvents = () => undefined as void
  const handleSignals = opts.handleSignals ?? true
  const app = await startWorker({
    db,
    redisUrl: config.REDIS_URL,
    consumer: { stream: config.WA_EVENTS_STREAM },
    logger,
    handleSignals,
    exitProcess: handleSignals,
    onStop: async () => {
      offRunEvents()
      production.dispose()
      await wa.close()
      await redis.quit().catch(() => undefined)
      if (ownsDb) await db.$client.end()
    },
  })
  offRunEvents = attachFlowRunEvents(app.workers, { db, publisher: production.publisher, logger })

  return { config, db, redis, wa, app, production, stop: () => app.stop() }
}
