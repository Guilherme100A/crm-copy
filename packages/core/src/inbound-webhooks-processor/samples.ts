// Escuta de amostra (T81; 09 §2, §4, §7): o usuário que "escuta" um webhook fica registrado por 90 s num hash Redis
// `crm:iw:listen:<webhookId>` (userId → expira em ms). O processador, ao pegar um request desse webhook, publica
// `webhook.sample_received` SÓ no stream de cada ouvinte válido e remove o ouvinte (a escuta dispara uma vez).
import type { Redis } from 'ioredis'

export const SAMPLE_LISTEN_TTL_MS = 90_000
export const sampleListenKey = (webhookId: string, prefix = 'crm:iw:listen') => `${prefix}:${webhookId}`

export type SampleRedis = Pick<Redis, 'hset' | 'hgetall' | 'hdel' | 'pexpire'>

export class SampleListeners {
  constructor(
    private readonly redis: SampleRedis,
    private readonly opts: { prefix?: string; now?: () => Date; ttlMs?: number } = {},
  ) {}

  private now() {
    return (this.opts.now?.() ?? new Date()).getTime()
  }

  private key(webhookId: string) {
    return sampleListenKey(webhookId, this.opts.prefix)
  }

  /** Registra (ou renova) a escuta do usuário; devolve quando expira. */
  async listen(webhookId: string, userId: string): Promise<Date> {
    const ttl = this.opts.ttlMs ?? SAMPLE_LISTEN_TTL_MS
    const expires = this.now() + ttl
    await this.redis.hset(this.key(webhookId), userId, String(expires))
    await this.redis.pexpire(this.key(webhookId), ttl + 5_000)
    return new Date(expires)
  }

  async stop(webhookId: string, userId: string): Promise<void> {
    await this.redis.hdel(this.key(webhookId), userId)
  }

  /** Ouvintes válidos do webhook, já removidos (cada escuta recebe uma amostra só). Expirados são limpos. */
  async take(webhookId: string): Promise<string[]> {
    const all = await this.redis.hgetall(this.key(webhookId))
    const entries = Object.entries(all ?? {})
    if (!entries.length) return []
    await this.redis.hdel(this.key(webhookId), ...entries.map(([u]) => u))
    const now = this.now()
    return entries.filter(([, exp]) => Number(exp) >= now).map(([u]) => u)
  }
}
