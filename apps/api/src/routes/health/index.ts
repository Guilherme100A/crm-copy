// GET /health (AC-T08-01): público, sempre 200, com o estado de db e redis (timeout por check).
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppDeps, AppEnv } from '../../lib/types'

export type CheckStatus = 'ok' | 'down'

/** Roda `check` com timeout; qualquer erro ou demora vira `down`. */
export async function probe(check: () => Promise<unknown>, timeoutMs: number): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
  })
  try {
    await Promise.race([check(), timeout])
    return 'ok'
  } catch {
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}

export function healthRoutes(deps: Pick<AppDeps, 'db' | 'redis' | 'healthTimeoutMs'>) {
  const timeoutMs = deps.healthTimeoutMs ?? 1000
  return new Hono<AppEnv>().get('/health', async (c) => {
    const [db, redis] = await Promise.all([
      probe(() => deps.db.execute(sql`select 1`), timeoutMs),
      probe(() => deps.redis.ping(), timeoutMs),
    ])
    const status = db === 'ok' && redis === 'ok' ? 'ok' : 'degraded'
    return c.json({ status, db, redis }, 200)
  })
}
