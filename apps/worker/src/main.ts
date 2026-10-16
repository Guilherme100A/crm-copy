// Entrada do processo worker do CRM: toda a montagem de produção fica em `startProductionWorker` (T120), a mesma
// função usada pelos testes de montagem.
import { createLogger } from '@crm/node-kit'
import { loadWorkerConfig } from './boot/config'
import { startProductionWorker } from './boot/production-worker'

const logger = createLogger({ level: loadWorkerConfig().LOG_LEVEL })

try {
  await startProductionWorker({ logger })
} catch (err) {
  logger.fatal({ err }, 'falha ao iniciar o worker')
  process.exitCode = 1
}
