// Boot do wa-worker (T29): migra `wa`, sobe SessionManager, MessageQueue, HealthMonitor, outbox de eventos, mídia
// e o RPC interno. Composição (pendência da T20):
//   deliver = createDeliver({ antiban, health: monitor, limits }) (+ resolução de `blob:<sha256>`)
//   queue   = new MessageQueue({ deliver, antiban })
//   monitor = new HealthMonitor({ db, queueControl: queue, manager })
//   SessionManager: onConnected/onDisconnected/resumeState = hooks do monitor; bindTransportSession no factory.
import { createDb, runMigrations, type Database } from '@crm/db'
import { createCipher, createLogger, FsBlobStore, redisConnection, type Logger } from '@crm/node-kit'
import {
  attachEventOutbox,
  BaileysTransport,
  bindTransportSession,
  createAntibanAdapter,
  createDeliver,
  HealthMonitor,
  MediaService,
  MessageQueue,
  SendPipeline,
  SessionLimitsService,
  SessionManager,
  type EventOutbox,
  type TransportFactory,
} from '@crm/wa-engine'
import { ClientMessageDedupe } from '../rpc/dedupe'
import { startInternalServer, type InternalServer } from '../rpc/server'
import { createRpcHandlers } from '../rpc/targets'
import { attachQueueToSessions } from './attach-queue'
import { withBlobRefs } from './blob-refs'
import { loadWaWorkerConfig, type WaWorkerConfig } from './config'
import { FakeControl } from './fake-control'

export interface StartWaWorkerOptions {
  env?: Record<string, string | undefined>
  /** Sobrepõe campos da configuração lida do ambiente (testes). */
  config?: Partial<WaWorkerConfig>
  logger?: Logger
  /** Substitui a factory de transporte (testes). */
  transportFactory?: TransportFactory
  /** Intervalo do Health Monitor (default do engine; 0 desliga o timer). */
  healthIntervalMs?: number
  /** Fake: `POST /internal/fake/shutdown` chama isto (o main encerra o processo como no SIGTERM). */
  onShutdown?: () => void
}

export interface WaWorkerHandle {
  url: string
  port: number
  config: WaWorkerConfig
  db: Database
  manager: SessionManager
  queue: MessageQueue
  monitor: HealthMonitor
  outbox: EventOutbox
  fake?: FakeControl
  server: InternalServer
  /** Encerramento gracioso: RPC, sockets, fila (espera o envio em curso), eventos pendentes, Redis e banco. */
  stop(): Promise<void>
}

