import { afterEach, describe, expect, it } from 'vitest'
import { bullConnection, parseRedisUrl, redisConnection } from './redis'

describe('Redis/BullMQ (AC-T05-06)', () => {
  const original = process.env.REDIS_URL
  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = original
  })

  it('bullConnection: maxRetriesPerRequest null e db da REDIS_URL', () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379/1'
    const opts = bullConnection()
    expect(opts.maxRetriesPerRequest).toBeNull()
    expect(opts.db).toBe(1)
    expect(opts.host).toBe('127.0.0.1')
    expect(opts.port).toBe(6379)
  })

  it('bullConnection com url explícita e overrides não perde o null', () => {
    const opts = bullConnection({ url: 'redis://h:7000/5', maxRetriesPerRequest: 3 })
    expect(opts).toMatchObject({ host: 'h', port: 7000, db: 5, maxRetriesPerRequest: null })
  })

  it('parseRedisUrl: credenciais, tls e db inválido', () => {
    expect(parseRedisUrl('rediss://u:p%40ss@h:1/2')).toEqual({
      host: 'h',
      port: 1,
      db: 2,
      username: 'u',
      password: 'p@ss',
      tls: {},
    })
    expect(parseRedisUrl('redis://h')).toEqual({ host: 'h', port: 6379 })
    expect(() => parseRedisUrl('redis://h/x')).toThrow()
    expect(() => parseRedisUrl('http://h')).toThrow()
  })

  it('redisConnection aplica o db da URL (sem conectar)', async () => {
    const r = redisConnection({ url: 'redis://127.0.0.1:6379/3', lazyConnect: true })
    expect(r.options.db).toBe(3)
    r.disconnect()
  })
})
