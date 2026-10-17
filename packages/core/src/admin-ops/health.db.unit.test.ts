// Saúde da infra (T96, AC-T96-02) com Postgres e Redis reais: contagens por fila (prefixo do arquivo de teste), memória
// do Redis, conexões/tamanho do Postgres e lag do grupo `crm` num stream próprio do teste. Blocos com erro isolado.
import { randomBytes } from 'node:crypto'
import { Queue } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import { crmQueuePrefix } from '../jobs/queues'
import {
  CRM_CONSUMER_GROUP,
  infraHealth,
  MONITORED_QUEUES,
  parseRedisInfo,
  parseXinfoGroups,
  type HealthRedis,
} from './health'

let temp: TempDatabase
let db: Database
let redis: ReturnType<typeof redisConnection>
const rnd = () => randomBytes(4).toString('hex')
const stream = `t96:wsm:events:${rnd()}`
const prefix = crmQueuePrefix()
const qName = `t96-health-${rnd()}`
let queue: Queue

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  queue = new Queue(qName, { connection: redis, prefix })
}, 60_000)

afterAll(async () => {
  await queue?.obliterate({ force: true }).catch(() => undefined)
  await queue?.close()
  await redis?.del(stream)
  redis?.disconnect()
  await db?.$client.end()
  await temp?.drop()
})

describe('parsers', () => {
  it('INFO memory → mapa', () => {
    expect(parseRedisInfo('# Memory\r\nused_memory:1024\r\nused_memory_human:1.00K\r\n\r\nmaxmemory:0')).toEqual({
      used_memory: '1024',
      used_memory_human: '1.00K',
      maxmemory: '0',
    })
  })

  it('XINFO GROUPS em lista plana (RESP2), objeto e Map (RESP3)', () => {
    const flat = [
      ['name', 'crm', 'consumers', 1, 'pending', 2, 'last-delivered-id', '1-0', 'entries-read', 3, 'lag', 4],
    ]
    expect(parseXinfoGroups(flat)).toEqual([
      { name: 'crm', consumers: 1, pending: 2, 'last-delivered-id': '1-0', 'entries-read': 3, lag: 4 },
    ])
    expect(parseXinfoGroups([{ name: 'crm', lag: 1 }])).toEqual([{ name: 'crm', lag: 1 }])
    expect(
      parseXinfoGroups([
        new Map<string, unknown>([
          ['name', 'crm'],
          ['lag', 7],
        ]),
      ]),
    ).toEqual([{ name: 'crm', lag: 7 }])
    expect(parseXinfoGroups(null)).toEqual([])
  })

  it('lista única de filas monitoradas inclui as do worker definidas fora do core', () => {
    expect(MONITORED_QUEUES).toEqual(
      expect.arrayContaining([
        'flow-step',
        'ai-knowledge',
        'mass-dispatch',
        'ai-agent',
        'schedules',
        'exports',
        'imports',
      ]),
    )
    expect(new Set(MONITORED_QUEUES).size).toBe(MONITORED_QUEUES.length)
  })
})

describe('infraHealth', () => {
  it('conta waiting/active/failed/delayed/paused por fila, memória do Redis, Postgres e lag do grupo crm', async () => {
    await queue.add('a', { n: 1 })
    await queue.add('b', { n: 2 })
    await queue.add('c', { n: 3 }, { delay: 3_600_000 })
    for (let i = 0; i < 3; i++) await redis.xadd(stream, '*', 'e', String(i))
    await redis.xgroup('CREATE', stream, CRM_CONSUMER_GROUP, '0')
    await redis.xreadgroup('GROUP', CRM_CONSUMER_GROUP, 'c1', 'COUNT', 1, 'STREAMS', stream, '>')

    const h = await infraHealth({
      db,
      redis,
      queues: [qName, 'mass-dispatch'],
      queuePrefix: prefix,
      stream,
      now: () => new Date('2026-05-01T00:00:00Z'),
    })
    expect(h.status).toBe('ok')
    expect(h.checked_at).toBe('2026-05-01T00:00:00.000Z')
    expect(h.queue_prefix).toBe(prefix)
    expect(h.queues).toEqual([
      { name: qName, status: 'ok', waiting: 2, active: 0, failed: 0, delayed: 1, paused: 0, is_paused: false },
      {
        name: 'mass-dispatch',
        status: 'ok',
        waiting: 0,
        active: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
        is_paused: false,
      },
    ])
    expect(h.redis.status).toBe('ok')
    expect(h.redis.used_memory_bytes).toBeGreaterThan(0)
    expect(h.postgres.status).toBe('ok')
    expect(h.postgres.connections).toBeGreaterThanOrEqual(1)
    expect(h.postgres.max_connections).toBeGreaterThan(0)
    expect(h.postgres.database_size_bytes).toBeGreaterThan(0)
    expect(h.wa_events).toEqual({ status: 'ok', stream, group: 'crm', exists: true, lag: 2, pending: 1, consumers: 1 })

    // Fila pausada: os jobs em espera contam como pausados. O cliente compartilhado segue aberto depois do close().
    await queue.pause()
    const paused = await infraHealth({ db, redis, queues: [qName], queuePrefix: prefix, stream })
    expect(paused.queues[0]).toMatchObject({ waiting: 2, paused: 2, is_paused: true })
    await queue.resume()
    expect(await redis.ping()).toBe('PONG')
  })

  it('stream ou grupo inexistente → exists=false e lag null, sem degradar', async () => {
    const h = await infraHealth({ db, redis, queues: [], stream: `t96:none:${rnd()}` })
    expect(h.wa_events).toMatchObject({ status: 'ok', exists: false, lag: null })
    expect(h.status).toBe('ok')
  })

  it('bloco com erro ou lento vira down sem derrubar os outros', async () => {
    const broken: HealthRedis = {
      info: () => Promise.reject(new Error('conexão recusada')),
      call: () => new Promise(() => undefined),
    }
    const h = await infraHealth({
      db,
      redis: broken,
      queueConnection: redis,
      queues: [qName],
      queuePrefix: prefix,
      stream,
      timeoutMs: 1500,
    })
    expect(h.status).toBe('degraded')
    expect(h.redis).toMatchObject({ status: 'down', used_memory_bytes: null, error: 'conexão recusada' })
    expect(h.wa_events).toMatchObject({ status: 'down', lag: null, error: 'timeout' })
    expect(h.queues[0]!.status).toBe('ok')
    expect(h.postgres.status).toBe('ok')
  })
})
