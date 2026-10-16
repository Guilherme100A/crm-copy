// Hub por processo: UMA conexão Redis em modo subscriber (`redis.duplicate()`) no canal `crm:rt`, que reparte os
// eventos para as conexões SSE locais por stream. Também faz o replay (`XRANGE`) para o `Last-Event-ID`.
import type { Logger } from '@crm/node-kit'
import { eventFromStreamEntry, type FanoutMessage } from './publisher'
import { compareStreamIds } from './stream-id'
import { DEFAULT_REALTIME_PREFIX, realtimeKeys, type RealtimeControl, type RealtimeEvent, type RealtimeRedis } from './types'

export interface RealtimeHubOptions {
  /** Conexão de comandos (XRANGE/XINFO). O subscriber é criado com `redis.duplicate()`. */
  redis: RealtimeRedis
  prefix?: string
  logger?: Pick<Logger, 'warn' | 'error'>
  /** Máximo de eventos reenviados num replay. */
  replayLimit?: number
}

export interface ReplayResult {
  events: RealtimeEvent[]
  /** O histórico já foi aparado além do `Last-Event-ID`: o cliente deve ressincronizar. */
  truncated: boolean
}

type EventListener = (event: RealtimeEvent) => void
type ControlListener = (control: RealtimeControl) => void

export class RealtimeHub {
  readonly keys: ReturnType<typeof realtimeKeys>
  private readonly redis: RealtimeRedis
  private readonly logger?: RealtimeHubOptions['logger']
  private readonly replayLimit: number
  private subscriber: RealtimeRedis | null = null
  private starting: Promise<void> | null = null
  private closed = false
  private readonly byStream = new Map<string, Set<EventListener>>()
  private readonly controls = new Set<ControlListener>()

  constructor(opts: RealtimeHubOptions) {
    this.redis = opts.redis
    this.keys = realtimeKeys(opts.prefix ?? DEFAULT_REALTIME_PREFIX)
    this.logger = opts.logger
    this.replayLimit = opts.replayLimit ?? 10_000
  }

  /** Abre o subscriber (idempotente). Resolve depois do SUBSCRIBE confirmado: nada publicado depois se perde. */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('RealtimeHub fechado'))
    this.starting ??= (async () => {
      const sub = this.redis.duplicate()
      this.subscriber = sub
      sub.on('error', (err: unknown) => this.logger?.warn({ err }, 'realtime subscriber error'))
      sub.on('message', (channel: string, raw: string) => {
        if (channel === this.keys.channel) this.dispatch(raw)
      })
      await sub.subscribe(this.keys.channel)
    })().catch((err: unknown) => {
      this.starting = null
      throw err
    })
    return this.starting
  }

  /** Assina eventos dos streams dados; devolve a função para cancelar. */
  subscribe(streams: readonly string[], listener: EventListener): () => void {
    for (const s of streams) {
      let set = this.byStream.get(s)
      if (!set) this.byStream.set(s, (set = new Set()))
      set.add(listener)
    }
    return () => {
      for (const s of streams) {
        const set = this.byStream.get(s)
        set?.delete(listener)
        if (set?.size === 0) this.byStream.delete(s)
      }
    }
  }

  onControl(listener: ControlListener): () => void {
    this.controls.add(listener)
    return () => {
      this.controls.delete(listener)
    }
  }

  /** Eventos dos streams com id > `afterId`, em ordem de id. */
  async replay(streams: readonly string[], afterId: string): Promise<ReplayResult> {
    const events: RealtimeEvent[] = []
    let truncated = false
    for (const stream of streams) {
      const entries = (await this.redis.xrange(stream, `(${afterId}`, '+', 'COUNT', this.replayLimit)) as Array<[string, string[]]>
      for (const [id, flat] of entries) {
        const ev = eventFromStreamEntry(stream, id, flat)
        if (ev) events.push(ev)
      }
      if (entries.length >= this.replayLimit || (await this.trimmedAfter(stream, afterId))) truncated = true
    }
    events.sort((a, b) => compareStreamIds(a.envelope.id, b.envelope.id))
    return { events, truncated }
  }

  /** Conexões SSE locais assinando algum stream (diagnóstico/testes). */
  get listenerCount(): number {
    let n = 0
    for (const set of this.byStream.values()) n += set.size
    return n
  }

  async close(): Promise<void> {
    this.closed = true
    this.byStream.clear()
    this.controls.clear()
    const sub = this.subscriber
    this.subscriber = null
    this.starting = null
    if (sub) await sub.quit().catch(() => sub.disconnect())
  }

  private dispatch(raw: string) {
    let msg: FanoutMessage
    try {
      msg = JSON.parse(raw) as FanoutMessage
    } catch {
      return
    }
    if (msg.k === 'control') {
      for (const l of [...this.controls]) safe(() => l(msg.control), this.logger)
      return
    }
    if (msg.k !== 'event' || !msg.event?.stream) return
    for (const l of [...(this.byStream.get(msg.event.stream) ?? [])]) safe(() => l(msg.event), this.logger)
  }

  /** `max-deleted-entry-id` (Redis ≥ 7) maior ou igual ao `afterId` = houve corte por MAXLEN depois dele. */
  private async trimmedAfter(stream: string, afterId: string): Promise<boolean> {
    try {
      const info = (await this.redis.xinfo('STREAM', stream)) as unknown[]
      for (let i = 0; i + 1 < info.length; i += 2) {
        if (info[i] === 'max-deleted-entry-id') {
          const v = String(info[i + 1])
          return v !== '0-0' && compareStreamIds(v, afterId) > 0
        }
      }
    } catch {
      // stream inexistente: nada foi cortado
    }
    return false
  }
}

function safe(fn: () => void, logger?: RealtimeHubOptions['logger']) {
  try {
    fn()
  } catch (err) {
    logger?.error({ err }, 'realtime listener failed')
  }
}
