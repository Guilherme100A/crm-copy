// Saúde da infraestrutura para o admin (T96, AC-T96-02; 20-admin-interno.md §3.14): contagens por fila BullMQ do CRM,
// memória do Redis, conexões e tamanho do Postgres e lag do grupo `crm` no stream `wsm:events`. Cada bloco roda com
// timeout e erro isolado: um bloco fora do ar vira `status: 'down'` sem derrubar a resposta.
import { sql } from 'drizzle-orm'
import { Queue, type ConnectionOptions } from 'bullmq'
import type { Database } from '@crm/db'
import { WA_EVENTS_STREAM } from '@crm/wa-port'
import { AI_AGENT_QUEUE } from '../ai-runtime/scheduler'
import { AI_AGENT_LAB_QUEUE } from '../ai-agent-lab/service'
import { EXPORTS_QUEUE, IMPORTS_QUEUE } from '../exports/service'
import { FLOW_TIMER_QUEUE } from '../flows/engine/timers'
import { INBOUND_SALES_QUEUE } from '../sale-sources/service'
import { INBOUND_WEBHOOKS_QUEUE } from '../inbound-webhooks/service'
import { INVOICES_QUEUE } from '../invoicing/emission'
import { MASS_DISPATCH_QUEUE } from '../mass-dispatch/jobs'
import { META_CAPI_QUEUE } from '../meta-capi/sales'
import { META_SYNC_QUEUE } from '../meta-ads/structure/service'
import { PAYMENT_WEBHOOKS_QUEUE } from '../payments/webhooks/service'
import { SCHEDULES_QUEUE } from '../schedules/rules'
import { crmQueuePrefix } from '../jobs/queues'

/**
 * Filas BullMQ que o worker do CRM registra (lista única do monitoramento). `flow-step` e `ai-knowledge` são nomes
 * definidos só no `apps/worker`, que a API não importa.
 */
export const MONITORED_QUEUES: readonly string[] = [
  AI_AGENT_QUEUE,
  AI_AGENT_LAB_QUEUE,
  'ai-knowledge',
  EXPORTS_QUEUE,
  IMPORTS_QUEUE,
  'flow-step',
  FLOW_TIMER_QUEUE,
  INBOUND_SALES_QUEUE,
  INBOUND_WEBHOOKS_QUEUE,
  INVOICES_QUEUE,
  MASS_DISPATCH_QUEUE,
  META_CAPI_QUEUE,
  META_SYNC_QUEUE,
  PAYMENT_WEBHOOKS_QUEUE,
  SCHEDULES_QUEUE,
]

/** Grupo de consumo do CRM no stream do WhatsApp (`DEFAULT_CONSUMER_GROUP` do worker). */
export const CRM_CONSUMER_GROUP = 'crm'

export type HealthStatus = 'ok' | 'down'

export interface QueueHealth {
  name: string
  status: HealthStatus
  /** Esperando para rodar (`wait` + `prioritized`). */
  waiting: number | null
  active: number | null
  failed: number | null
  delayed: number | null
  /**
   * Jobs parados pela pausa da fila. O BullMQ 6 não tem mais lista `paused`: com a fila pausada os jobs ficam em
   * `wait`, então `paused` = `waiting` quando `is_paused`, senão 0.
   */
  paused: number | null
  is_paused: boolean | null
  error?: string
}

export interface RedisHealth {
  status: HealthStatus
  used_memory_bytes: number | null
  used_memory_human: string | null
  used_memory_peak_bytes: number | null
  maxmemory_bytes: number | null
  error?: string
}

export interface PostgresHealth {
  status: HealthStatus
  /** Conexões abertas no banco atual (`pg_stat_activity`). */
  connections: number | null
  max_connections: number | null
  database_size_bytes: number | null
  error?: string
}

