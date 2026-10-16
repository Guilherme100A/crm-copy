// Acréscimos da T21 à porta (todos opcionais): historical, mídia unavailable, clientMessageId, quoted, viewOnce, markRead.
import { describe, expect, it } from 'vitest'
import { parseWaEvent, type WaEvent } from './events'
import { FakeWaGateway } from './testing/fake-gateway'

const at = '2026-10-15T12:00:00.000Z'
const actor = 'crm:u1'
const phone = '+5511999990400'

describe('WaEvent: acréscimos da T21', () => {
  it('message.inbound preserva historical: true; outro valor é recusado', () => {
    const event: WaEvent = {
      v: 1,
      type: 'message.inbound',
      session_id: 's1',
      at,
      message: { id: 'h1', from: '5511@s.whatsapp.net', from_me: false, timestamp: 1, type: 'conversation', text: 'antiga', historical: true },
    }
    const json = JSON.stringify(event)
    expect(JSON.stringify(parseWaEvent(json))).toBe(json)
    expect(() => parseWaEvent({ ...event, message: { ...event.message, historical: false } })).toThrow()
  })

  it('media.status aceita unavailable', () => {
    const media = { session_id: 's1', message_id: 'm', mime: 'image/png', size: 1, sha256: null, key: null, status: 'unavailable' as const }
    const event: WaEvent = { v: 1, type: 'message.inbound', session_id: 's1', at, message: { id: 'm', from: 'x@s.whatsapp.net', from_me: false, timestamp: 1, type: 'imageMessage', media } }
    expect(parseWaEvent(event)).toEqual(event)
  })
})

describe('FakeWaGateway: acréscimos da T21', () => {
  it('clientMessageId: o mesmo (sessão, id) devolve a mesma mensagem sem novo envio; quoted e viewOnce são registrados', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }, { id: 's2' }] })
    const req = { sessionId: 's1', phone, content: { text: 'oi' }, actor, clientMessageId: 'c-1', quoted: 'wamid-x', viewOnce: true }
    const a = await wa.send(req)
    const b = await wa.send(req)
    expect(b).toEqual(a)
    expect(a.clientMessageId).toBe('c-1')
    expect(wa.sent).toHaveLength(1)
    expect(wa.sent[0]).toMatchObject({ clientMessageId: 'c-1', quoted: 'wamid-x', viewOnce: true })
    // Outra sessão com o mesmo id é outro envio; sem clientMessageId nada é deduplicado.
    expect((await wa.send({ ...req, sessionId: 's2' })).id).not.toBe(a.id)
    await wa.send({ sessionId: 's1', phone, content: { text: 'oi' }, actor })
    await wa.send({ sessionId: 's1', phone, content: { text: 'oi' }, actor })
    expect(wa.sent).toHaveLength(4)
    wa.reset()
    expect(wa.sent).toHaveLength(0)
  })

  it('markRead registra sessão, chat e ids', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }] })
    await wa.markRead('s1', '5511@s.whatsapp.net', ['a', 'b'])
    expect(wa.reads).toEqual([{ sessionId: 's1', chatJid: '5511@s.whatsapp.net', messageIds: ['a', 'b'] }])
    await expect(wa.markRead('nope', 'x', [])).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})