export async function startWaWorker(opts: StartWaWorkerOptions = {}): Promise<WaWorkerHandle> {
  const env = opts.env ?? process.env
  const config: WaWorkerConfig = { ...loadWaWorkerConfig(env), ...opts.config }
  const logger = opts.logger ?? createLogger({ level: config.logLevel })
  const cleanups: { name: string; fn: () => unknown }[] = []
  const onStop = (name: string, fn: () => unknown) => cleanups.unshift({ name, fn })
  let stopping: Promise<void> | undefined
  const stopAll = () =>
    (stopping ??= (async () => {
      for (const { name, fn } of cleanups.splice(0)) {
        try {
          await fn()
        } catch (err) {
          logger.warn({ step: name, err: err instanceof Error ? err.message : String(err) }, 'wa-worker: passo do encerramento falhou')
        }
      }
    })())

  try {
    const cipher = createCipher({ key: env.CREDENTIALS_KEY! })

    const db = createDb(config.databaseUrl)
    onStop('db', () => db.$client.end())
    await runMigrations(db, { set: 'wa' })

    const redis = redisConnection({ url: config.redisUrl, maxRetriesPerRequest: 3 })
    redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis error'))
    onStop('redis', () => redis.quit())

    const blobStore = new FsBlobStore({ dir: config.storageDir })
    const fake = config.transport === 'fake' ? new FakeControl({ redis, prefix: config.queuePrefix, logger }) : undefined
    if (fake) logger.warn({ wa_transport: 'fake' }, 'WA_TRANSPORT=fake: FakeTransport em uso (somente testes)')
    const baseFactory: TransportFactory = opts.transportFactory ?? fake?.factory ?? (() => new BaileysTransport())
    const transportFactory: TransportFactory = (sessionId) => {
      const t = baseFactory(sessionId)
      // O deliver precisa da sessão do transporte (antiban por sessão e sinal de 403).
      bindTransportSession(t, sessionId)
      return t
    }

    const limits = new SessionLimitsService(db)
    const antiban = createAntibanAdapter({ env, mode: config.antibanMode, logger })
    const monitorRef: { current?: HealthMonitor } = {}
    const deliver = withBlobRefs(
      createDeliver({
        antiban,
        health: { recordSignal: (id, type, detail) => monitorRef.current?.recordSignal(id, type, detail) },
        limits,
        logger,
      }),
      blobStore,
    )
    const queue = new MessageQueue({ db, connection: { url: config.redisUrl }, prefix: config.queuePrefix, logger, deliver, antiban })

    const monitor = new HealthMonitor({
      db,
      logger,
      queueControl: queue,
      ...(opts.healthIntervalMs !== undefined ? { intervalMs: opts.healthIntervalMs } : {}),
    })
    monitorRef.current = monitor
    onStop('health', () => monitor.stop())

    const manager = new SessionManager({
      db,
      logger,
      cipher,
      transportFactory,
      onConnected: monitor.onConnected,
      onDisconnected: monitor.onDisconnected,
      resumeState: monitor.resumeState,
    })
    monitor.attach(manager)
    // Ordem do encerramento (inversa ao registro): RPC → sockets → fila → outbox → Redis/banco.
    onStop('queue', () => queue.close())
    onStop('queue-attach', attachQueueToSessions(manager, queue, { logger }))

    const media = new MediaService({ blobStore, getTransport: (id) => manager.getTransport(id), logger })
    const outbox = attachEventOutbox(manager, queue, redis, { stream: config.eventsStream, media, logger })
    onStop('outbox', async () => {
      outbox.detach()
      await Promise.race([outbox.flush(), new Promise((r) => setTimeout(r, 5000))])
    })
    onStop('sessions', () => manager.stop())

    // O gate `connected` olha o estado no banco (como o messages.enqueue do ai-manager): numa queda transitória a
    // mensagem é aceita e fica `queued` até a sessão reconectar.
    const pipeline = new SendPipeline({ db, queue, limits })
    const gates = new SendPipeline({ db, limits, gates: { enqueue: async () => undefined } })
    const handlers = createRpcHandlers({
      manager,
      queue,
      pipeline,
      gates,
      consent: pipeline.consent,
      health: monitor,
      media,
      blobStore,
      dedupe: new ClientMessageDedupe(redis, { prefix: config.queuePrefix }),
    })

    const server = await startInternalServer({
      token: config.internalToken,
      handlers,
      ...(fake ? { fake } : {}),
      ...(opts.onShutdown ? { onShutdown: opts.onShutdown } : {}),
      logger,
      port: config.rpcPort,
      host: config.rpcHost,
    })
    onStop('rpc', () => server.close())

    // Reconecta as sessões com credenciais e estado ≠ DISCONNECTED (PAUSED reconecta e continua PAUSED).
    await manager.start()
    logger.info({ url: server.url, port: server.port, transport: config.transport, stream: config.eventsStream }, 'wa-worker pronto')

    return { url: server.url, port: server.port, config, db, manager, queue, monitor, outbox, ...(fake ? { fake } : {}), server, stop: stopAll }
  } catch (err) {
    await stopAll()
    throw err
  }
}

/** SIGTERM/SIGINT → encerramento gracioso e `exit(0)` (1 se falhar). */
export function installShutdownHandlers(worker: Pick<WaWorkerHandle, 'stop'>, logger?: Pick<Logger, 'info' | 'error'>): () => Promise<void> {
  let done: Promise<void> | undefined
  const shutdown = (reason: string) =>
    (done ??= (async () => {
      logger?.info({ reason }, 'wa-worker encerrando')
      try {
        await worker.stop()
        process.exit(0)
      } catch (err) {
        logger?.error({ err: err instanceof Error ? err.message : String(err) }, 'falha no encerramento')
        process.exit(1)
      }
    })())
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
  return () => shutdown('request')
}
