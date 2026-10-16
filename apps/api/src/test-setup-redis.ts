// T126: Redis isolado para testes que apagam chaves em massa (reset do harness E2E apaga `crm:*` no db inteiro).
// Reserva um db LIVRE (2..15) pela mesma reserva dos harnesses (T122/T124, `scripts/e2e/redis-claim.mjs`, chave
// `e2e:harness:owner` com TTL renovado): não colide com outra execução de testes nem com um harness vivo.
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { RedisClient } from './lib/types'

interface ClaimModule {
  claimRedisDb(baseUrl: string, firstDb: number, root: string, pid?: number, key?: string, info?: Record<string, unknown>): Promise<{ url: string; db: number; release(): Promise<void> }>
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export interface TestRedisClaim {
  /** URL com o db reservado. */
  url: string
  db: number
  release(): Promise<void>
}

/**
 * Reserva um db do Redis só deste arquivo de teste. O candidato inicial vem do hash do arquivo (espalha os testes);
 * `release()` no `afterAll`, depois de fechar as conexões.
 */
export async function claimTestRedisDb(testPath: string | undefined, baseUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'): Promise<TestRedisClaim> {
  const mod = (await import(pathToFileURL(resolve(repoRoot, 'scripts/e2e/redis-claim.mjs')).href)) as ClaimModule
  const tag = testPath ?? `pid-${process.pid}`
  const first = 2 + (parseInt(createHash('sha1').update(tag).digest('hex').slice(0, 4), 16) % 14)
  return mod.claimRedisDb(baseUrl, first, `vitest:${tag}`, process.pid, undefined, { test: tag })
}

/** Apaga as chaves `crm:*` do db (exclusivo deste arquivo): o estado inicial não depende de execuções anteriores. */
export async function clearCrmKeys(redis: RedisClient): Promise<void> {
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'crm:*', 'COUNT', 500)
    if (keys.length) await redis.del(...keys)
    cursor = next
  } while (cursor !== '0')
}
