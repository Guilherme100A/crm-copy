// Conexões Redis/BullMQ (SPEC 3.9, AC-T05-06). ioredis 6; BullMQ 6 exige `maxRetriesPerRequest: null` nos Workers.
import { Redis, type RedisOptions } from 'ioredis'

export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379/1'
/** Prefixo BullMQ do CRM (o wa-engine usa `wsm`). Nomes de fila com `-`: BullMQ proíbe `:`. */
export const CRM_QUEUE_PREFIX = 'crm'

/** Retenção padrão de jobs: `removeOnComplete`/`removeOnFail` sempre configurados (SPEC 3.9). */
export const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
} as const

/** Converte `redis://[user:pass@]host[:port][/db]` (ou `rediss://`) em opções do ioredis. */
export function parseRedisUrl(url: string): RedisOptions {
  const u = new URL(url)
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new Error(`REDIS_URL com protocolo inválido: ${u.protocol}`)
  const opts: RedisOptions = { host: u.hostname || '127.0.0.1', port: u.port ? Number(u.port) : 6379 }
  if (u.username) opts.username = decodeURIComponent(u.username)
  if (u.password) opts.password = decodeURIComponent(u.password)
  const db = u.pathname.replace(/^\//, '')
  if (db) {
    const n = Number(db)
    if (!Number.isInteger(n) || n < 0) throw new Error(`REDIS_URL com número de banco inválido: ${db}`)
    opts.db = n
  }
  if (u.protocol === 'rediss:') opts.tls = {}
  return opts
}

export interface RedisConnectionOptions extends RedisOptions {
  /** Default: `REDIS_URL` ou `redis://127.0.0.1:6379/1`. */
  url?: string
}

/** Opções do ioredis a partir da URL (`REDIS_URL`) + overrides. */
export function redisOptions(opts: RedisConnectionOptions = {}): RedisOptions {
  const { url, ...rest } = opts
  return { ...parseRedisUrl(url ?? (process.env.REDIS_URL || DEFAULT_REDIS_URL)), ...rest }
}

/** Cliente ioredis para comandos comuns (streams, cache). Para pub/sub use `client.duplicate()`. */
export function redisConnection(opts: RedisConnectionOptions = {}): Redis {
  return new Redis(redisOptions(opts))
}

export type BullConnectionOptions = RedisOptions & { maxRetriesPerRequest: null }

/**
 * Opções de conexão para `Queue`/`Worker` do BullMQ (`{ connection: bullConnection() }`):
 * `maxRetriesPerRequest: null` sempre e banco da `REDIS_URL` respeitado.
 */
export function bullConnection(opts: RedisConnectionOptions = {}): BullConnectionOptions {
  return { ...redisOptions(opts), maxRetriesPerRequest: null }
}
