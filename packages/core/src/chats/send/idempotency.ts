// Idempotência do envio por `Idempotency-Key` (AC-T49-01): a 1ª requisição reserva a chave; as repetições recebem
// a mesma mensagem e nunca chamam o gateway de novo. Guardada no Redis (24 h), sem tabela.
import type { Redis } from 'ioredis'

export type IdempotencyClaim = { state: 'new' } | { state: 'done'; messageId: string } | { state: 'pending' }

export interface IdempotencyStore {
  /** Reserva a chave; se já existe, diz em que pé está. */
  claim(key: string): Promise<IdempotencyClaim>
  /** Conclui com a mensagem criada. */
  complete(key: string, messageId: string): Promise<void>
  /** Libera a chave (a requisição falhou antes de criar algo; pode tentar de novo). */
  release(key: string): Promise<void>
}

const PENDING = '__pending__'
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly redis: Pick<Redis, 'set' | 'get' | 'del'>,
    private readonly prefix = 'crm:idem:send:',
    private readonly ttlMs = IDEMPOTENCY_TTL_MS,
  ) {}

  async claim(key: string): Promise<IdempotencyClaim> {
    const ok = await this.redis.set(this.prefix + key, PENDING, 'PX', this.ttlMs, 'NX')
    if (ok === 'OK') return { state: 'new' }
    const value = await this.redis.get(this.prefix + key)
    if (!value) return this.claim(key) // expirou entre o SET e o GET
    return value === PENDING ? { state: 'pending' } : { state: 'done', messageId: value }
  }

  async complete(key: string, messageId: string): Promise<void> {
    await this.redis.set(this.prefix + key, messageId, 'PX', this.ttlMs)
  }

  async release(key: string): Promise<void> {
    await this.redis.del(this.prefix + key)
  }
}

/** Em memória (testes). */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, string>()

  async claim(key: string): Promise<IdempotencyClaim> {
    const v = this.map.get(key)
    if (v === undefined) {
      this.map.set(key, PENDING)
      return { state: 'new' }
    }
    return v === PENDING ? { state: 'pending' } : { state: 'done', messageId: v }
  }

  async complete(key: string, messageId: string): Promise<void> {
    this.map.set(key, messageId)
  }

  async release(key: string): Promise<void> {
    this.map.delete(key)
  }
}
