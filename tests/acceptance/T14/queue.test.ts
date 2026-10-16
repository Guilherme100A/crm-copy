// AC-T14-01..03: MessageQueue (BullMQ, fila session:<id>) sobre Postgres + Redis reais.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'
import { FAST, REDIS_URL, fakeTransport, migratedWaDb, newSession, queueMod, rand, sleep, textMsg, waitFor, type WaDb } from './support'

let pg: WaDb
let MessageQueue: any
const open: any[] = []

beforeAll(async () => {
  ;({ MessageQueue } = await queueMod())
  pg = await migratedWaDb()
})

afterEach(async () => {
  for (const q of open.splice(0)) await q.close().catch(() => {})
})

afterAll(async () => {
  await pg?.close()
})

function makeQueue(opts: Record<string, unknown>) {
  const q = new MessageQueue({ db: pg.db, connection: { url: REDIS_URL }, ...FAST, ...opts })
  q.on?.('error', () => {})
  open.push(q)
  return q
}

const statusOf = async (q: any, id: string) => (await q.get(id)).status as string
const dbEvents = (id: string) =>
  sqlOk(pg.tmp.url, `SELECT coalesce(from_status::text, ''), to_status::text FROM public.message_events WHERE message_id = ${lit(id)} ORDER BY id;`).map(
    ([from, to]) => `${from || '∅'}→${to}`,
  )

describe('T14 — concorrência global 1 por sessão (AC-T14-01)', () => {
  it('AC-T14-01 duas instâncias (dois workers) na mesma fila nunca processam duas mensagens da sessão ao mesmo tempo', async () => {
    const sid = newSession(pg.tmp.url)
    const prefix = `t14${rand()}`
    const transport = fakeTransport()
    let inFlight = 0
    let maxInFlight = 0
    const byWorker: string[] = []
    const deliverFor = (who: string) => async (t: any, to: string, content: any) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      byWorker.push(who)
      await sleep(120)
      inFlight--
      return t.sendMessage(to, content)
    }
    const a = makeQueue({ prefix, getTransport: () => transport, deliver: deliverFor('A') })
    const b = makeQueue({ prefix, getTransport: () => transport, deliver: deliverFor('B') })
    await a.startSession(sid)
    await b.startSession(sid)
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push((await (i % 2 ? b : a).enqueue(textMsg(sid, `m${i}`))).id)
    await waitFor(async () => (await Promise.all(ids.map((id) => statusOf(a, id)))).every((s) => s === 'sent'), 30_000, '6 mensagens sent')
    expect(maxInFlight, 'duas mensagens da mesma sessão processadas ao mesmo tempo').toBe(1)
    expect(byWorker).toHaveLength(6)
  })

  it('AC-T14-01 sessões diferentes não se bloqueiam (a serialização é por sessão)', async () => {
    const s1 = newSession(pg.tmp.url)
    const s2 = newSession(pg.tmp.url)
    const transport = fakeTransport()
    const active = new Set<string>()
    let overlapped = false
    const q = makeQueue({
      prefix: `t14${rand()}`,
      getTransport: () => transport,
      deliver: async (t: any, to: string, content: any) => {
        const key = to
        active.add(key)
        if (active.size > 1) overlapped = true
        await sleep(300)
        active.delete(key)
        return t.sendMessage(to, content)
      },
    })
    await q.startSession(s1)
    await q.startSession(s2)
    const m1 = await q.enqueue({ ...textMsg(s1), phone: '+5511900000001' })
    const m2 = await q.enqueue({ ...textMsg(s2), phone: '+5511900000002' })
    await waitFor(async () => (await statusOf(q, m1.id)) === 'sent' && (await statusOf(q, m2.id)) === 'sent', 20_000, 'duas sessões')
    expect(overlapped, 'sessões distintas deveriam poder enviar em paralelo').toBe(true)
  })
})

