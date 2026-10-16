// Processo da API: carrega config, migra, cria o app e abre a porta (@hono/node-server).
import { serve } from '@hono/node-server'
import { createDb, runMigrations } from '@crm/db'
import { createLogger, initCredentialsCrypto, redisConnection } from '@crm/node-kit'
import { createApp } from './app'
import { loadApiConfig } from './config'

async function main() {
  const config = loadApiConfig()
  const logger = createLogger({ level: config.LOG_LEVEL, base: { service: 'api' } })
  initCredentialsCrypto({ key: config.CREDENTIALS_KEY })

  const db = createDb(config.DATABASE_URL)
  await runMigrations(db)
  const redis = redisConnection({ url: config.REDIS_URL })

  const app = createApp({
    db,
    redis,
    logger,
    sessionTtlDays: config.AUTH_SESSION_TTL_DAYS,
    cookieSecure: config.NODE_ENV === 'production',
    trustProxy: config.TRUST_PROXY,
  })

  const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
    logger.info({ port: info.port }, 'api listening')
  })

  let closing = false
  const shutdown = (signal: string) => {
    if (closing) return
    closing = true
    logger.info({ signal }, 'api shutting down')
    server.close(() => {
      void Promise.allSettled([db.$client.end(), redis.quit()]).then(() => process.exit(0))
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  createLogger().fatal({ err }, 'api failed to start')
  process.exit(1)
})
