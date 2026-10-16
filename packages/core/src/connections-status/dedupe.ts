// Dedupe dos alertas de queda (T47, AC-T47-01): no máximo 1 alerta por (conexão, tipo) dentro da janela. O instante
// vem de quem chama (relógio injetável); o Redis só guarda o último instante aceito, comparado de forma atômica.

export interface AlertDedupe {
  /** `true` = pode alertar agora (e marca `nowMs`); `false` = já houve alerta há menos de `windowMs`. */
  claim(key: string, nowMs: number, windowMs: number): Promise<boolean>
}

/** O que o dedupe usa do ioredis. */
export interface DedupeRedis {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>
}

export const ALERT_DEDUPE_PREFIX = 'crm:connections:alert'

// KEYS[1] = chave; ARGV = agora (ms), janela (ms), TTL de limpeza (ms). Relógio que volta (outra réplica) não bloqueia.
const CLAIM_LUA = `
local last = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[1])
if last then
  local d = now - tonumber(last)
  if d >= 0 and d < tonumber(ARGV[2]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
return 1`

/** Dedupe compartilhado entre réplicas do worker. */
export function redisAlertDedupe(redis: DedupeRedis, prefix = ALERT_DEDUPE_PREFIX): AlertDedupe {
  return {
    async claim(key, nowMs, windowMs) {
      const ttl = Math.max(60_000, windowMs * 12)
      return Number(await redis.eval(CLAIM_LUA, 1, `${prefix}:${key}`, nowMs, windowMs, ttl)) === 1
    },
  }
}

/** Dedupe do processo (testes e uso sem Redis). */
export function memoryAlertDedupe(): AlertDedupe {
  const last = new Map<string, number>()
  return {
    async claim(key, nowMs, windowMs) {
      const prev = last.get(key)
      if (prev !== undefined && nowMs - prev >= 0 && nowMs - prev < windowMs) return false
      last.set(key, nowMs)
      return true
    },
  }
}
