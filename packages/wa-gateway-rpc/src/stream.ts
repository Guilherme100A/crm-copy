// `subscribe` do gateway RPC: acompanha o Redis Stream `wsm:events` (XREAD BLOCK, sem consumer group) e entrega cada
// WaEvent v1 válido aos assinantes, em ordem. É fan-out "ao vivo": não reconhece (XACK) nem rouba entregas do grupo
// `crm`, que é o consumo durável do worker (StreamConsumer, T09).
// Início da leitura: o id do stream vem do relógio do Redis, que pode estar à frente ou atrás do deste processo.
// Por isso o laço começa um pouco antes (`lookbackMs`) e cada assinante só recebe eventos com `at` (instante em que
// o produtor criou o evento) ≥ o instante da sua assinatura.
import { safeParseWaEvent, WA_EVENTS_STREAM, type WaEvent, type WaEventListener } from '@crm/wa-port'
import { redisConnection } from '@crm/node-kit'
import type { Redis } from 'ioredis'

/** Campo da entrada com o JSON do evento (`XADD wsm:events * event '<json>'`, wa-engine/events/outbox.ts). */
export const STREAM_EVENT_FIELD = 'event'

export interface StreamLogger {
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface EventStreamTailOptions {
  /** Instância ioredis (é duplicada: o XREAD bloqueante usa conexão própria) ou URL. */
  redis: Redis | string
  stream?: string
  /** BLOCK do XREAD (limita a latência do unsubscribe/close). Default 1000 ms. */
  blockMs?: number
  batchSize?: number
  /** Folga para a diferença de relógio com o Redis ao começar a ler. Default 2000 ms. */
  lookbackMs?: number
  logger?: StreamLogger
  now?: () => number
}

type Entry = [id: string, fields: string[]]

/** Normaliza a resposta do XREAD: RESP2 `[[stream, entries]]` ou RESP3 (Map/objeto `{ stream: entries }`). */
export function xreadEntries(reply: unknown): Entry[] {
  if (!reply) return []
  if (reply instanceof Map) return [...reply.values()].flat() as Entry[]
  if (Array.isArray(reply)) return reply.flatMap((pair) => (Array.isArray(pair) && Array.isArray(pair[1]) ? (pair[1] as Entry[]) : []))
  if (typeof reply === 'object') return Object.values(reply as Record<string, Entry[]>).flat()
  return []
}

function rawEvent(fields: string[]): string | undefined {
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === STREAM_EVENT_FIELD) return fields[i + 1]
  return fields.length === 2 ? fields[1] : undefined
}

export class EventStreamTail {
  readonly stream: string
  /** Assinante → instante da assinatura (ms). */
  private readonly listeners = new Map<WaEventListener, number>()
  private readonly blockMs: number
  private readonly batchSize: number
  private readonly lookbackMs: number
  private readonly now: () => number
  private reader: Redis | undefined
  private loop: Promise<void> | undefined
  private lastId = '$'
  private closed = false

  constructor(private readonly opts: EventStreamTailOptions) {
    this.stream = opts.stream ?? WA_EVENTS_STREAM
    this.blockMs = opts.blockMs ?? 1000
    this.batchSize = opts.batchSize ?? 100
    this.lookbackMs = opts.lookbackMs ?? 2000
    this.now = opts.now ?? Date.now
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  subscribe(listener: WaEventListener): () => void {
    if (this.closed) throw new Error('gateway fechado: subscribe indisponível')
    const since = this.now()
    if (!this.loop) this.lastId = `${Math.max(0, since - this.lookbackMs)}-0`
    // A mesma função assinada duas vezes conta uma vez (como um Set), com o instante da primeira assinatura.
    if (!this.listeners.has(listener)) this.listeners.set(listener, since)
    this.loop ??= this.run().finally(() => {
      this.loop = undefined
    })
    return () => {
      this.listeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.listeners.clear()
    // disconnect (não quit): derruba o XREAD bloqueado na hora.
    this.reader?.disconnect()
    await this.loop?.catch(() => undefined)
    this.reader = undefined
  }

  private connection(): Redis {
    if (!this.reader) {
      const r = this.opts.redis
      this.reader = typeof r === 'string' ? redisConnection({ url: r, maxRetriesPerRequest: null }) : r.duplicate()
    }
    return this.reader
  }

  private async run(): Promise<void> {
    // Sem assinantes o laço termina; o próximo subscribe recomeça com a folga a partir de "agora".
    while (this.listeners.size > 0 && !this.closed) {
      let entries: Entry[]
      try {
        const reply = await this.connection().xread('COUNT', this.batchSize, 'BLOCK', this.blockMs, 'STREAMS', this.stream, this.lastId)
        entries = xreadEntries(reply)
      } catch (err) {
        if (this.closed) return
        this.opts.logger?.error({ err: err instanceof Error ? err.message : String(err), stream: this.stream }, 'falha ao ler o stream de eventos')
        await new Promise((resolve) => setTimeout(resolve, 200))
        continue
      }
      for (const [id, fields] of entries) {
        this.lastId = id
        const parsed = safeParseWaEvent(rawEvent(fields) ?? '')
        if (!parsed.success) {
          this.opts.logger?.warn({ streamId: id, err: parsed.error.message }, 'evento inválido ignorado')
          continue
        }
        await this.deliver(parsed.data)
      }
    }
  }

  private async deliver(event: WaEvent): Promise<void> {
    const at = Date.parse(event.at)
    for (const [listener, since] of [...this.listeners]) {
      if (!this.listeners.has(listener) || at < since) continue
      try {
        await listener(event)
      } catch (err) {
        this.opts.logger?.error({ err: err instanceof Error ? err.message : String(err), type: event.type }, 'assinante de eventos falhou')
      }
    }
  }
}
