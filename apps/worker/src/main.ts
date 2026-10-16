// Entrada do processo worker do CRM: config → migrations → WaGateway (WA_GATEWAY=rpc|fake) e LLM da plataforma →
// módulos configurados (T46) → startWorker (registry do processo).
import { RealtimePublisher } from '@crm/core'
import { createDb, runMigrations } from '@crm/db'
import { createLogger, redisConnection } from '@crm/node-kit'
import { createWaGatewayFromEnv } from '@crm/wa-gateway-rpc'
import { loadWorkerConfig } from './boot/config'
import { configureWorkerProduction, platformLlmFromEnv } from './boot/production'
import { startWorker } from './boot/start'

const config = loadWorkerConfig()
const logger = createLogger({ level: config.LOG_LEVEL })

try {
  const db = createDb(config.DATABASE_URL)
  await runMigrations(db)
  const wa = createWaGatewayFromEnv(process.env, { redis: config.REDIS_URL, logger })
  // Capacidades do backend: falha aqui não impede o boot (valem as do perfil).
  await wa.rpc?.refreshCapabilities().catch((err: unknown) => logger.warn({ err }, 'não foi possível consultar as capacidades do wa-worker'))
  logger.info({ wa_gateway: wa.mode }, 'WaGateway configurado')
  const redis = redisConnection({ url: config.REDIS_URL })
  configureWorkerProduction({
    db,
    waGateway: wa.gateway,
    llm: platformLlmFromEnv(process.env, logger),
    logger,
    publisher: new RealtimePublisher({ redis }),
  })
  await startWorker({
    db,
    redisUrl: config.REDIS_URL,
    consumer: { stream: config.WA_EVENTS_STREAM },
    logger,
    onStop: async () => {
      await wa.close()
      await redis.quit()
      await db.$client.end()
    },
  })
} catch (err) {
  logger.fatal({ err }, 'falha ao iniciar o worker')
  process.exitCode = 1
}
