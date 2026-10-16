// AC-T09-01, 02 e 04: StreamConsumer sobre Redis real (db 1), streams com nomes aleatórios.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupStreams, inbound, names, newConsumer, newRedis, pendingCount, rand, readAll, sessionState, sleep, waitFor, xadd } from './support'

let redis: any
const consumers: any[] = []
const used: Array<ReturnType<typeof names>> = []

beforeAll(async () => {
  redis = await newRedis()
})

afterAll(async () => {
  for (const c of consumers) await c.stop().catch(() => {})
  for (const n of used) await cleanupStreams(redis, n)
  await redis?.quit().catch(() => {})
})

const fresh = () => {
  const n = names()
  used.push(n)
  return n
}

async function started(n: ReturnType<typeof names>, setup: (c: any) => void, extra: Record<string, unknown> = {}) {
  const c = await newConsumer(redis, n, extra)
  consumers.push(c)
  setup(c)
  await c.start()
  return c
}

describe('T09 — entrega ao handler (AC-T09-01)', () => {
  it('AC-T09-01 evento publicado com XADD chega ao handler do seu type, validado por parseWaEvent', async () => {
    const n = fresh()
    const got: any[] = []
    const others: any[] = []
    const c = await started(n, (c) => {
      c.on('message.inbound', async (ev: any) => {
        got.push(ev)
      })
      c.on('session.state', async (ev: any) => {
        others.push(ev)
      })
    })
    const ev = inbound()
    await xadd(redis, n.stream, ev)
    await waitFor(() => got.length === 1, 10_000, 'handler de message.inbound')
    expect(JSON.parse(JSON.stringify(got[0]))).toEqual(ev)
    expect(others).toEqual([])
    await waitFor(async () => (await pendingCount(redis, n.stream)) === 0, 5_000, 'XACK após sucesso')
    await c.stop()
  })

  it('AC-T09-01 cada type vai só para o seu handler', async () => {
    const n = fresh()
    const seen: string[] = []
    const c = await started(n, (c) => {
      c.on('message.inbound', async (ev: any) => void seen.push(`inbound:${ev.message.id}`))
      c.on('session.state', async (ev: any) => void seen.push(`state:${ev.session_id}`))
    })
    const a = inbound(undefined, 'MSG-A')
    const b = sessionState('sess-B')
    await xadd(redis, n.stream, a)
    await xadd(redis, n.stream, b)
    await waitFor(() => seen.length === 2, 10_000, 'dois eventos')
    expect(seen.sort()).toEqual(['inbound:MSG-A', 'state:sess-B'])
    await c.stop()
  })

  it('AC-T09-01 payload inválido (v !== 1) não chega ao handler', async () => {
    const n = fresh()
    const got: any[] = []
    const c = await started(n, (c) => c.on('message.inbound', async (ev: any) => void got.push(ev)))
    const bad = { ...inbound(), v: 2 }
    const good = inbound()
    await xadd(redis, n.stream, bad)
    await xadd(redis, n.stream, good)
    await waitFor(() => got.length >= 1, 10_000, 'evento válido')
    await sleep(300)
    expect(got).toHaveLength(1)
    expect(got[0].message.id).toBe(good.message.id)
    await c.stop()
  })

  it('AC-T09-01 usa por padrão o stream wsm:events e o grupo crm', async () => {
    const { StreamConsumer } = await import('@crm/worker')
    const sid = `sess-default-${rand()}`
    const got: any[] = []
    const c = new (StreamConsumer as any)({ redis, blockMs: 100 })
    consumers.push(c)
    c.on('message.inbound', async (ev: any) => {
      if (ev.session_id === sid) got.push(ev)
    })
    await c.start()
    await xadd(redis, 'wsm:events', inbound(sid))
    await waitFor(() => got.length === 1, 10_000, 'evento no stream padrão wsm:events')
    const groups: any[] = await redis.xinfo('GROUPS', 'wsm:events')
    const groupNames = groups.map((g: any) => (Array.isArray(g) ? g[g.indexOf('name') + 1] : g.name))
    expect(groupNames).toContain('crm')
    await c.stop()
  })
})

