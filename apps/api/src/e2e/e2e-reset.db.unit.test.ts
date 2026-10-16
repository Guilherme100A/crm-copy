// T124: reset do harness serializado (dois simultâneos → os dois 200, seed íntegro) e timeout configurável (504 sem
// liberar a fila antes de o reset terminar).
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, SEED_BASE, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { createApp, type RedisClient } from '../app'
import { stopRealtimeHub } from '../routes/events/index'
import { DEFAULT_E2E_RESET_TIMEOUT_MS, resetTimeoutMs } from './index'

let temp: TempDatabase
let db: Database
let redis: RedisClient
const stream = `e2e-reset:${randomBytes(4).toString('hex')}:wsm:events`
const J = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: 'redis://127.0.0.1:6379/13' })
}, 120_000)
afterAll(async () => {
  await stopRealtimeHub(redis)
  await redis?.del(stream)
  await redis?.quit()
  await db?.$client.end()
  await temp?.drop()
})

const app = () => withEnv({ E2E: '1', WA_EVENTS_STREAM: stream }, () => createApp({ db, redis, logger: createLogger({ level: 'silent' }) }))
const reset = (a: ReturnType<typeof app>) => a.request('/__e2e/reset', { method: 'POST', headers: J })
const owners = () => db.select().from(users).where(eq(users.email, SEED_BASE.users.owner.email))

describe('POST /__e2e/reset (T124)', () => {
  it('três resets simultâneos: todos 200, os seguintes esperam e o seed fica íntegro', async () => {
    const a = app()
    const responses = await Promise.all([reset(a), reset(a), reset(a)])
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<Record<string, unknown>>
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200])
    expect(bodies.every((b) => b.ok === true && typeof b.waited_ms === 'number')).toBe(true)
    expect(Math.max(...bodies.map((b) => b.waited_ms as number))).toBeGreaterThan(0)
    expect(await owners()).toHaveLength(1)
  }, 120_000)

  it('timeout curto → 504 reset_timeout; o reset seguinte espera o anterior e dá 200', async () => {
    const a = app()
    const slow = await withEnv({ E2E_RESET_TIMEOUT_MS: '1' }, () => reset(a))
    expect(slow.status).toBe(504)
    expect(await slow.json()).toMatchObject({ ok: false, error: 'reset_timeout', timeout_ms: 1 })
    const next = await reset(a)
    expect(next.status).toBe(200)
    expect(await owners()).toHaveLength(1)
  }, 120_000)

  it('timeout pelo env, padrão 60 s', () => {
    expect(resetTimeoutMs({})).toBe(DEFAULT_E2E_RESET_TIMEOUT_MS)
    expect(DEFAULT_E2E_RESET_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
    expect(resetTimeoutMs({ E2E_RESET_TIMEOUT_MS: '90000' })).toBe(90_000)
    expect(resetTimeoutMs({ E2E_RESET_TIMEOUT_MS: 'x' })).toBe(DEFAULT_E2E_RESET_TIMEOUT_MS)
  })
})
