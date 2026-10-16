// subscribe pelo Redis Stream (Redis real, stream aleatório): só eventos posteriores à assinatura, em ordem, entradas
// inválidas ignoradas, unsubscribe/close param a entrega e o grupo `crm` não é afetado.
import { randomBytes } from 'node:crypto'
import { redisConnection } from '@crm/node-kit'
import { WA_EVENT_VERSION, type WaEvent } from '@crm/wa-port'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRpcGateway } from './gateway'
import { EventStreamTail, STREAM_EVENT_FIELD, xreadEntries } from './stream'

let redis: Redis
const streams: string[] = []

beforeAll(() => {
  redis = redisConnection()
})
afterAll(async () => {
  if (streams.length) await redis.del(...streams)
  await redis.quit()
})

const newStream = () => {
  const s = `test:t46:events:${randomBytes(4).toString('hex')}`
  streams.push(s)
  return s
}
const inbound = (id: string, sessionId = 's1'): WaEvent => ({
  v: WA_EVENT_VERSION,
  type: 'message.inbound',
  session_id: sessionId,
  at: new Date().toISOString(),
  message: { id, from: '5511999990000@s.whatsapp.net', from_me: false, timestamp: Date.now(), text: id, type: 'conversation' },
})
const publish = (stream: string, e: WaEvent | string) => redis.xadd(stream, '*', STREAM_EVENT_FIELD, typeof e === 'string' ? e : JSON.stringify(e))

async function waitFor(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('subscribe (stream wsm:events)', () => {
  it('entrega só o que chegou depois da assinatura, em ordem, e ignora entradas inválidas', async () => {
    const stream = newStream()
    await publish(stream, inbound('antes'))
    const g = createRpcGateway({ url: 'http://127.0.0.1:1', token: 't', redis, stream, blockMs: 100 })
    const got: string[] = []
    const off = g.subscribe((e) => {
      if (e.type === 'message.inbound') got.push(e.message.id)
    })
    await publish(stream, inbound('a'))
    await publish(stream, '{"v":1,"type":"desconhecido"}')
    await publish(stream, 'não é json')
    await publish(stream, inbound('b'))
    await waitFor(() => got.length >= 2)
    expect(got).toEqual(['a', 'b'])
    off()
    await g.close()
  })

  it('vários assinantes; um que falha não derruba os outros; unsubscribe para a entrega', async () => {
    const stream = newStream()
    const g = createRpcGateway({ url: 'http://127.0.0.1:1', token: 't', redis, stream, blockMs: 100, logger: { warn: () => undefined, error: () => undefined } })
    const a: string[] = []
    const b: string[] = []
    const offA = g.subscribe((e) => {
      if (e.type === 'message.inbound') a.push(e.message.id)
    })
    const offBad = g.subscribe(() => {
      throw new Error('assinante quebrado')
    })
    const offB = g.subscribe(async (e) => {
      if (e.type === 'message.inbound') b.push(e.message.id)
    })
    await publish(stream, inbound('1'))
    await waitFor(() => a.length === 1 && b.length === 1)
    offA()
    await publish(stream, inbound('2'))
    await waitFor(() => b.length === 2)
    expect(a).toEqual(['1'])
    offB()
    offBad()
    await publish(stream, inbound('3'))
    await new Promise((r) => setTimeout(r, 250))
    expect(b).toEqual(['1', '2'])
    await g.close()
  })

  it('reassinar depois de ficar sem assinantes não reentrega o que passou no intervalo', async () => {
    const stream = newStream()
    const tail = new EventStreamTail({ redis, stream, blockMs: 100 })
    const first: string[] = []
    const off = tail.subscribe((e) => {
      if (e.type === 'message.inbound') first.push(e.message.id)
    })
    await publish(stream, inbound('x1'))
    await waitFor(() => first.length === 1)
    off()
    await publish(stream, inbound('no-intervalo'))
    await new Promise((r) => setTimeout(r, 5))
    const second: string[] = []
    tail.subscribe((e) => {
      if (e.type === 'message.inbound') second.push(e.message.id)
    })
    await publish(stream, inbound('x2'))
    await waitFor(() => second.length >= 1)
    await new Promise((r) => setTimeout(r, 150))
    expect(second).toEqual(['x2'])
    await tail.close()
    expect(() => tail.subscribe(() => undefined)).toThrow(/fechado/)
  })

  it('não usa consumer group: o grupo crm continua recebendo tudo', async () => {
    const stream = newStream()
    await redis.xgroup('CREATE', stream, 'crm', '$', 'MKSTREAM')
    const g = createRpcGateway({ url: 'http://127.0.0.1:1', token: 't', redis: process.env.REDIS_URL || 'redis://127.0.0.1:6379/1', stream, blockMs: 100 })
    const got: string[] = []
    g.subscribe((e) => {
      if (e.type === 'message.inbound') got.push(e.message.id)
    })
    await publish(stream, inbound('g1'))
    await waitFor(() => got.length === 1)
    const res = xreadEntries(await redis.xreadgroup('GROUP', 'crm', 'c1', 'COUNT', 10, 'STREAMS', stream, '>'))
    expect(res).toHaveLength(1)
    await g.close()
  })

  it('xreadEntries aceita RESP2 e RESP3', () => {
    const entries = [['1-0', ['event', '{}']]]
    expect(xreadEntries(null)).toEqual([])
    expect(xreadEntries([['s', entries]])).toEqual(entries)
    expect(xreadEntries(new Map([['s', entries]]))).toEqual(entries)
    expect(xreadEntries({ s: entries })).toEqual(entries)
  })
})
