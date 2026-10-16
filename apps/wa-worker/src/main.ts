// Entrada do processo wa-worker: dono dos sockets do WhatsApp e do RPC interno (SPEC T29).
import { createLogger } from '@crm/node-kit'
import { installShutdownHandlers, startWaWorker } from './boot/start'

const logger = createLogger({ level: process.env.LOG_LEVEL?.trim() || 'info' })
let requestShutdown: (() => Promise<void>) | undefined

try {
  const worker = await startWaWorker({ logger, onShutdown: () => void requestShutdown?.() })
  requestShutdown = installShutdownHandlers(worker, logger)
} catch (err) {
  logger.fatal({ err }, 'falha ao iniciar o wa-worker')
  process.exitCode = 1
}