export interface WaEventsHealth {
  status: HealthStatus
  stream: string
  group: string
  /** O stream e o grupo existem. */
  exists: boolean
  /** Entradas ainda não entregues ao grupo (`XINFO GROUPS`, campo `lag`; null se o Redis não souber calcular). */
  lag: number | null
  /** Entregues e não confirmadas (PEL). */
  pending: number | null
  consumers: number | null
  error?: string
}

export interface InfraHealth {
  status: 'ok' | 'degraded'
  checked_at: string
  queue_prefix: string
  queues: QueueHealth[]
  redis: RedisHealth
  postgres: PostgresHealth
  wa_events: WaEventsHealth
}

/** Cliente Redis mínimo (ioredis). */
export interface HealthRedis {
  info(section: string): Promise<string>
  call(command: string, ...args: (string | number)[]): Promise<unknown>
}

export interface InfraHealthOptions {
  db: Database
  redis: HealthRedis
  /** Conexão das filas: o próprio cliente ioredis (compartilhado; `close()` da fila não o fecha). Default: `redis`. */
  queueConnection?: ConnectionOptions
  /** Default `crmQueuePrefix()`. */
  queuePrefix?: string
  /** Default `MONITORED_QUEUES`. */
  queues?: readonly string[]
  /** Default `WA_EVENTS_STREAM`. */
  stream?: string
  group?: string
  /** Timeout de cada bloco em ms (default 2000). */
  timeoutMs?: number
  now?: () => Date
}

class TimeoutError extends Error {
  constructor() {
    super('timeout')
  }
}

/** Roda `fn` com timeout; erro ou demora → `{ ok: false, error }`. */
async function guarded<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), timeoutMs)
  })
  try {
    return { ok: true, value: await Promise.race([fn(), timeout]) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'erro' }
  } finally {
    clearTimeout(timer)
  }
}

/** `INFO` do Redis → mapa `campo: valor`. */
export function parseRedisInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim()
  }
  return out
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Resposta do `XINFO GROUPS` → lista de objetos. RESP2 (e o ioredis 6 com o Redis local) devolve listas planas
 * `[campo, valor, …]`; RESP3 pode devolver mapas (objeto ou `Map`). Aceita os três.
 */
export function parseXinfoGroups(reply: unknown): Record<string, unknown>[] {
  if (!Array.isArray(reply)) return []
  return reply.map((g) => {
    if (Array.isArray(g)) {
      const o: Record<string, unknown> = {}
      for (let i = 0; i + 1 < g.length; i += 2) o[String(g[i])] = g[i + 1]
      return o
    }
    if (g instanceof Map) return Object.fromEntries([...g.entries()].map(([k, v]) => [String(k), v]))
    if (g && typeof g === 'object') return g as Record<string, unknown>
    return {}
  })
}

async function queueHealth(
  name: string,
  connection: ConnectionOptions,
  prefix: string,
  timeoutMs: number,
): Promise<QueueHealth> {
  const queue = new Queue(name, { connection, prefix })
  // Sem listener, erro de conexão vira "não tratado".
  queue.on('error', () => undefined)
  try {
    const r = await guarded(async () => {
      const [counts, isPaused] = await Promise.all([
        queue.getJobCounts('waiting', 'prioritized', 'active', 'failed', 'delayed'),
        queue.isPaused(),
      ])
      return { counts, isPaused }
    }, timeoutMs)
    if (!r.ok)
      return {
        name,
        status: 'down',
        waiting: null,
        active: null,
        failed: null,
        delayed: null,
        paused: null,
        is_paused: null,
        error: r.error,
      }
    const c = r.value.counts
    const waiting = (c.waiting ?? 0) + (c.prioritized ?? 0)
    return {
      name,
      status: 'ok',
      waiting,
      active: c.active ?? 0,
      failed: c.failed ?? 0,
      delayed: c.delayed ?? 0,
      paused: r.value.isPaused ? waiting : 0,
      is_paused: r.value.isPaused,
    }
  } finally {
    await queue.close().catch(() => undefined)
  }
}

