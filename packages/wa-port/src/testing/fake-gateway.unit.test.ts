import { describe, expect, it } from 'vitest'
import { SendRejectedError } from '../errors'
import type { WaEvent } from '../events'
import { FAKE_MEDIA_FIXTURE, FAKE_PAIRING_CODE, FakeWaGateway } from './fake-gateway'

const actor = 'crm:user-1'
const phone = '+5511999990000'

const inbound = (sessionId: string, id = 'in-1'): WaEvent => ({
  v: 1,
  type: 'message.inbound',
  session_id: sessionId,
  at: new Date().toISOString(),
  message: { id, from: '5511999990000@s.whatsapp.net', from_me: false, timestamp: 1, type: 'conversation', text: 'oi' },
})

describe('FakeWaGateway', () => {
  it('send registra em sent[] e devolve MessageView queued', async () => {
    const wa = new FakeWaGateway()
    const { id: sessionId } = await wa.sessions.create({ name: 'Loja', phone })
    const message = await wa.send({ sessionId, phone, content: { text: 'olá' }, actor, contactId: 'c1' })
    expect(message).toMatchObject({ sessionId, phone, status: 'queued', contactId: 'c1', content: { text: 'olá' } })
    expect(wa.sent).toHaveLength(1)
    expect(wa.sent[0]).toMatchObject({ sessionId, phone, content: { text: 'olá' }, actor, messageId: message.id, message: { id: message.id } })
    expect(wa.getMessage(message.id)?.status).toBe('queued')
  })

  it('failNext(SESSION_NOT_CONNECTED) rejeita só o próximo send com 409', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }] })
    wa.failNext('SESSION_NOT_CONNECTED')
    const err = await wa.send({ sessionId: 's1', phone, content: { text: 'a' }, actor }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SendRejectedError)
    expect(err).toMatchObject({ code: 'SESSION_NOT_CONNECTED', status: 409 })
    expect(wa.sent).toHaveLength(0)
    await expect(wa.send({ sessionId: 's1', phone, content: { text: 'b' }, actor })).resolves.toMatchObject({ status: 'queued' })
  })

  it('emit entrega o evento a todos os assinantes; unsubscribe para', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }] })
    const a: WaEvent[] = []
    const b: WaEvent[] = []
    const offA = wa.subscribe((e) => {
      a.push(e)
    })
    wa.onEvent((e) => {
      b.push(e)
    })
    await wa.emit(inbound('s1'))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    offA()
    await wa.emit(inbound('s1', 'in-2'))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
    expect(wa.emitted).toHaveLength(2)
  })

  it('emit rejeita evento inválido', async () => {
    const wa = new FakeWaGateway()
    await expect(wa.emit({ ...inbound('s1'), v: 2 } as unknown as WaEvent)).rejects.toThrow()
  })

  it('simula os gates: actor, sessão inexistente, estado e opt-out', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }, { id: 'p', state: 'PAUSED' }] })
    await expect(wa.send({ sessionId: 's1', phone, content: { text: 'x' } })).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
    await expect(wa.send({ sessionId: 'nope', phone, content: { text: 'x' }, actor })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', status: 404 })
    await expect(wa.send({ sessionId: 'p', phone, content: { text: 'x' }, actor })).rejects.toMatchObject({ code: 'SESSION_NOT_CONNECTED', status: 409 })
    await wa.optOut({ phone, reason: 'SAIR' })
    await expect(wa.send({ sessionId: 's1', phone, content: { text: 'x' }, actor })).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED', status: 403 })
    await wa.recordConsent({ phone, source: 'import' })
    expect(wa.isOptedOut(phone)).toBe(true)
    await wa.recordConsent({ phone, source: 'manual' })
    expect(wa.isOptedOut(phone)).toBe(false)
    expect(wa.consents.map((c) => c.source)).toEqual(['import', 'manual'])
  })

  it('requireConsent exige consentimento registrado', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }], requireConsent: true })
    await expect(wa.send({ sessionId: 's1', phone, content: { text: 'x' }, actor })).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED' })
    await wa.recordConsent({ phone, source: 'inbound' })
    await expect(wa.send({ sessionId: 's1', phone, content: { text: 'x' }, actor })).resolves.toMatchObject({ status: 'queued' })
  })

  it('sessão NEW conecta no primeiro envio (autoConnect) e emite session.state; autoConnect false rejeita', async () => {
    const wa = new FakeWaGateway()
    const events: WaEvent[] = []
    wa.subscribe((e) => {
      events.push(e)
    })
    const s = await wa.sessions.create({ name: 'x' })
    expect(s.status).toBe('NEW')
    await wa.send({ sessionId: s.id, phone, content: { text: 'x' }, actor })
    expect((await wa.sessions.get(s.id)).status).toBe('WARMING')
    expect(events.map((e) => e.type)).toEqual(['session.state', 'session.connection'])

    const strict = new FakeWaGateway({ autoConnect: false })
    const t = await strict.sessions.create({ name: 'y' })
    await expect(strict.send({ sessionId: t.id, phone, content: { text: 'x' }, actor })).rejects.toMatchObject({ code: 'SESSION_NOT_CONNECTED' })
  })

  it('sendGroup valida o JID e a participação no grupo', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }] })
    wa.setGroups('s1', [
      { id: 'g1@g.us', name: 'G1', participants: 3, announce: false },
      { id: 'g2@g.us', name: 'G2', participants: 3, announce: true, isAdmin: false },
    ])
    await expect(wa.sendGroup({ sessionId: 's1', groupId: 'x', content: { text: 'a' }, actor })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 })
    await expect(wa.sendGroup({ sessionId: 's1', groupId: 'g2@g.us', content: { text: 'a' }, actor })).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED' })
    await expect(wa.sendGroup({ sessionId: 's1', groupId: 'g1@g.us', content: { text: 'a' }, actor })).resolves.toMatchObject({ phone: 'g1@g.us' })
    expect(await wa.fetchGroups('s1')).toHaveLength(2)
  })

  it('react e deleteForEveryone passam pelo send', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }] })
    await wa.react({ sessionId: 's1', phone, messageId: 'wamid-1', emoji: 'ok', actor })
    await wa.deleteForEveryone({ sessionId: 's1', phone, messageId: 'wamid-2', actor })
    expect(wa.sent.map((s) => s.content)).toEqual([{ react: { messageId: 'wamid-1', emoji: 'ok' } }, { delete: { messageId: 'wamid-2' } }])
  })

  it('cancel só cancela mensagem na fila; setMessageStatus emite message.status', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }] })
    const events: WaEvent[] = []
    wa.subscribe((e) => {
      events.push(e)
    })
    const m1 = await wa.send({ sessionId: 's1', phone, content: { text: '1' }, actor })
    expect(await wa.cancel(m1.id)).toMatchObject({ status: 'cancelled' })
    const m2 = await wa.send({ sessionId: 's1', phone, content: { text: '2' }, actor })
    const sent = await wa.setMessageStatus(m2.id, 'sent')
    expect(sent.transportMessageId).toBeTruthy()
    expect(events.at(-1)).toMatchObject({ type: 'message.status', message_id: m2.id, status: 'sent' })
    await expect(wa.cancel(m2.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION', status: 409 })
    await expect(wa.cancel('nope')).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND', status: 404 })
  })

  it('sessões simuladas: QR, pairing code, pause/resume, logout e remove', async () => {
    const wa = new FakeWaGateway()
    const types: string[] = []
    wa.subscribe((e) => {
      types.push(e.type)
    })
    const s = await wa.sessions.create({ name: 'x', phone })
    expect(await wa.sessions.getQr(s.id)).toEqual({ qr: null, generatedAt: null })
    await wa.sessions.startQr(s.id)
    expect((await wa.sessions.getQr(s.id)).qr).toMatch(/^data:image\/png;base64,/)
    expect(await wa.sessions.requestPairingCode(s.id)).toEqual({ code: FAKE_PAIRING_CODE })
    await expect(wa.sessions.pause(s.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    await wa.connect(s.id)
    expect((await wa.sessions.pause(s.id)).status).toBe('PAUSED')
    expect((await wa.sessions.resume(s.id)).status).toBe('WARMING')
    expect((await wa.sessions.logout(s.id)).status).toBe('DISCONNECTED')
    expect(await wa.sessions.remove(s.id)).toEqual({ deletedProxyId: null })
    await expect(wa.sessions.get(s.id)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', status: 404 })
    expect(types).toContain('session.qr')
    expect(types).toContain('session.pairing_code')
  })

  it('downloadMedia devolve a fixture ou a mídia registrada', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }] })
    const handle = { session_id: 's1', message_id: 'm1', mime: 'image/jpeg', size: null, sha256: null, key: null, status: 'pending' as const }
    expect(await wa.downloadMedia('s1', handle)).toEqual(FAKE_MEDIA_FIXTURE)
    wa.setMedia('m1', new Uint8Array([1, 2, 3]))
    expect(Array.from(await wa.downloadMedia('s1', handle))).toEqual([1, 2, 3])
    await expect(wa.downloadMedia('s1', { ...handle, session_id: 'other' })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' })
  })

  it('presence, listContacts, profile e capacidades', async () => {
    const wa = new FakeWaGateway({ sessions: [{ id: 's1' }], capabilities: { calls: true } })
    expect(wa.capabilities).toEqual({ nativeButtons: false, nativeCarousel: false, calls: true, labelsSync: false, businessProfile: false })
    expect(new FakeWaGateway().capabilities.calls).toBe(false)
    await wa.presence('s1', phone, 'composing')
    expect(wa.presences).toEqual([{ sessionId: 's1', to: phone, kind: 'composing' }])
    wa.setContacts('s1', [{ jid: '1@s.whatsapp.net', phone, lid: null, name: 'Ana', pushName: null }])
    expect(await wa.listContacts('s1')).toHaveLength(1)
    await wa.profile.setName?.('s1', 'Loja')
    expect(await wa.profile.get('s1')).toMatchObject({ name: 'Loja' })
  })
})
