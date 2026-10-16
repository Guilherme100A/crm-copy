import { describe, expect, it } from 'vitest'
import { FakeTransport } from './fake'

describe('FakeTransport (AC-T07-05)', () => {
  it('helpers de simulação emitem os eventos e registram envios', async () => {
    const t = new FakeTransport()
    const events: Array<[string, unknown]> = []
    for (const e of ['qr', 'pairing-code', 'connection', 'message', 'receipt', 'lid-mapping', 'contact'] as const) t.on(e, (p) => events.push([e, p]))

    t.emitQr('Q')
    t.emitPairingCode('P1')
    await expect(t.sendMessage('a@s.whatsapp.net', { text: 'x' })).rejects.toMatchObject({ code: 'TRANSPORT_NOT_CONNECTED' })
    t.open()
    const msg = t.receive({ from: 'a@s.whatsapp.net', text: 'oi' })
    t.receipt('OUT-1', 'read')
    t.emitLidMapping('9@lid', '+55 11 98888-7777')
    t.emitContact({ jid: '5511988887777@s.whatsapp.net', name: 'Ana' })

    t.failNextSend(new Error('boom'))
    await expect(t.sendMessage('a@s.whatsapp.net', { text: 'x' })).rejects.toThrow('boom')
    const { messageId } = await t.sendMessage('a@s.whatsapp.net', { text: 'ok' })
    await t.close('forbidden', 403)

    expect(msg).toMatchObject({ from: 'a@s.whatsapp.net', from_me: false, type: 'conversation', text: 'oi', key: { remoteJid: 'a@s.whatsapp.net', id: msg.id } })
    expect(t.sent).toEqual([expect.objectContaining({ messageId, to: 'a@s.whatsapp.net', content: { text: 'ok' } })])
    expect(events.map(([e]) => e)).toEqual(['qr', 'pairing-code', 'connection', 'message', 'receipt', 'lid-mapping', 'contact', 'connection'])
    expect(events[5]![1]).toEqual({ lid: '9@lid', pn: '5511988887777@s.whatsapp.net', phone: '+5511988887777' })
    expect(events[6]![1]).toEqual({ jid: '5511988887777@s.whatsapp.net', phone: '+5511988887777', name: 'Ana' })
    expect(events[7]![1]).toEqual({ state: 'close', reason: 'forbidden', statusCode: 403 })
    expect(await t.listContacts()).toHaveLength(1)
  })

  it('reação, leitura, presença, mídia e close local', async () => {
    const t = new FakeTransport()
    t.open()
    const m = t.receive({ from: 'a@s.whatsapp.net', type: 'imageMessage', data: new Uint8Array([7]) })
    await t.react('a@s.whatsapp.net', m.key, '❤️')
    await t.markRead([m.key])
    await t.sendTyping('a@s.whatsapp.net', true)
    expect(t.reactions[0]).toMatchObject({ key: m.key, text: '❤️' })
    expect(t.reads).toEqual([[m.key]])
    expect(t.presences).toEqual([{ to: 'a@s.whatsapp.net', presence: 'composing' }])
    expect(await t.downloadMedia(m.id)).toEqual(new Uint8Array([7]))
    const conns: unknown[] = []
    t.on('connection', (c) => conns.push(c))
    await t.close()
    expect([t.closed, conns.length]).toEqual([true, 0])
  })
})