async function redisHealth(redis: HealthRedis, timeoutMs: number): Promise<RedisHealth> {
  const r = await guarded(() => redis.info('memory'), timeoutMs)
  if (!r.ok)
    return {
      status: 'down',
      used_memory_bytes: null,
      used_memory_human: null,
      used_memory_peak_bytes: null,
      maxmemory_bytes: null,
      error: r.error,
    }
  const info = parseRedisInfo(String(r.value))
  return {
    status: 'ok',
    used_memory_bytes: num(info.used_memory),
    used_memory_human: info.used_memory_human ?? null,
    used_memory_peak_bytes: num(info.used_memory_peak),
    maxmemory_bytes: num(info.maxmemory),
  }
}

async function postgresHealth(db: Database, timeoutMs: number): Promise<PostgresHealth> {
  const r = await guarded(async () => {
    const { rows } = await db.execute<{
      connections: string | number
      max_connections: string
      size: string | number
    }>(sql`
      select
        (select count(*) from pg_stat_activity where datname = current_database()) as connections,
        current_setting('max_connections') as max_connections,
        pg_database_size(current_database()) as size`)
    return rows[0]
  }, timeoutMs)
  if (!r.ok)
    return { status: 'down', connections: null, max_connections: null, database_size_bytes: null, error: r.error }
  const row = (r.value ?? {}) as Record<string, unknown>
  return {
    status: 'ok',
    connections: num(row.connections),
    max_connections: num(row.max_connections),
    database_size_bytes: num(row.size),
  }
}

async function waEventsHealth(
  redis: HealthRedis,
  stream: string,
  group: string,
  timeoutMs: number,
): Promise<WaEventsHealth> {
  const base = { stream, group }
  const r = await guarded(async () => {
    try {
      return await redis.call('XINFO', 'GROUPS', stream)
    } catch (err) {
      // Stream inexistente: não é falha da infra, só ainda não houve evento.
      if (err instanceof Error && /no such key/i.test(err.message)) return null
      throw err
    }
  }, timeoutMs)
  if (!r.ok)
    return { ...base, status: 'down', exists: false, lag: null, pending: null, consumers: null, error: r.error }
  const g = parseXinfoGroups(r.value).find((x) => String(x.name) === group)
  if (!g) return { ...base, status: 'ok', exists: false, lag: null, pending: null, consumers: null }
  return { ...base, status: 'ok', exists: true, lag: num(g.lag), pending: num(g.pending), consumers: num(g.consumers) }
}

/** Saúde da infraestrutura do CRM (AC-T96-02). */
export async function infraHealth(opts: InfraHealthOptions): Promise<InfraHealth> {
  const timeoutMs = opts.timeoutMs ?? 2000
  const prefix = opts.queuePrefix ?? crmQueuePrefix()
  const connection = opts.queueConnection ?? (opts.redis as unknown as ConnectionOptions)
  const [queues, redis, postgres, waEvents] = await Promise.all([
    Promise.all((opts.queues ?? MONITORED_QUEUES).map((name) => queueHealth(name, connection, prefix, timeoutMs))),
    redisHealth(opts.redis, timeoutMs),
    postgresHealth(opts.db, timeoutMs),
    waEventsHealth(opts.redis, opts.stream ?? WA_EVENTS_STREAM, opts.group ?? CRM_CONSUMER_GROUP, timeoutMs),
  ])
  const allOk =
    redis.status === 'ok' &&
    postgres.status === 'ok' &&
    waEvents.status === 'ok' &&
    queues.every((q) => q.status === 'ok')
  return {
    status: allOk ? 'ok' : 'degraded',
    checked_at: (opts.now?.() ?? new Date()).toISOString(),
    queue_prefix: prefix,
    queues,
    redis,
    postgres,
    wa_events: waEvents,
  }
}
