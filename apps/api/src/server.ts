// Processo da API: monta as deps de produção (`createProductionApiDeps`, T125), cria o app e abre a porta
// (@hono/node-server). A montagem fica em `production.ts` para os testes usarem exatamente a mesma.
import { serve } from '@hono/node-server'
import { createLogger } from '@crm/node-kit'
import { createApp } from './app'
import { createProductionApiDeps } from './production'
import { stopRealtimeHub } from './routes/events/index'

async function main() {
  const production = await createProductionApiDeps()
  const { config, logger, redis } = production
  const app = createApp(production.deps)

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
    production.dispose()
    logger.info({ signal }, 'api shutting down')
    setTimeout(() => process.exit(1), 10_000).unref()
    // T117: o hub realtime (subscriber Redis) fecha antes do Redis de comandos.
    void stopRealtimeHub(redis)
      .catch((err: unknown) => logger.warn({ err }, 'failed to stop realtime hub'))
      .then(() => {
        server.close(() => {
          void production.close().then(() => process.exit(0))
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
