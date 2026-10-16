// Configuração do wa-worker a partir do ambiente (SPEC 3.12; padrão do ai-manager apps/worker/src/boot/config.ts).
import { antibanModeFromEnv, type AntibanMode } from '@crm/wa-engine'
import { WA_EVENTS_STREAM } from '@crm/wa-port'

export type TransportKind = 'baileys' | 'fake'

export interface WaWorkerConfig {
  databaseUrl: string
  redisUrl: string
  logLevel: string
  transport: TransportKind
  antibanMode: AntibanMode
  /** Porta do RPC interno (`WA_RPC_URL` do CRM aponta para cá). 0 = aleatória. */
  rpcPort: number
  rpcHost: string
  internalToken: string
  /** Prefixo do BullMQ (`<prefix>:session:<id>`) e das chaves Redis do worker. */
  queuePrefix: string
  eventsStream: string
  storageDir: string
}

export class WaWorkerConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WaWorkerConfigError'
  }
}

const port = (raw: string | undefined, fallback: number, name: string) => {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new WaWorkerConfigError(`invalid ${name}: ${raw}`)
  return n
}

export function loadWaWorkerConfig(env: Record<string, string | undefined> = process.env): WaWorkerConfig {
  const missing = ['DATABASE_URL', 'REDIS_URL', 'CREDENTIALS_KEY', 'INTERNAL_TOKEN'].filter((k) => !env[k]?.trim())
  if (missing.length) throw new WaWorkerConfigError(`missing wa-worker configuration: ${missing.join(', ')}`)
  const transport = (env.WA_TRANSPORT?.trim().toLowerCase() || 'baileys') as TransportKind
  if (transport !== 'baileys' && transport !== 'fake') throw new WaWorkerConfigError(`invalid WA_TRANSPORT: ${env.WA_TRANSPORT} (use baileys or fake)`)
  return {
    databaseUrl: env.DATABASE_URL!,
    redisUrl: env.REDIS_URL!,
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    transport,
    antibanMode: antibanModeFromEnv(env),
    rpcPort: port(env.WA_RPC_PORT, 3100, 'WA_RPC_PORT'),
    // Só loopback por padrão: o RPC controla sessões e envios. Em contêiner, defina WA_RPC_HOST explicitamente.
    rpcHost: env.WA_RPC_HOST?.trim() || '127.0.0.1',
    internalToken: env.INTERNAL_TOKEN!,
    queuePrefix: env.WA_QUEUE_PREFIX?.trim() || 'wsm',
    eventsStream: env.WA_EVENTS_STREAM?.trim() || WA_EVENTS_STREAM,
    storageDir: env.STORAGE_DIR?.trim() || './storage',
  }
}
