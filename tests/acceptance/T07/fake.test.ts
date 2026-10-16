import { describe, expect, it } from 'vitest'
import { AUTH, exp, LID, PN } from './contract'

async function fake() {
  const FakeTransport = exp('FakeTransport')
  const t = new FakeTransport()
  const events: Array<{ event: string; payload: any }> = []
  for (const event of ['qr', 'pairing-code', 'connection', 'message', 'receipt', 'contact', 'lid-mapping']) t.on(event, (payload: any) => events.push({ event, payload }))
  await t.connect({ sessionId: 'sess-1', auth: AUTH })
  const of = (event: string) => events.filter((e) => e.event === event).map((e) => e.payload)
  return { t, events, of }
}

describe('T07 — FakeTransport', () => {
  it('AC-T07-05 FakeTransport expõe todos os helpers de simulação', async () => {
    const { t } = await fake()
    for (const name of ['emitQr', 'emitPairingCode', 'open', 'close', 'receive', 'receipt', 'failNextSend', 'emitLidMapping', 'emitContact'])
      expect(typeof t[name], name).toBe('function')
    expect(Array.isArray(t.sent)).toBe(true)
  })

  it('AC-T07-05 emitQr e emitPairingCode emitem qr e pairing-code', async () => {
    const { t, of } = await fake()
    t.emitQr('QR-1')
    t.emitPairingCode('ABCD1234')
    expect(of('qr')).toEqual(['QR-1'])
    expect(JSON.stringify(of('pairing-code'))).toContain('ABCD1234')
  })

  it('AC-T07-05 open e close(reason) emitem connection open/close com o motivo', async () => {
    const { t, of } = await fake()
    t.open()
    t.close('loggedOut')
    t.open()
    t.close('forbidden')
    t.open()
    t.close('transient')
    const ups = of('connection')
    expect(ups.map((u) => u.state)).toEqual(['open', 'close', 'open', 'close', 'open', 'close'])
    expect(ups.filter((u) => u.state === 'close').map((u) => u.reason)).toEqual(['loggedOut', 'forbidden', 'transient'])
  })

  it('AC-T07-05 receive(msg) emite message e receipt(id, status) emite receipt', async () => {
    const { t, of } = await fake()
    t.open()
    t.receive({ id: 'IN-1', from: LID, alt_jid: PN, text: 'oi' })
    expect(of('message')).toHaveLength(1)
    expect(of('message')[0]).toMatchObject({ id: 'IN-1', from: LID, alt_jid: PN, text: 'oi', from_me: false })

    t.receipt('OUT-1', 'delivered')
    t.receipt('OUT-1', 'read')
    expect(of('receipt')).toEqual([expect.objectContaining({ messageId: 'OUT-1', status: 'delivered' }), expect.objectContaining({ messageId: 'OUT-1', status: 'read' })])
  })

  it('AC-T07-05 envios ficam em sent[] e failNextSend faz só o próximo envio falhar', async () => {
    const { t } = await fake()
    t.open()
    const r1 = await t.sendMessage(PN, { text: 'primeiro' })
    expect(typeof r1.messageId).toBe('string')

    t.failNextSend(new Error('falha simulada'))
    await expect(t.sendMessage(PN, { text: 'falha' })).rejects.toThrow()

    const r3 = await t.sendMessage(PN, { text: 'terceiro' })
    expect(t.sent.map((s: any) => s.content)).toEqual([{ text: 'primeiro' }, { text: 'terceiro' }])
    expect(t.sent.map((s: any) => s.to)).toEqual([PN, PN])
    expect(t.sent.map((s: any) => s.messageId)).toEqual([r1.messageId, r3.messageId])
  })

  it('AC-T07-05 emitLidMapping e emitContact emitem lid-mapping e contact', async () => {
    const { t, of } = await fake()
    t.emitLidMapping(LID, PN)
    expect(of('lid-mapping')).toEqual([expect.objectContaining({ lid: LID, pn: PN })])

    t.emitContact({ jid: PN, phone: '+5511999998888', lid: LID, name: 'Maria' })
    expect(of('contact')).toEqual([expect.objectContaining({ jid: PN, phone: '+5511999998888', name: 'Maria' })])
  })
})
