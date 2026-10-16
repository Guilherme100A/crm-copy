// Boot do worker (T09): instancia filas, workers BullMQ e o consumidor do stream a partir do registry, com
// shutdown gracioso (SIGTERM/SIGINT): para de consumir, espera os jobs ativos (`worker.close()`) e só então sai.
import { defineQueue, defineWorker } from '@crm/core'
import type { Database } from '@crm/db'
import { bullConnection, type BullConnectionOptions } from '@crm/node-kit'
import type { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import { StreamConsumer, type ConsumerLogger, type StreamConsumerOptions } from '../consumers/framework'
import { registry as defaultRegistry, type WorkerRegistry } from '../registry'

export interface StartWorkerOptions {
  /** Default: o registry do processo (`registry.ts`). */
  registry?: WorkerRegistry
  /** URL do Redis para BullMQ e stream. Default `REDIS_URL`. */
  redisUrl?: string
  /** Instância ioredis para o stream (não é fechada no stop). Default: conexão própria em `redisUrl`. */
  redis?: Redis
  /** Opções de conexão do BullMQ. Default `bullConnection({ url: redisUrl })`. */
  connection?: BullConnectionOptions
  /** Prefixo BullMQ (default `crm`). */
  prefix?: string
  /** Liga a idempotência do consumidor (`crm.processed_events`). */
  db?: Database
  /** Opções extras do StreamConsumer (stream, group, claimIdleMs…). */
  consumer?: Omit<StreamConsumerOptions, 'redis' | 'db' | 'logger'>
  /** Inicia o consumidor mesmo sem handlers registrados. Default false (sem handler, não consome). */
  forceConsumer?: boolean
  /** Instala SIGTERM/SIGINT. Default true. */
  handleSignals?: boolean
  /** Após o shutdown por sinal, `process.exit(0)`. Default true. */
  exitProcess?: boolean
  /** Fechamentos extras após workers e consumidor (ex.: pool do banco). */
  onStop?: () => Promise<void> | void
  logger?: ConsumerLogger
}

export interface WorkerApp {
  consumer: StreamConsumer | undefined
  workers: Worker[]
  queues: Map<string, Queue>
  /** Idempotente: para o consumidor, fecha workers (esperando os jobs ativos) e filas. */
  stop(): Promise<void>
}

const SIGNALS = ['SIGTERM', 'SIGINT'] as const

export async function startWorker(opts: StartWorkerOptions = {}): Promise<WorkerApp> {
  const reg = opts.registry ?? defaultRegistry
  const connection = opts.connection ?? bullConnection(opts.redisUrl ? { url: opts.redisUrl } : {})
  const logger = opts.logger
  const prefix = opts.prefix ? { prefix: opts.prefix } : {}

  const queues = new Map<string, Queue>()
  for (const q of reg.queues) queues.set(q.name, defineQueue(q.name, { ...prefix, ...q.opts, connection }))

  const workers = reg.workers.map((w) => {
    const worker = defineWorker(w.name, w.processor, { ...prefix, ...w.opts, connection })
    worker.on('failed', (job, err) => logger?.warn({ queue: w.name, jobId: job?.id, err: err.message }, 'job falhou'))
    return worker
  })

  let consumer: StreamConsumer | undefined
  if (reg.handlers.length > 0 || opts.forceConsumer) {
    const redis = opts.redis ?? opts.redisUrl
    consumer = new StreamConsumer({
      ...opts.consumer,
      ...(redis ? { redis } : {}),
      ...(opts.db ? { db: opts.db } : {}),
      ...(logger ? { logger } : {}),
    })
    for (const h of reg.handlers) consumer.on(h.type, h.handler, h.opts)
    await consumer.start()
  }

  let stopping: Promise<void> | undefined
  const listeners = new Map<string, () => void>()
  const stop = () =>
    (stopping ??= (async () => {
      for (const [signal, fn] of listeners) process.off(signal, fn)
      await consumer?.stop()
      await Promise.all(workers.map((w) => w.close()))
      await Promise.all([...queues.values()].map((q) => q.close()))
      await opts.onStop?.()
      logger?.info({}, 'worker encerrado')
    })())

  if (opts.handleSignals ?? true) {
    const exit = opts.exitProcess ?? true
    for (const signal of SIGNALS) {
      const fn = () => {
        logger?.info({ signal }, 'sinal recebido; encerrando com graça')
        stop().then(
          () => {
            if (exit) process.exit(0)
          },
          (err: unknown) => {
            logger?.error({ err: err instanceof Error ? err.message : String(err) }, 'falha no shutdown')
            if (exit) process.exit(1)
          },
        )
      }
      listeners.set(signal, fn)
      process.once(signal, fn)
    }
  }

  logger?.info({ queues: queues.size, workers: workers.length, consumer: Boolean(consumer) }, 'worker iniciado')
  return { consumer, workers, queues, stop }
}
