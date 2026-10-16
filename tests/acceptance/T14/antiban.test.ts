// AC-T14-04: receipts chamam antiban.onDelivered; ANTIBAN_MODE ausente = real; preset inválido → erro na inicialização.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FAST, REDIS_URL, antibanMod, fakeTransport, migratedWaDb, newSession, queueMod, rand, textMsg, waitFor, type WaDb } from './support'

let pg: WaDb
let ab: any
let MessageQueue: any
const open: any[] = []

beforeAll(async () => {
  ab = await antibanMod()
  ;({ MessageQueue } = await queueMod())
  pg = await migratedWaDb()
})

afterEach(async () => {
  for (const q of open.splice(0)) await q.close().catch(() => {})
})

afterAll(async () => {
  await pg?.close()
})

/** AntiBan falso (forma AntiBanLike do baileys-antiban) com spies. */
function fakeAntiBan() {
  return {
    beforeSend: vi.fn(async () => ({ allowed: true, delayMs: 0 })),
    afterSend: vi.fn(),
    afterSendFailed: vi.fn(),
    onDeliveryReceipt: vi.fn(),
    destroy: vi.fn(),
  }
}

describe('T14 — modo e preset do antiban', () => {
  it('AC-T14-04 ANTIBAN_MODE ausente (ou vazio) = real', () => {
    expect(ab.antibanModeFromEnv({})).toBe('real')
    expect(ab.antibanModeFromEnv({ ANTIBAN_MODE: '' })).toBe('real')
    expect(ab.antibanModeFromEnv({ ANTIBAN_MODE: 'passthrough' })).toBe('passthrough')
    const adapter = ab.createAntibanAdapter({ env: {}, create: () => fakeAntiBan() })
    expect(adapter.mode).toBe('real')
  })

  it('AC-T14-04 ANTIBAN_MODE=passthrough só quando explícito', () => {
    const adapter = ab.createAntibanAdapter({ env: { ANTIBAN_MODE: 'passthrough' } })
    expect(adapter.mode).toBe('passthrough')
  })

  it('AC-T14-04 preset inválido → erro na inicialização (AntibanConfigError)', () => {
    expect(() => ab.antibanPresetFromEnv({ ANTIBAN_PRESET: 'turbo' })).toThrow(ab.AntibanConfigError)
    expect(() => ab.createAntibanAdapter({ env: { ANTIBAN_PRESET: 'turbo' } })).toThrow(ab.AntibanConfigError)
    expect(() => ab.createAntibanAdapter({ env: { ANTIBAN_MODE: 'real', ANTIBAN_PRESET: 'nao-existe' } })).toThrow()
  })

  it('AC-T14-04 modo inválido também falha na inicialização (nunca desliga o antiban por engano)', () => {
    expect(() => ab.createAntibanAdapter({ env: { ANTIBAN_MODE: 'off' } })).toThrow(ab.AntibanConfigError)
  })

  it('AC-T14-04 presets válidos são aceitos; ausente = conservative', () => {
    expect(ab.antibanPresetFromEnv({})).toBe('conservative')
    for (const p of ['conservative', 'moderate', 'aggressive', 'high-volume']) {
      expect(ab.antibanPresetFromEnv({ ANTIBAN_PRESET: p })).toBe(p)
      expect(() => ab.createAntibanAdapter({ env: { ANTIBAN_PRESET: p }, create: () => fakeAntiBan() })).not.toThrow()
    }
  })

  it('AC-T14-04 instância do AntiBan por sessão', async () => {
    const created: any[] = []
    const adapter = ab.createAntibanAdapter({
      env: {},
      create: () => {
        const f = fakeAntiBan()
        created.push(f)
        return f
      },
    })
    await adapter.beforeSend('sess-A', '5511900000001@s.whatsapp.net', { text: 'a' })
    await adapter.beforeSend('sess-A', '5511900000002@s.whatsapp.net', { text: 'b' })
    await adapter.beforeSend('sess-B', '5511900000003@s.whatsapp.net', { text: 'c' })
    expect(created).toHaveLength(2)
  })
})

describe('T14 — receipts alimentam o antiban', () => {
  it('AC-T14-04 handleReceipt chama antiban.onDelivered(sessionId, messageId)', async () => {
    const sid = newSession(pg.tmp.url)
    const antiban = { onDelivered: vi.fn() }
    const q = new MessageQueue({
      db: pg.db,
      connection: { url: REDIS_URL },
      prefix: `t14${rand()}`,
      ...FAST,
      antiban,
      getTransport: () => fakeTransport(),
      deliver: (t: any, to: string, c: any) => t.sendMessage(to, c),
    })
    open.push(q)
    await q.startSession(sid)
    const view = await q.enqueue(textMsg(sid))
    await waitFor(async () => (await q.get(view.id)).status === 'sent', 15_000, 'sent')
    const waid = (await q.get(view.id)).transportMessageId
    await q.handleReceipt(sid, { messageId: waid, status: 'delivered' })
    expect(antiban.onDelivered).toHaveBeenCalledWith(sid, waid)
  })

  it('AC-T14-04 com o adapter real, o receipt chega ao AntiBan da sessão (onDeliveryReceipt)', async () => {
    const sid = newSession(pg.tmp.url)
    const instances: any[] = []
    const adapter = ab.createAntibanAdapter({
      env: {},
      create: () => {
        const f = fakeAntiBan()
        instances.push(f)
        return f
      },
    })
    const q = new MessageQueue({
      db: pg.db,
      connection: { url: REDIS_URL },
      prefix: `t14${rand()}`,
      ...FAST,
      antiban: adapter,
      getTransport: () => fakeTransport(),
      // ponto de entrega mínimo: antiban antes/depois, como o deliver da T20
      deliver: async (t: any, to: string, c: any) => {
        await adapter.beforeSend(sid, to, c)
        const r = await t.sendMessage(to, c)
        adapter.afterSend(sid, to, c, r.messageId)
        return r
      },
    })
    open.push(q)
    await q.startSession(sid)
    const view = await q.enqueue(textMsg(sid))
    await waitFor(async () => (await q.get(view.id)).status === 'sent', 15_000, 'sent')
    const waid = (await q.get(view.id)).transportMessageId
    await q.handleReceipt(sid, { messageId: waid, status: 'delivered' })
    expect(instances).toHaveLength(1)
    expect(instances[0].onDeliveryReceipt).toHaveBeenCalledWith(waid)
  })
})
