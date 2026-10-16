// Consumidor do Redis Stream `wsm:events` (SPEC 3.8/3.9, AI-MANAGER-MAP §13.4): consumer group `crm`, XACK só
// após sucesso, XAUTOCLAIM de pendentes ociosos, DLQ após N entregas com falha e idempotência por chave do evento.
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { runOnce, waEventKey, type Transaction } from '@crm/core'
import type { Database } from '@crm/db'
import { redisConnection } from '@crm/node-kit'
import { safeParseWaEvent, WA_EVENTS_STREAM, type WaEvent, type WaEventOf, type WaEventType } from '@crm/wa-port'
import type { Redis } from 'ioredis'

export const DEFAULT_CONSUMER_GROUP = 'crm'
export const DEFAULT_DLQ_STREAM = 'crm:wa-events:dlq'
export const DEFAULT_CLAIM_IDLE_MS = 60_000
export const DEFAULT_MAX_DELIVERIES = 5
/** Campo da entrada do stream com o JSON do WaEvent (`XADD wsm:events * event '<json>'`). */
export const WA_EVENT_FIELD = 'event'

export interface ConsumerLogger {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface EventContext {
  /** Id da entrada no stream (muda a cada XADD; não serve para idempotência). */
  streamId: string
  /** Quantas vezes esta entrada já foi entregue ao grupo (1 na primeira). */
  deliveries: number
  /** Chave de idempotência derivada do payload (`waEventKey`). */
  eventKey: string
  /** Transação em que a marca de idempotência é gravada (só com `db`). Efeitos no banco devem usá-la. */
  tx?: Transaction
}

export type EventHandler<T extends WaEventType = WaEventType> = (event: WaEventOf<T>, ctx: EventContext) => Promise<void> | void

export interface HandlerOptions {
  /** Identifica o handler na idempotência (`crm.processed_events.consumer = <group>:<id>`). Default: o `type`. */
  id?: string
}

export interface StreamConsumerOptions {
  /** Instância ioredis (não é fechada no stop) ou URL (conexão própria). Default: `REDIS_URL`. */
  redis?: Redis | string
  /** Liga a idempotência em `crm.processed_events`. */
  db?: Database
  stream?: string
  group?: string
  /** Nome deste consumidor no grupo. Default `<host>-<pid>-<rand>`. */
  consumer?: string
  dlqStream?: string
  /** Ociosidade mínima para reclamar entradas pendentes (XAUTOCLAIM). Default 60 s. */
  claimIdleMs?: number
  /** Intervalo entre rodadas de reclaim. Default `claimIdleMs / 2`. */
  claimIntervalMs?: number
  /** Entregas com falha até ir para a DLQ. Default 5. */
  maxDeliveries?: number
  /** BLOCK do XREADGROUP (limita a latência do stop). Default 1000 ms. */
  blockMs?: number
  batchSize?: number
  /** Posição inicial ao criar o grupo. Default `'0'`: eventos anteriores ao primeiro start também são lidos. */
  startId?: string
  logger?: ConsumerLogger
}

interface Registered {
  id: string
  handler: EventHandler
}

type StreamEntry = [id: string, fields: string[]]

const noopLogger: ConsumerLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Valor do campo `event` (ou o único campo da entrada). */
function rawEvent(fields: string[]): string | undefined {
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === WA_EVENT_FIELD) return fields[i + 1]
  return fields.length === 2 ? fields[1] : undefined
}

export class StreamConsumer {
  readonly stream: string
  readonly group: string
  readonly consumer: string
  readonly dlqStream: string
  private readonly handlers = new Map<string, Registered[]>()
  private readonly claimIdleMs: number
  private readonly claimIntervalMs: number
  private readonly maxDeliveries: number
  private readonly blockMs: number
  private readonly batchSize: number
  private readonly startId: string
  private readonly logger: ConsumerLogger
  private readonly db: Database | undefined
  private readonly redisInput: Redis | string | undefined
  private redis: Redis | undefined
  private reader: Redis | undefined
  private ownsRedis = false
  private running = false
  private loop: Promise<void> | undefined
  private nextClaimAt = 0

  constructor(opts: StreamConsumerOptions = {}) {
    this.stream = opts.stream ?? WA_EVENTS_STREAM
    this.group = opts.group ?? DEFAULT_CONSUMER_GROUP
    this.consumer = opts.consumer ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
    this.dlqStream = opts.dlqStream ?? DEFAULT_DLQ_STREAM
    this.claimIdleMs = opts.claimIdleMs ?? DEFAULT_CLAIM_IDLE_MS
    this.claimIntervalMs = opts.claimIntervalMs ?? Math.max(10, Math.floor(this.claimIdleMs / 2))
    this.maxDeliveries = opts.maxDeliveries ?? DEFAULT_MAX_DELIVERIES
    this.blockMs = opts.blockMs ?? 1000
    this.batchSize = opts.batchSize ?? 10
    this.startId = opts.startId ?? '0'
    this.logger = opts.logger ?? noopLogger
    this.db = opts.db
    this.redisInput = opts.redis
  }

