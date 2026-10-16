// AC-T09-03: o mesmo evento entregue duas vezes executa o efeito uma vez (crm.processed_events por event_key).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'
import { cleanupStreams, inbound, migratedCrmDb, names, newConsumer, newRedis, pendingCount, sleep, waitFor, xadd, type CrmDb } from './support'

let redis: any
let pg: CrmDb
const used: Array<ReturnType<typeof names>> = []

beforeAll(async () => {
  redis = await newRedis()
  pg = await migratedCrmDb()
})

afterAll(async () => {
  for (const n of used) await cleanupStreams(redis, n)
  await redis?.quit().catch(() => {})
  await pg?.close()
})

describe('T09 — idempotência', () => {
  it('AC-T09-03 crm.processed_events existe com (consumer, event_key)', () => {
    const cols = sqlOk(
      pg.tmp.url,
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'crm' AND table_name = 'processed_events';`,
    ).map((r) => r[0])
    expect(cols).toEqual(expect.arrayContaining(['consumer', 'event_key']))
  })

  it('AC-T09-03 duas entregas do mesmo evento (2 XADD, mesmo payload) executam o efeito uma vez', async () => {
    const n = names()
    used.push(n)
    let effects = 0
    const c = await newConsumer(redis, n, { db: pg.db })
    c.on('message.inbound', async () => {
      effects++
    })
    await c.start()
    try {
      const ev = inbound()
      await xadd(redis, n.stream, ev)
      await xadd(redis, n.stream, JSON.parse(JSON.stringify(ev)))
      // um evento distinto serve de marcador de que os dois anteriores já foram consumidos
      const marker = inbound(ev.session_id)
      await xadd(redis, n.stream, marker)
      await waitFor(() => effects >= 2, 10_000, 'evento marcador')
      await waitFor(async () => (await pendingCount(redis, n.stream)) === 0, 5_000, 'todos confirmados')
      await sleep(300)
      expect(effects, 'efeito executado mais de uma vez para o mesmo evento').toBe(2)
      const rows = sqlOk(pg.tmp.url, `SELECT count(*) FROM crm.processed_events;`)
      expect(Number(rows[0]![0])).toBeGreaterThanOrEqual(2)
    } finally {
      await c.stop()
    }
  })

  it('AC-T09-03 reentrega após reiniciar o consumidor (novo processo) também não repete o efeito', async () => {
    const n = names()
    used.push(n)
    let effects = 0
    const handler = async () => {
      effects++
    }
    const ev = inbound()
    const c1 = await newConsumer(redis, n, { db: pg.db, consumer: 'inst-1' })
    c1.on('message.inbound', handler)
    await c1.start()
    await xadd(redis, n.stream, ev)
    await waitFor(() => effects === 1, 10_000, 'primeira execução')
    await c1.stop()

    const c2 = await newConsumer(redis, n, { db: pg.db, consumer: 'inst-2' })
    c2.on('message.inbound', handler)
    await c2.start()
    try {
      await xadd(redis, n.stream, ev) // at-least-once: o produtor reenviou
      await waitFor(async () => (await pendingCount(redis, n.stream)) === 0, 10_000, 'reentrega confirmada')
      await sleep(400)
      expect(effects).toBe(1)
    } finally {
      await c2.stop()
    }
  })

  it('AC-T09-03 handler que falha não marca o evento: o reprocessamento executa o efeito', async () => {
    const n = names()
    used.push(n)
    let attempts = 0
    let effects = 0
    const c = await newConsumer(redis, n, { db: pg.db })
    c.on('message.inbound', async () => {
      attempts++
      if (attempts === 1) throw new Error('falha transitória')
      effects++
    })
    await c.start()
    try {
      const ev = inbound()
      await xadd(redis, n.stream, ev)
      await waitFor(() => effects === 1, 10_000, 'efeito após reprocessar')
      await xadd(redis, n.stream, ev)
      await waitFor(async () => (await pendingCount(redis, n.stream)) === 0, 5_000, 'confirmado')
      await sleep(300)
      expect(effects).toBe(1)
      expect(attempts).toBe(2)
    } finally {
      await c.stop()
    }
  })

  it('AC-T09-03 a marca de processado fica em crm.processed_events (consulta por event_key única)', () => {
    const dup = sqlOk(pg.tmp.url, `SELECT consumer, event_key, count(*) FROM crm.processed_events GROUP BY 1, 2 HAVING count(*) > 1;`)
    expect(dup).toEqual([])
    const any = sqlOk(pg.tmp.url, `SELECT count(*) FROM crm.processed_events WHERE consumer <> ${lit('')};`)
    expect(Number(any[0]![0])).toBeGreaterThan(0)
  })
})
