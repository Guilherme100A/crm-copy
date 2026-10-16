// Redis (REDIS_URL, db 1) e Postgres reais (SPEC 3.10); streams com nome aleatório.
import { randomBytes } from 'node:crypto'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import type { WaEvent } from '@crm/wa-port'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { StreamConsumer, WA_EVENT_FIELD, type StreamConsumerOptions } from './consumer'

let temp: TempDatabase
let db: Database
let redis: Redis
const consumers: StreamConsumer[] = []
const keys: string[] = []

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection()
}, 120_000)

afterEach(async () => {
  for (const c of consumers.splice(0)) await c.stop()
})

afterAll(async () => {
  if (keys.length) await redis.del(...keys)
  await redis.quit()
  await db?.$client.end()
  await temp?.drop()
})

function names() {
  const id = randomBytes(4).toString('hex')
  const stream = `test:wsm:events:${id}`
  const dlqStream = `test:crm:dlq:${id}`
  keys.push(stream, dlqStream)
  return { stream, dlqStream }
}

function consumer(opts: StreamConsumerOptions): StreamConsumer {
  const c = new StreamConsumer({ redis, blockMs: 50, claimIdleMs: 100, ...opts })
  consumers.push(c)
  return c
}

const inbound = (id: string, sessionId = 's1'): WaEvent => ({
  v: 1,
  type: 'message.inbound',
  session_id: sessionId,
  at: new Date().toISOString(),
  message: { id, from: '5511999999999@s.whatsapp.net', from_me: false, timestamp: Date.now(), type: 'conversation', text: 'oi' },
})

const publish = (stream: string, event: unknown) => redis.xadd(stream, '*', WA_EVENT_FIELD, typeof event === 'string' ? event : JSON.stringify(event))

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const pending = async (stream: string) => Number(((await redis.xpending(stream, 'crm')) as [number])[0])

