// Limitador de taxa em janela fixa no Redis (INCR + PEXPIRE). Base do middleware `rateLimit` e de contadores
// de falha (ex.: login, 10 falhas/15 min por IP+e-mail — T15). Redis indisponível → não bloqueia (fail-open).
import type { RedisClient } from './types'

export interface RateLimiterOptions {
  redis: RedisClient
  /** Máximo de hits por janela. */
  limit: number
  windowMs: number
  /** Prefixo das chaves (default `crm:rl`). */
  prefix?: string
}

export interface RateLimitResult {
  allowed: boolean
  count: number
  limit: number
  /** Milissegundos até a janela reiniciar. */
  resetMs: number
}

export class RateLimiter {
  readonly limit: number
  readonly windowMs: number
  private readonly redis: RedisClient
  private readonly prefix: string

  constructor(opts: RateLimiterOptions) {
    if (!(opts.limit > 0) || !(opts.windowMs > 0)) throw new Error('rate limit: limit e windowMs devem ser > 0')
    this.redis = opts.redis
    this.limit = opts.limit
    this.windowMs = opts.windowMs
    this.prefix = opts.prefix ?? 'crm:rl'
  }

  private key(k: string): string {
    return `${this.prefix}:${k}`
  }

  /** Conta um hit e diz se ainda está dentro do limite. */
  async hit(k: string): Promise<RateLimitResult> {
    const key = this.key(k)
    try {
      const count = await this.redis.incr(key)
      if (count === 1) await this.redis.pexpire(key, this.windowMs)
      let ttl = await this.redis.pttl(key)
      if (ttl < 0) {
        await this.redis.pexpire(key, this.windowMs)
        ttl = this.windowMs
      }
      return { allowed: count <= this.limit, count, limit: this.limit, resetMs: ttl }
    } catch {
      return { allowed: true, count: 0, limit: this.limit, resetMs: 0 }
    }
  }

  /** Estado atual sem contar hit. */
  async peek(k: string): Promise<RateLimitResult> {
    const key = this.key(k)
    try {
      const [raw, ttl] = await Promise.all([this.redis.get(key), this.redis.pttl(key)])
      const count = raw ? Number(raw) : 0
      return { allowed: count < this.limit, count, limit: this.limit, resetMs: Math.max(0, ttl) }
    } catch {
      return { allowed: true, count: 0, limit: this.limit, resetMs: 0 }
    }
  }

  async reset(k: string): Promise<void> {
    try {
      await this.redis.del(this.key(k))
    } catch {
      // fail-open
    }
  }
}
