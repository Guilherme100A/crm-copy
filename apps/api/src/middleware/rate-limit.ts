// Limite de taxa por rota (Redis, janela fixa). Excedido → 429 RATE_LIMIT com `Retry-After`.
import type { Context, MiddlewareHandler } from 'hono'
import { clientIp } from '../lib/context'
import { ApiError } from '../lib/errors'
import { RateLimiter } from '../lib/rate-limiter'
import type { AppEnv, RedisClient } from '../lib/types'

export interface RateLimitOptions {
  redis: RedisClient
  limit: number
  windowMs: number
  /** Nome do limite (entra na chave). */
  name: string
  /** Chave do cliente (default: usuário autenticado, senão IP). */
  key?: (c: Context<AppEnv>) => string | Promise<string>
  trustProxy?: boolean
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const limiter = new RateLimiter({ redis: opts.redis, limit: opts.limit, windowMs: opts.windowMs, prefix: `crm:rl:${opts.name}` })
  const keyOf =
    opts.key ?? ((c: Context<AppEnv>) => c.get('ctx')?.user?.id ?? c.get('ctx')?.auth.tokenId ?? clientIp(c, opts.trustProxy) ?? 'anon')
  return async (c, next) => {
    const r = await limiter.hit(await keyOf(c))
    c.header('RateLimit-Limit', String(r.limit))
    c.header('RateLimit-Remaining', String(Math.max(0, r.limit - r.count)))
    if (!r.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(r.resetMs / 1000))))
      throw new ApiError('RATE_LIMIT', 'Muitas requisições; tente novamente mais tarde')
    }
    return next()
  }
}