describe('StreamConsumer', () => {
  it('entrega o evento ao handler do seu type, validado, e confirma (XACK)', async () => {
    const { stream } = names()
    const got: WaEvent[] = []
    const other: WaEvent[] = []
    const c = consumer({ stream })
      .on('message.inbound', (e, ctx) => {
        got.push(e)
        expect(ctx.deliveries).toBe(1)
        expect(ctx.eventKey).toBe('message.inbound:s1:m1')
      })
      .on('session.state', (e) => {
        other.push(e)
      })
    await c.start()
    await publish(stream, inbound('m1'))
    await waitFor(() => got.length === 1)
    expect(got[0]).toMatchObject({ v: 1, type: 'message.inbound', session_id: 's1', message: { id: 'm1', text: 'oi' } })
    expect(other).toHaveLength(0)
    await waitFor(async () => (await pending(stream)) === 0)
  })

  it('lê eventos publicados antes do primeiro start (grupo criado a partir de 0)', async () => {
    const { stream } = names()
    await publish(stream, inbound('early'))
    const got: string[] = []
    await consumer({ stream })
      .on('message.inbound', (e) => {
        got.push(e.message.id)
      })
      .start()
    await waitFor(() => got.includes('early'))
  })

  it('handler que lança não faz XACK; o reclaim reprocessa; na 5ª falha vai para a DLQ e é confirmado', async () => {
    const { stream, dlqStream } = names()
    const deliveries: number[] = []
    const c = consumer({ stream, dlqStream }).on('message.inbound', (_e, ctx) => {
      deliveries.push(ctx.deliveries)
      throw new Error('falhou')
    })
    await c.start()
    await publish(stream, inbound('m-fail'))
    await waitFor(() => deliveries.length >= 1)
    expect(await pending(stream)).toBe(1)
    await waitFor(async () => (await redis.xlen(dlqStream)) === 1, 10_000)
    expect(deliveries).toEqual([1, 2, 3, 4, 5])
    expect(await pending(stream)).toBe(0)
    const entries = (await redis.xrange(dlqStream, '-', '+')) as [string, string[]][]
    const fields = entries[0]![1]
    const dlq = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, i) => [fields[2 * i], fields[2 * i + 1]]))
    expect(dlq).toMatchObject({ error: 'falhou', deliveries: '5', stream })
    expect(JSON.parse(dlq.event!)).toMatchObject({ message: { id: 'm-fail' } })
  })

  it('falha transitória: reprocessa e confirma quando o handler passa', async () => {
    const { stream } = names()
    let calls = 0
    const c = consumer({ stream }).on('message.inbound', () => {
      calls += 1
      if (calls < 3) throw new Error('ainda não')
    })
    await c.start()
    await publish(stream, inbound('m-retry'))
    await waitFor(() => calls === 3)
    await waitFor(async () => (await pending(stream)) === 0)
  })

  it('evento inválido vai direto para a DLQ', async () => {
    const { stream, dlqStream } = names()
    const c = consumer({ stream, dlqStream }).on('message.inbound', () => undefined)
    await c.start()
    await publish(stream, { v: 2, type: 'message.inbound' })
    await publish(stream, 'não é json')
    await waitFor(async () => (await redis.xlen(dlqStream)) === 2)
    expect(await pending(stream)).toBe(0)
  })

  it('o mesmo evento entregue duas vezes executa o efeito uma vez (db)', async () => {
    const { stream } = names()
    const effects: string[] = []
    const c = consumer({ stream, db }).on('message.inbound', (e) => {
      effects.push(e.message.id)
    })
    await c.start()
    const id = `dup-${randomBytes(3).toString('hex')}`
    const ev = inbound(id)
    await publish(stream, ev)
    await publish(stream, ev)
    await publish(stream, { ...ev, at: new Date(Date.now() + 1000).toISOString() })
    await waitFor(async () => (await pending(stream)) === 0 && (await redis.xlen(stream)) === 3)
    await new Promise((r) => setTimeout(r, 100))
    expect(effects).toEqual([id])
  })

  it('falha com db não marca o evento: o reprocessamento executa o efeito', async () => {
    const { stream } = names()
    let calls = 0
    const effects: number[] = []
    const c = consumer({ stream, db }).on('message.inbound', () => {
      calls += 1
      if (calls === 1) throw new Error('primeira falha')
      effects.push(calls)
    })
    await c.start()
    await publish(stream, inbound(`retry-db-${randomBytes(3).toString('hex')}`))
    await waitFor(() => effects.length === 1)
    expect(effects).toEqual([2])
  })

  it('duas instâncias no mesmo grupo dividem os eventos sem duplicar', async () => {
    const { stream } = names()
    const seen = new Map<string, string[]>()
    const make = (name: string) =>
      consumer({ stream, db, consumer: name, batchSize: 1 }).on('message.inbound', async (e) => {
        seen.set(e.message.id, [...(seen.get(e.message.id) ?? []), name])
        await new Promise((r) => setTimeout(r, 5))
      })
    await Promise.all([make('w1').start(), make('w2').start()])
    const ids = Array.from({ length: 40 }, (_, i) => `par-${i}-${randomBytes(2).toString('hex')}`)
    for (const id of ids) await publish(stream, inbound(id))
    await waitFor(() => seen.size === ids.length, 10_000)
    await waitFor(async () => (await pending(stream)) === 0)
    for (const id of ids) expect(seen.get(id)).toHaveLength(1)
    const byWorker = [...seen.values()].flat()
    expect(byWorker.filter((w) => w === 'w1').length).toBeGreaterThan(0)
    expect(byWorker.filter((w) => w === 'w2').length).toBeGreaterThan(0)
  })

  it('stop espera o handler em andamento terminar', async () => {
    const { stream } = names()
    let finished = false
    let started = false
    const c = consumer({ stream }).on('message.inbound', async () => {
      started = true
      await new Promise((r) => setTimeout(r, 300))
      finished = true
    })
    await c.start()
    await publish(stream, inbound('slow'))
    await waitFor(() => started)
    await c.stop()
    expect(finished).toBe(true)
    expect(await pending(stream)).toBe(0)
  })

  it('não aceita dois handlers com o mesmo id para o mesmo type', () => {
    const c = new StreamConsumer({ redis })
    c.on('message.inbound', () => undefined)
    expect(() => c.on('message.inbound', () => undefined)).toThrow()
    expect(() => c.on('message.inbound', () => undefined, { id: 'outro' })).not.toThrow()
  })
})