describe('T14 — estados e receipts (AC-T14-02)', () => {
  it('AC-T14-02 queued → processing → sent grava message_events; receipts levam a delivered e read', async () => {
    const sid = newSession(pg.tmp.url)
    const transport = fakeTransport()
    const q = makeQueue({ prefix: `t14${rand()}`, getTransport: () => transport, deliver: (t: any, to: string, c: any) => t.sendMessage(to, c) })
    await q.startSession(sid)
    const view = await q.enqueue(textMsg(sid))
    expect(view.status).toBe('queued')
    await waitFor(async () => (await statusOf(q, view.id)) === 'sent', 15_000, 'sent')
    const sent = await q.get(view.id)
    expect(sent.transportMessageId).toBeTruthy()
    expect(sent.sentAt).toBeTruthy()

    await q.handleReceipt(sid, { messageId: sent.transportMessageId, status: 'delivered' })
    expect(await statusOf(q, view.id)).toBe('delivered')
    expect((await q.get(view.id)).deliveredAt).toBeTruthy()
    await q.handleReceipt(sid, { messageId: sent.transportMessageId, status: 'read' })
    expect(await statusOf(q, view.id)).toBe('read')
    expect((await q.get(view.id)).readAt).toBeTruthy()

    const seq = dbEvents(view.id)
    const order = ['queued', 'processing', 'sent', 'delivered', 'read']
    const tos = seq.map((s) => s.split('→')[1])
    expect(tos.filter((t) => order.includes(t!))).toEqual(order)
    expect(seq).toEqual(expect.arrayContaining(['queued→processing', 'processing→sent', 'sent→delivered', 'delivered→read']))
    // a API de eventos reflete o mesmo histórico
    const apiTos = (await q.events(view.id)).map((e: any) => e.to)
    expect(apiTos).toEqual(tos)
  })

  it('AC-T14-02 status nunca regride: delivered depois de read é ignorado', async () => {
    const sid = newSession(pg.tmp.url)
    const transport = fakeTransport()
    const q = makeQueue({ prefix: `t14${rand()}`, getTransport: () => transport, deliver: (t: any, to: string, c: any) => t.sendMessage(to, c) })
    await q.startSession(sid)
    const view = await q.enqueue(textMsg(sid))
    await waitFor(async () => (await statusOf(q, view.id)) === 'sent', 15_000, 'sent')
    const waid = (await q.get(view.id)).transportMessageId
    await q.handleReceipt(sid, { messageId: waid, status: 'read' })
    expect(await statusOf(q, view.id)).toBe('read')
    const before = dbEvents(view.id).length
    await q.handleReceipt(sid, { messageId: waid, status: 'delivered' }).catch(() => {})
    await q.handleReceipt(sid, { messageId: waid, status: 'read' }).catch(() => {})
    expect(await statusOf(q, view.id)).toBe('read')
    expect(dbEvents(view.id).length, 'evento de regressão gravado').toBe(before)
  })

  it('AC-T14-02 receipt que chega antes do sent não se perde nem regride', async () => {
    const sid = newSession(pg.tmp.url)
    const ids = ['WAID-EARLY-1']
    const q = makeQueue({
      prefix: `t14${rand()}`,
      getTransport: () => ({ sendMessage: async () => ({ messageId: ids[0] }) }),
      deliver: async (t: any, to: string, c: any) => {
        // o receipt chega enquanto o envio ainda não foi gravado como sent
        await q.handleReceipt(sid, { messageId: ids[0], status: 'delivered' })
        return t.sendMessage(to, c)
      },
    })
    await q.startSession(sid)
    const view = await q.enqueue(textMsg(sid))
    await waitFor(async () => (await statusOf(q, view.id)) === 'delivered', 15_000, 'delivered após receipt antecipado')
  })
})

describe('T14 — retentativas (AC-T14-03)', () => {
  it('AC-T14-03 falha sempre → retrying até 3 tentativas com backoff; esgotadas → failed com o erro', async () => {
    const sid = newSession(pg.tmp.url)
    const calls: number[] = []
    const q = makeQueue({
      prefix: `t14${rand()}`,
      backoffDelayMs: 100,
      getTransport: () => fakeTransport(),
      deliver: async () => {
        calls.push(Date.now())
        throw new Error('falha de envio simulada')
      },
    })
    await q.startSession(sid)
    const view = await q.enqueue(textMsg(sid))
    await waitFor(async () => (await statusOf(q, view.id)) === 'failed', 20_000, 'failed')
    await sleep(300)
    const final = await q.get(view.id)
    expect(calls).toHaveLength(3)
    expect(final.attempts).toBe(3)
    expect(final.lastError ?? final.error).toContain('falha de envio simulada')
    const seq = dbEvents(view.id)
    expect(seq.filter((s) => s.endsWith('→retrying'))).toHaveLength(2)
    expect(seq.at(-1)).toBe('processing→failed')
    // backoff exponencial: a segunda espera é maior que a primeira e respeita a base
    const gap1 = calls[1]! - calls[0]!
    const gap2 = calls[2]! - calls[1]!
    expect(gap1).toBeGreaterThanOrEqual(90)
    expect(gap2).toBeGreaterThanOrEqual(190)
    expect(gap2).toBeGreaterThan(gap1)
  })

  it('AC-T14-03 falha transitória → retrying e depois sent na 2ª tentativa', async () => {
    const sid = newSession(pg.tmp.url)
    let n = 0
    const q = makeQueue({
      prefix: `t14${rand()}`,
      getTransport: () => fakeTransport(),
      deliver: async (t: any, to: string, c: any) => {
        if (++n === 1) throw new Error('timeout transitório')
        return t.sendMessage(to, c)
      },
    })
    await q.startSession(sid)
    const view = await q.enqueue(textMsg(sid))
    await waitFor(async () => (await statusOf(q, view.id)) === 'sent', 15_000, 'sent após retry')
    expect((await q.get(view.id)).attempts).toBe(2)
    expect(dbEvents(view.id)).toEqual(expect.arrayContaining(['processing→retrying', 'retrying→processing', 'processing→sent']))
  })
})
