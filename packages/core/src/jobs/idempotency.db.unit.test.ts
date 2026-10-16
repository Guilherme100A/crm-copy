// Postgres real (SPEC 3.10): banco descartável migrado.
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isProcessed, runOnce } from './idempotency'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

describe('runOnce', () => {
  it('executa uma vez por (consumer, event_key)', async () => {
    let n = 0
    expect(await runOnce(db, 'c1', 'k1', () => ++n)).toEqual({ executed: true, result: 1 })
    expect(await runOnce(db, 'c1', 'k1', () => ++n)).toEqual({ executed: false })
    expect(await runOnce(db, 'c2', 'k1', () => ++n)).toEqual({ executed: true, result: 2 })
    expect(await isProcessed(db, 'c1', 'k1')).toBe(true)
  })

  it('falha no efeito não marca o evento (reprocessa depois)', async () => {
    await expect(
      runOnce(db, 'c1', 'k-fail', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await isProcessed(db, 'c1', 'k-fail')).toBe(false)
    expect(await runOnce(db, 'c1', 'k-fail', () => 'ok')).toEqual({ executed: true, result: 'ok' })
  })

  it('execuções concorrentes da mesma chave rodam o efeito uma vez', async () => {
    let n = 0
    const slow = () => new Promise<number>((resolve) => setTimeout(() => resolve(++n), 50))
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => runOnce(db, 'c1', 'k-race', slow)))
    expect(results.filter((r) => r.executed)).toHaveLength(1)
    expect(n).toBe(1)
  })
})