  /** Registra um handler para o `type`. Vários handlers por tipo rodam em ordem; cada um tem idempotência própria. */
  on<T extends WaEventType>(type: T, handler: EventHandler<T>, opts: HandlerOptions = {}): this {
    const id = opts.id ?? type
    const list = this.handlers.get(type) ?? []
    if (list.some((h) => h.id === id)) throw new Error(`handler "${id}" já registrado para ${type}`)
    list.push({ id, handler: handler as unknown as EventHandler })
    this.handlers.set(type, list)
    return this
  }

  get isRunning(): boolean {
    return this.running
  }

  async start(): Promise<void> {
    if (this.running) return
    if (typeof this.redisInput === 'object') {
      this.redis = this.redisInput
    } else {
      this.redis = redisConnection(this.redisInput ? { url: this.redisInput } : {})
      this.ownsRedis = true
    }
    // Comando bloqueante numa conexão só dele: não trava os XACK/XADD da conexão principal.
    this.reader = this.redis.duplicate()
    await this.ensureGroup()
    this.running = true
    this.nextClaimAt = 0
    this.loop = this.run()
  }

  /** Para de ler, espera o lote em andamento terminar e fecha as conexões próprias. */
  async stop(): Promise<void> {
    if (!this.loop) return
    this.running = false
    await this.loop.catch(() => undefined)
    this.loop = undefined
    await this.reader?.quit().catch(() => undefined)
    this.reader = undefined
    if (this.ownsRedis) await this.redis?.quit().catch(() => undefined)
    this.redis = undefined
    this.ownsRedis = false
  }

  private async ensureGroup(): Promise<void> {
    try {
      await this.redis!.xgroup('CREATE', this.stream, this.group, this.startId, 'MKSTREAM')
    } catch (err) {
      if (!errorMessage(err).includes('BUSYGROUP')) throw err
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (Date.now() >= this.nextClaimAt) {
          await this.reclaim()
          this.nextClaimAt = Date.now() + this.claimIntervalMs
        }
        if (!this.running) break
        const block = Math.max(1, Math.min(this.blockMs, this.nextClaimAt - Date.now()))
        const res = (await this.reader!.xreadgroup(
          'GROUP',
          this.group,
          this.consumer,
          'COUNT',
          this.batchSize,
          'BLOCK',
          block,
          'STREAMS',
          this.stream,
          '>',
        )) as [string, StreamEntry[]][] | null
        for (const [, entries] of res ?? []) {
          for (const [id, fields] of entries) await this.handle(id, fields, 1)
        }
      } catch (err) {
        if (!this.running) break
        this.logger.error({ err: errorMessage(err), stream: this.stream }, 'falha no laço do consumidor')
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }

  /** Reclama entradas pendentes ociosas (de qualquer consumidor do grupo, inclusive deste) e reprocessa. */
  private async reclaim(): Promise<void> {
    let cursor = '0-0'
    do {
      const [next, entries] = (await this.redis!.xautoclaim(
        this.stream,
        this.group,
        this.consumer,
        this.claimIdleMs,
        cursor,
        'COUNT',
        this.batchSize,
      )) as [string, (StreamEntry | null)[], ...unknown[]]
      for (const entry of entries) {
        if (!entry) continue
        const [id, fields] = entry
        await this.handle(id, fields ?? [], await this.deliveryCount(id))
      }
      cursor = next
    } while (cursor !== '0-0' && this.running)
  }

  private async deliveryCount(id: string): Promise<number> {
    const rows = (await this.redis!.xpending(this.stream, this.group, id, id, 1)) as [string, string, number, number][]
    return Number(rows[0]?.[3] ?? 1)
  }

  private async handle(id: string, fields: string[], deliveries: number): Promise<void> {
    const raw = rawEvent(fields)
    const parsed = safeParseWaEvent(raw ?? '')
    if (!parsed.success) {
      this.logger.warn({ streamId: id, err: parsed.error.message }, 'evento inválido enviado à DLQ')
      await this.deadLetter(id, raw ?? '', parsed.error.message, deliveries)
      return
    }
    const event = parsed.data
    const handlers = this.handlers.get(event.type) ?? []
    const eventKey = waEventKey(event)
    try {
      for (const h of handlers) await this.invoke(h, event, { streamId: id, deliveries, eventKey })
      await this.redis!.xack(this.stream, this.group, id)
    } catch (err) {
      const message = errorMessage(err)
      if (deliveries >= this.maxDeliveries) {
        this.logger.error({ streamId: id, type: event.type, deliveries, err: message }, 'evento enviado à DLQ')
        await this.deadLetter(id, raw ?? '', message, deliveries)
      } else {
        this.logger.warn({ streamId: id, type: event.type, deliveries, err: message }, 'falha no handler; o evento será reprocessado')
      }
    }
  }

  private async invoke(h: Registered, event: WaEvent, ctx: EventContext): Promise<void> {
    if (!this.db) {
      await h.handler(event, ctx)
      return
    }
    await runOnce(this.db, `${this.group}:${h.id}`, ctx.eventKey, (tx) => h.handler(event, { ...ctx, tx }))
  }

  private async deadLetter(id: string, raw: string, error: string, deliveries: number): Promise<void> {
    await this.redis!.xadd(
      this.dlqStream,
      '*',
      WA_EVENT_FIELD,
      raw,
      'error',
      error,
      'stream',
      this.stream,
      'stream_id',
      id,
      'group',
      this.group,
      'deliveries',
      String(deliveries),
    )
    await this.redis!.xack(this.stream, this.group, id)
  }
}
