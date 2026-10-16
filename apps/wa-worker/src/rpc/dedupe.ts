// Idempotência do envio por `clientMessageId` (T49/T21): o mesmo (sessão, clientMessageId) devolve a mensagem já
// enfileirada. `public.messages` é igual à do ai-manager (sem coluna para isso), então a marca fica no Redis:
// SET NX 'pending' reserva o id; depois do enqueue grava o id da mensagem. Falha no envio libera a reserva.
import type { Redis } from 'ioredis'
import { RpcError } from './errors'

/** ioredis `Redis` ou um fake com set/get/del nos testes. */
export type DedupeRedis =
  | Pick<Redis, 'set' | 'get' | 'del'>
  | { set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>; get(key: string): Promise<string | null>; del(key: string): Promise<unknown> }

type SetFn = (key: string, value: string, ...args: (string | number)[]) => Promise<unknown>

export const DEFAULT_DEDUPE_TTL_SECONDS = 7 * 24 * 3600
const PENDING = 'pending'

export interface ClientMessageDedupeOptions {
  prefix?: string
  ttlSeconds?: number
  /** Quanto esperar por um envio concorrente com o mesmo id antes de responder CONFLICT. */
  waitMs?: number
  pollMs?: number
}

export class ClientMessageDedupe {
  private readonly prefix: string
  private readonly ttl: number
  private readonly waitMs: number
  private readonly pollMs: number

  constructor(
    private readonly redis: DedupeRedis,
    opts: ClientMessageDedupeOptions = {},
  ) {
    this.prefix = opts.prefix ?? 'wsm'
    this.ttl = opts.ttlSeconds ?? DEFAULT_DEDUPE_TTL_SECONDS
    this.waitMs = opts.waitMs ?? 5000
    this.pollMs = opts.pollMs ?? 50
  }

  private set(...args: Parameters<SetFn>): Promise<unknown> {
    return (this.redis.set as SetFn).apply(this.redis, args)
  }

  key(sessionId: string, clientMessageId: string): string {
    return `${this.prefix}:client-msg:${sessionId}:${clientMessageId}`
  }

  /** Sem `clientMessageId` só envia. Com ele, envia uma vez e devolve a mesma mensagem nas repetições. */
  async run<T extends { id: string }>(
    sessionId: string,
    clientMessageId: string | undefined,
    send: () => Promise<T>,
    lookup: (messageId: string) => Promise<T>,
  ): Promise<T> {
    if (!clientMessageId) return send()
    const key = this.key(sessionId, clientMessageId)
    const reserved = await this.set(key, PENDING, 'EX', this.ttl, 'NX')
    if (reserved) {
      try {
        const message = await send()
        await this.set(key, message.id, 'EX', this.ttl)
        return message
      } catch (err) {
        await this.redis.del(key).catch(() => undefined)
        throw err
      }
    }
    const deadline = Date.now() + this.waitMs
    for (;;) {
      const value = await this.redis.get(key)
      if (value && value !== PENDING) return lookup(value)
      // A reserva expirou ou foi liberada por uma falha: tenta de novo do zero.
      if (value === null) return this.run(sessionId, clientMessageId, send, lookup)
      if (Date.now() > deadline) throw new RpcError('CONFLICT', `envio com clientMessageId ${clientMessageId} ainda em andamento`)
      await new Promise((r) => setTimeout(r, this.pollMs))
    }
  }
}
