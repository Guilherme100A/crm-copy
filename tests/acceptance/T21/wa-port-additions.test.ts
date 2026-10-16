// Pendências aditivas da @crm/wa-port entregues na T21 (consumidas por T33/T49), contrato combinado com o Operário:
// IncomingMessage.historical?: true; SendRequest.clientMessageId/quoted/viewOnce; MessageView.clientMessageId;
// WaGateway.markRead?(sessionId, chatJid, messageIds); FakeWaGateway idempotente por (sessionId, clientMessageId) e reads[].
import { beforeAll, describe, expect, it } from 'vitest'
import { port, portTesting } from './support'

let P: any
let T: any

beforeAll(async () => {
  P = await port()
  T = await portTesting()
})

const inbound = (message: Record<string, unknown>) => ({
  v: 1,
  type: 'message.inbound',
  session_id: 'sess-1',
  at: '2026-10-16T12:00:00.000Z',
  message: { id: 'M1', from: '5511999998888@s.whatsapp.net', from_me: false, timestamp: 1_760_000_000_000, type: 'conversation', text: 'oi', ...message },
})

async function sessionId(gw: any): Promise<string> {
  const s = await gw.sessions?.create?.({ name: 'T21', phone: '+5511999990000' }).catch(() => undefined)
  return s?.id ?? 'sess-t21'
}

const req = (sid: string, extra: Record<string, unknown> = {}) => ({
  sessionId: sid,
  phone: '+5511988887777',
  content: { text: 'olá' },
  actor: 'crm:user-t21',
  ...extra,
})

describe('T21 — wa-port: historical', () => {
  it('AC-T21-01 parseWaEvent aceita e preserva message.inbound com historical: true', () => {
    const ev = inbound({ historical: true })
    const parsed = P.parseWaEvent(ev)
    expect(parsed.message.historical).toBe(true)
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(ev)
  })

  it('wa-port: historical só aceita true (ausente = mensagem ao vivo)', () => {
    expect(P.parseWaEvent(inbound({})).message.historical).toBeUndefined()
    expect(() => P.parseWaEvent(inbound({ historical: false }))).toThrow()
  })

  it("wa-port: MediaHandle aceita status 'unavailable'", () => {
    const ev = inbound({
      type: 'imageMessage',
      media: { session_id: 'sess-1', message_id: 'M1', mime: 'image/jpeg', size: 10, sha256: null, key: null, status: 'unavailable' },
    })
    expect(P.parseWaEvent(ev).message.media.status).toBe('unavailable')
  })
})

describe('T21 — wa-port: clientMessageId, quoted, viewOnce e markRead (FakeWaGateway)', () => {
  it('wa-port: send com o mesmo (sessionId, clientMessageId) devolve a mesma MessageView sem duplicar sent[]', async () => {
    const gw = new T.FakeWaGateway()
    const sid = await sessionId(gw)
    const a = await gw.send(req(sid, { clientMessageId: 'cmid-1' }))
    const b = await gw.send(req(sid, { clientMessageId: 'cmid-1' }))
    expect(b.id).toBe(a.id)
    expect(a.clientMessageId).toBe('cmid-1')
    expect(gw.sent).toHaveLength(1)
    const c = await gw.send(req(sid, { clientMessageId: 'cmid-2' }))
    expect(c.id).not.toBe(a.id)
    expect(gw.sent).toHaveLength(2)
  })

  it('wa-port: sem clientMessageId, cada send é um envio novo', async () => {
    const gw = new T.FakeWaGateway()
    const sid = await sessionId(gw)
    await gw.send(req(sid))
    await gw.send(req(sid))
    expect(gw.sent).toHaveLength(2)
  })

  it('wa-port: quoted e viewOnce chegam ao sent[] como vieram', async () => {
    const gw = new T.FakeWaGateway()
    const sid = await sessionId(gw)
    await gw.send(req(sid, { quoted: 'WAID-QUOTED', viewOnce: true, content: { image: { url: 'https://example.com/a.jpg' } } }))
    expect(gw.sent[0]).toMatchObject({ quoted: 'WAID-QUOTED', viewOnce: true })
  })

  it('wa-port: markRead(sessionId, chatJid, messageIds) é registrado em reads[]', async () => {
    const gw = new T.FakeWaGateway()
    const sid = await sessionId(gw)
    expect(typeof gw.markRead).toBe('function')
    await gw.markRead(sid, '5511988887777@s.whatsapp.net', ['W1', 'W2'])
    expect(gw.reads).toEqual([{ sessionId: sid, chatJid: '5511988887777@s.whatsapp.net', messageIds: ['W1', 'W2'] }])
  })
})
