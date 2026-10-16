// Entrada do processo worker do CRM: config → migrations → startWorker (registry do processo).
import { createDb, runMigrations } from '@crm/db'
import { createLogger } from '@crm/node-kit'
import { loadWorkerConfig } from './boot/config'
import { startWorker } from './boot/start'

const config = loadWorkerConfig()
const logger = createLogger({ level: config.LOG_LEVEL })

try {
  const db = createDb(config.DATABASE_URL)
  await runMigrations(db)
  await startWorker({
    db,
    redisUrl: config.REDIS_URL,
    consumer: { stream: config.WA_EVENTS_STREAM },
    logger,
    onStop: () => db.$client.end(),
  })
} catch (err) {
  logger.fatal({ err }, 'falha ao iniciar o worker')
  process.exitCode = 1
}
