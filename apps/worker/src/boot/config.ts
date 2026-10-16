// Configuração do processo worker (SPEC 3.12), validada com zod no boot.
import { DEFAULT_DATABASE_URL } from '@crm/db'
import { DEFAULT_REDIS_URL, loadConfig, type Env } from '@crm/node-kit'
import { WA_EVENTS_STREAM } from '@crm/wa-port'
import * as z from 'zod'

export const workerConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1).default(DEFAULT_DATABASE_URL),
  REDIS_URL: z.string().min(1).default(DEFAULT_REDIS_URL),
  WA_EVENTS_STREAM: z.string().min(1).default(WA_EVENTS_STREAM),
})
export type WorkerConfig = z.output<typeof workerConfigSchema>

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  return loadConfig(workerConfigSchema, env)
}
