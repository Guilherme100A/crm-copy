// Redis por worktree do harness E2E (T122): derivação, env, máscara, RESP e reserva do db. Roda pelo vitest do @crm/api.
import { describe, expect, it } from 'vitest'
import { derivedPorts, derivedRedis, e2eRedis, maskRedisUrl, redisDbCandidates, redisDbOf, withRedisDb } from './ports.mjs'
import { claimRedisDb, encodeCommand, openRedis, parseReply, tryClaim } from './redis-claim.mjs'

// Chave própria do teste: não mexe na reserva de um harness real que esteja usando estes dbs.
const OWNER_KEY = `e2e:harness:owner:test-${process.pid}`

const REDIS = process.env.REDIS_URL || 'redis://127.0.0.1:6379/1'
const host = (() => {
  const u = new URL(REDIS)
  u.pathname = ''
  return u.toString().replace(/\/$/, '')
})()

describe('derivação', () => {
  it('db 2..15, stream e prefixo do mesmo hash das portas; E2E_PORTS_ROOT vale também', () => {
    const a = e2eRedis('C:/x/wt/A', {})
    const b = e2eRedis('C:/x/wt/B', {})
    expect(a.db).toBeGreaterThanOrEqual(2)
    expect(a.db).toBeLessThanOrEqual(15)
    expect(a).toMatchObject({ url: `redis://127.0.0.1:6379/${a.db}`, source: 'derived' })
    expect(a.stream).toMatch(/^wsm:events:e2e-[0-9a-f]{8}$/)
    expect(a.queuePrefix).toBe(`crm-e2e-${a.stream.slice(-8)}`)
    expect(a.stream).not.toBe(b.stream)
    expect(e2eRedis('C:/x/wt/A', {})).toEqual(a)
    expect(e2eRedis('c:\\x\\wt\\A\\', {})).toEqual(a)
    expect(e2eRedis('C:/outro', { E2E_PORTS_ROOT: 'C:/x/wt/A' })).toEqual(a)
    // mesmo hash da T118
    expect(derivedRedis('C:/x/wt/A').suffix).toHaveLength(8)
    expect(derivedPorts('C:/x/wt/A').web).toBeGreaterThanOrEqual(20000)
  })

  it('E2E_REDIS_URL é usada exatamente; WA_EVENTS_STREAM e CRM_QUEUE_PREFIX sobrescrevem', () => {
    const r = e2eRedis('C:/x/wt/A', { E2E_REDIS_URL: 'redis://:segredo@10.0.0.5:6380/9' })
    expect(r).toMatchObject({ url: 'redis://:segredo@10.0.0.5:6380/9', db: 9, source: 'env' })
    expect(r.stream).toMatch(/^wsm:events:e2e-/)
    expect(e2eRedis('C:/x/wt/A', { WA_EVENTS_STREAM: 's1', CRM_QUEUE_PREFIX: 'p1' })).toMatchObject({ stream: 's1', queuePrefix: 'p1' })
    expect(maskRedisUrl('redis://:segredo@10.0.0.5:6380/9')).toBe('redis://:***@10.0.0.5:6380/9')
    expect(withRedisDb('redis://u:p@h:1/3', 7)).toBe('redis://u:p@h:1/7')
    expect(redisDbOf('redis://h:1')).toBe(0)
    expect(redisDbCandidates(15).slice(0, 3)).toEqual([15, 2, 3])
    expect(redisDbCandidates(2)).toHaveLength(14)
  })
})

describe('RESP', () => {
  it('codifica e decodifica', () => {
    expect(encodeCommand(['SET', 'k', 'vá'])).toBe('*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\nvá\r\n')
    expect(parseReply(Buffer.from('+OK\r\n'))).toEqual({ value: 'OK', end: 5 })
    expect(parseReply(Buffer.from('$-1\r\n'))?.value).toBeNull()
    expect(parseReply(Buffer.from('$3\r\nabc\r\n'))?.value).toBe('abc')
    expect(parseReply(Buffer.from('$3\r\nab'))).toBeNull()
    expect(parseReply(Buffer.from('*2\r\n:1\r\n$1\r\nx\r\n'))?.value).toEqual([1, 'x'])
    expect(parseReply(Buffer.from('-ERR x\r\n'))?.value).toBeInstanceOf(Error)
  })
})

describe('reserva do db (Redis real)', () => {
  it('outro worktree vivo no db → próximo; dono morto ou o próprio → mesmo db; release apaga', async () => {
    const db = 13
    const url = withRedisDb(host, db)
    const r = await openRedis(url)
    try {
      await r.send('DEL', OWNER_KEY)
      // "outro harness" vivo: o processo pai deste teste
      await r.send('SET', OWNER_KEY, JSON.stringify({ root: 'c:/outro/worktree', pid: process.ppid }), 'EX', 30)
      const claim = await claimRedisDb(host, db, 'C:/meu/worktree', process.pid, OWNER_KEY)
      expect(claim.db).toBe(14)
      expect(JSON.parse(await r.send('GET', OWNER_KEY)).root).toBe('c:/outro/worktree')
      await claim.release()

      // dono morto: toma o db
      await r.send('SET', OWNER_KEY, JSON.stringify({ root: 'c:/outro/worktree', pid: 2 ** 30 }), 'EX', 30)
      expect(await tryClaim(url, 'C:/meu/worktree', process.pid, OWNER_KEY)).toBe(true)
      expect(await tryClaim(url, 'C:/meu/worktree', process.pid, OWNER_KEY)).toBe(true)
      const mine = await claimRedisDb(host, db, 'C:/meu/worktree', process.pid, OWNER_KEY)
      expect(mine.db).toBe(db)
      await mine.release()
      expect(await r.send('GET', OWNER_KEY)).toBeNull()
    } finally {
      await r.send('DEL', OWNER_KEY)
      await r.close()
      const r14 = await openRedis(withRedisDb(host, 14))
      await r14.send('DEL', OWNER_KEY)
      await r14.close()
    }
  })
})
