// T47: dedupe do alerta de queda — memória e Redis real (prefixo aleatório no db de teste), relógio injetado.
import { randomBytes } from 'node:crypto'
import { redisConnection } from '@crm/node-kit'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memoryAlertDedupe, redisAlertDedupe, type AlertDedupe } from './dedupe'

let redis: Redis
const prefix = `test:t47:alert:${randomBytes(4).toString('hex')}`

beforeAll(() => {
  redis = redisConnection()
})

afterAll(async () => {
  const keys = await redis.keys(`${prefix}:*`)
  if (keys.length) await redis.del(...keys)
  await redis.quit()
})

const cases: Array<[string, () => AlertDedupe]> = [
  ['memória', () => memoryAlertDedupe()],
  ['Redis', () => redisAlertDedupe(redis, prefix)],
]

describe.each(cases)('dedupe do alerta (%s)', (_name, make) => {
  it('1 alerta por chave dentro da janela; volta a liberar quando a janela passa', async () => {
    const d = make()
    const t0 = 1_760_000_000_000
    expect(await d.claim('c1:disconnected', t0, 5_000)).toBe(true)
    expect(await d.claim('c1:disconnected', t0 + 4_999, 5_000)).toBe(false)
    // outra chave (outra conexão ou outro tipo) não é afetada
    expect(await d.claim('c2:disconnected', t0 + 1, 5_000)).toBe(true)
    expect(await d.claim('c1:banned', t0 + 1, 5_000)).toBe(true)
    expect(await d.claim('c1:disconnected', t0 + 5_000, 5_000)).toBe(true)
    // a janela conta a partir do último alerta ACEITO
    expect(await d.claim('c1:disconnected', t0 + 9_999, 5_000)).toBe(false)
    expect(await d.claim('c1:disconnected', t0 + 10_000, 5_000)).toBe(true)
  })

  it('relógio que volta (outra réplica atrasada) não bloqueia', async () => {
    const d = make()
    const t0 = 1_760_000_100_000
    expect(await d.claim('c3:disconnected', t0, 5_000)).toBe(true)
    expect(await d.claim('c3:disconnected', t0 - 1_000, 5_000)).toBe(true)
  })
})

describe('dedupe Redis entre réplicas', () => {
  it('duas réplicas disputando a mesma queda: só uma alerta', async () => {
    const a = redisAlertDedupe(redis, prefix)
    const b = redisAlertDedupe(redis, prefix)
    const t0 = 1_760_000_200_000
    const r = await Promise.all([a.claim('c4:disconnected', t0, 5_000), b.claim('c4:disconnected', t0, 5_000)])
    expect(r.filter(Boolean)).toHaveLength(1)
  })
})