describe('T09 — falhas, reclaim e DLQ (AC-T09-02)', () => {
  it('AC-T09-02 handler que lança não faz XACK; após o reclaim o evento é reprocessado', async () => {
    const n = fresh()
    const calls: Array<{ deliveries?: number }> = []
    const c = await started(n, (c) =>
      c.on('message.inbound', async (_ev: any, ctx: any) => {
        calls.push({ deliveries: ctx?.deliveries })
        if (calls.length === 1) throw new Error('falha proposital')
      }),
    )
    await xadd(redis, n.stream, inbound())
    await waitFor(() => calls.length >= 1, 10_000, 'primeira entrega')
    // logo após a falha o evento continua pendente (sem XACK)
    await sleep(50)
    expect(await pendingCount(redis, n.stream)).toBe(1)
    await waitFor(() => calls.length >= 2, 10_000, 'reprocessamento após reclaim')
    await waitFor(async () => (await pendingCount(redis, n.stream)) === 0, 5_000, 'XACK após sucesso')
    expect(calls).toHaveLength(2)
    if (calls[1]!.deliveries !== undefined) expect(calls[1]!.deliveries).toBeGreaterThanOrEqual(2)
    expect(await readAll(redis, n.dlq)).toEqual([])
    await c.stop()
  })

  it('AC-T09-02 após 5 falhas o evento vai para a DLQ (crm:wa-events:dlq) e é confirmado', async () => {
    const n = fresh()
    let calls = 0
    const c = await started(n, (c) =>
      c.on('message.inbound', async () => {
        calls++
        throw new Error('sempre falha')
      }),
    )
    const ev = inbound()
    const streamId = await xadd(redis, n.stream, ev)
    await waitFor(async () => (await readAll(redis, n.dlq)).length === 1, 20_000, 'evento na DLQ')
    await waitFor(async () => (await pendingCount(redis, n.stream)) === 0, 5_000, 'XACK após DLQ')
    await sleep(500)
    expect(calls).toBe(5)
    const [dead] = await readAll(redis, n.dlq)
    expect(JSON.parse(dead!.fields.event!)).toEqual(ev)
    expect(dead!.fields.error ?? '').toContain('sempre falha')
    expect(dead!.fields.stream_id).toBe(streamId)
    expect(Number(dead!.fields.deliveries)).toBe(5)
    await c.stop()
  })

  it('AC-T09-02 o nome padrão da DLQ é crm:wa-events:dlq', async () => {
    const { StreamConsumer } = await import('@crm/worker')
    const n = fresh()
    const sid = `sess-dlq-${rand()}`
    const c = new (StreamConsumer as any)({ redis, stream: n.stream, claimIdleMs: 100, claimIntervalMs: 50, blockMs: 100 })
    consumers.push(c)
    c.on('message.inbound', async () => {
      throw new Error('falha')
    })
    await c.start()
    await xadd(redis, n.stream, inbound(sid))
    await waitFor(
      async () => (await readAll(redis, 'crm:wa-events:dlq')).some((e) => (e.fields.event ?? '').includes(sid)),
      20_000,
      'evento na DLQ padrão',
    )
    await c.stop()
    // limpa só a entrada deste teste
    for (const e of await readAll(redis, 'crm:wa-events:dlq')) if ((e.fields.event ?? '').includes(sid)) await redis.xdel('crm:wa-events:dlq', e.id)
  })
})

describe('T09 — várias instâncias no mesmo grupo (AC-T09-04)', () => {
  it('AC-T09-04 duas instâncias dividem os eventos sem processar o mesmo evento duas vezes', async () => {
    const n = fresh()
    const seen: Array<{ who: string; id: string }> = []
    const mk = (who: string) => (c: any) =>
      c.on('message.inbound', async (ev: any) => {
        seen.push({ who, id: ev.message.id })
        await sleep(10)
      })
    const a = await started(n, mk('A'), { consumer: `A-${rand()}`, batchSize: 2 })
    const b = await started(n, mk('B'), { consumer: `B-${rand()}`, batchSize: 2 })
    const TOTAL = 60
    const ids: string[] = []
    for (let i = 0; i < TOTAL; i++) {
      const ev = inbound(undefined, `MSG-${i}-${rand(2)}`)
      ids.push(ev.message.id)
      await xadd(redis, n.stream, ev)
    }
    await waitFor(() => seen.length >= TOTAL, 30_000, `${TOTAL} eventos processados`)
    await sleep(500)
    const processed = seen.map((s) => s.id)
    expect(processed.length, 'algum evento processado mais de uma vez').toBe(new Set(processed).size)
    expect(new Set(processed)).toEqual(new Set(ids))
    expect(seen.some((s) => s.who === 'A'), 'instância A não recebeu nada').toBe(true)
    expect(seen.some((s) => s.who === 'B'), 'instância B não recebeu nada').toBe(true)
    expect(await pendingCount(redis, n.stream)).toBe(0)
    await a.stop()
    await b.stop()
  })
})
