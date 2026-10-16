// Publicação de eventos realtime (SPEC 3.7): `XADD crm:rt:<companyId> MAXLEN ~ 10000` (replay por Last-Event-ID)
// + `PUBLISH crm:rt` (fan-out entre réplicas da API). Eventos por usuário vão para `crm:rt:user:<userId>`.
import { REALTIME_EVENTS, type RealtimeEventData, type RealtimeEventType } from '@crm/shared'
import {
  DEFAULT_REALTIME_MAXLEN,
  DEFAULT_REALTIME_PREFIX,
  realtimeKeys,
  type PublishOptions,
  type RealtimeControl,
  type RealtimeEvent,
  type RealtimeRedis,
  type WireEnvelope,
} from './types'

export interface RealtimePublisherOptions {
  redis: RealtimeRedis
  prefix?: string
  maxLen?: number
  now?: () => Date
}

/** Mensagem do canal de fan-out. */
export type FanoutMessage = { k: 'event'; event: RealtimeEvent } | { k: 'control'; control: RealtimeControl }

export class RealtimePublisher {
  private readonly redis: RealtimeRedis
  private readonly keys: ReturnType<typeof realtimeKeys>
  private readonly maxLen: number
  private readonly now: () => Date

  constructor(opts: RealtimePublisherOptions) {
    this.redis = opts.redis
    this.keys = realtimeKeys(opts.prefix ?? DEFAULT_REALTIME_PREFIX)
    this.maxLen = opts.maxLen ?? DEFAULT_REALTIME_MAXLEN
    this.now = opts.now ?? (() => new Date())
  }

  /**
   * Publica um evento do catálogo para a empresa (ou só para `opts.userId`). Valida `type` e `data`
   * no catálogo de @crm/shared e devolve o id do Redis Stream (também o `id:` do SSE).
   */
  async publish<T extends RealtimeEventType>(companyId: string, type: T, data: RealtimeEventData<T>, opts: PublishOptions = {}): Promise<string> {
    const def = (REALTIME_EVENTS as Record<string, { data: { parse(v: unknown): unknown } } | undefined>)[type]
    if (!def) throw new Error(`evento realtime fora do catálogo: ${String(type)}`)
    def.data.parse(data)
    if (!companyId) throw new Error('companyId obrigatório')

    const stream = opts.userId ? this.keys.user(opts.userId) : this.keys.company(companyId)
    const at = this.now().toISOString()
    const scope = opts.scope ?? null
    const fields = ['type', type, 'company_id', companyId, 'at', at, 'data', JSON.stringify(data ?? null)]
    if (scope) fields.push('scope', JSON.stringify(scope))
    if (opts.userId) fields.push('user_id', opts.userId)

    const id = await this.redis.xadd(stream, 'MAXLEN', '~', this.maxLen, '*', ...fields)
    if (!id) throw new Error('XADD não devolveu id')
    const envelope: WireEnvelope = { id, type, company_id: companyId, at, data: data ?? null }
    await this.fanout({ k: 'event', event: { stream, envelope, scope, userId: opts.userId ?? null } })
    return id
  }

  /** Fecha na hora, em todas as réplicas, os streams desta sessão (logout). */
  async endSession(sessionId: string): Promise<void> {
    await this.fanout({ k: 'control', control: { kind: 'end_session', sessionId } })
  }

  /** Fecha todos os streams do usuário (senha trocada, conta removida). */
  async endUserSessions(userId: string): Promise<void> {
    await this.fanout({ k: 'control', control: { kind: 'end_user', userId } })
  }

  private async fanout(message: FanoutMessage): Promise<void> {
    await this.redis.publish(this.keys.channel, JSON.stringify(message))
  }
}

/** Converte uma entrada de `XRANGE` (`[id, [campo, valor, …]]`) no evento. `null` se malformada. */
export function eventFromStreamEntry(stream: string, id: string, flat: string[]): RealtimeEvent | null {
  const f: Record<string, string> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) f[flat[i]!] = flat[i + 1]!
  if (!f.type || !f.company_id || !f.at) return null
  try {
    return {
      stream,
      envelope: { id, type: f.type, company_id: f.company_id, at: f.at, data: f.data ? JSON.parse(f.data) : null },
      scope: f.scope ? JSON.parse(f.scope) : null,
      userId: f.user_id ?? null,
    }
  } catch {
    return null
  }
}
