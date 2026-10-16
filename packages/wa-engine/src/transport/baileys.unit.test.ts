import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BaileysTransport, PTT_MIMETYPE, ackFor, mapDisconnectReason, type BaileysSocketConfig, type BaileysSocketLike } from './baileys'
import type { ConnectOptions, IncomingMessage } from './types'

function fakeSocket() {
  const ev = new EventEmitter()
  const ws = new EventEmitter()
  let n = 0
  const sock = {
    ev,
    ws,
    user: { id: '5511999990000:3@s.whatsapp.net' },
    sendMessage: vi.fn(async (_jid: string, content: Record<string, unknown>) => ({ key: { id: `OUT-${++n}` }, message: { conversation: String(content.text ?? '') } })),
    end: vi.fn(),
    logout: vi.fn(async () => undefined),
    requestPairingCode: vi.fn(async () => 'ABCD1234'),
    readMessages: vi.fn(async () => undefined),
    sendPresenceUpdate: vi.fn(async () => undefined),
    sendNode: vi.fn(async () => undefined),
    groupFetchAllParticipating: vi.fn(async () => ({ 'g1@g.us': { id: 'g1@g.us', subject: 'G', participants: [] } })),
  } satisfies BaileysSocketLike
  return sock
}

const auth = { creds: { registered: true }, keys: {} } as unknown as ConnectOptions['auth']
const flush = () => new Promise((r) => setTimeout(r, 0))

async function connected() {
  const socks: ReturnType<typeof fakeSocket>[] = []
  const configs: BaileysSocketConfig[] = []
  const t = new BaileysTransport({
    makeSocket: (config) => {
      configs.push(config)
      const s = fakeSocket()
      socks.push(s)
      return s
    },
  })
  const messages: IncomingMessage[] = []
  t.on('message', (m) => messages.push(m))
  await t.connect({ sessionId: 's1', auth })
  socks[0]!.ev.emit('connection.update', { connection: 'open' })
  await flush()
  return { t, socks, configs, messages }
}

describe('BaileysTransport', () => {
  it('config: markOnlineOnConnect false, getMessage, cachedGroupMetadata e fingerprint por sessão', async () => {
    const { configs } = await connected()
    expect(configs[0]).toMatchObject({ markOnlineOnConnect: false })
    expect(typeof configs[0]!.getMessage).toBe('function')
    expect(typeof configs[0]!.cachedGroupMetadata).toBe('function')
    expect(configs[0]!.browser).toHaveLength(3)
  })

  it('notify emite message com alt_jid; append emite com historical (AC-T07-01)', async () => {
    const { socks, messages } = await connected()
    const key = { id: 'M1', remoteJid: '123@lid', remoteJidAlt: '5511988887777@s.whatsapp.net', fromMe: false }
    socks[0]!.ev.emit('messages.upsert', { type: 'notify', messages: [{ key, message: { conversation: 'oi' }, messageTimestamp: 1700000000, pushName: 'Ana' }] })
    socks[0]!.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { ...key, id: 'M2' }, message: { conversation: 'velha' } }] })
    await flush()
    expect(messages[0]).toMatchObject({ id: 'M1', from: '123@lid', alt_jid: '5511988887777@s.whatsapp.net', text: 'oi', push_name: 'Ana', timestamp: 1700000000000 })
    expect(messages[0]!.historical).toBeUndefined()
    expect(messages[1]).toMatchObject({ id: 'M2', historical: true })
  })

  it('externalAdReply vira ad; sem os campos, ad undefined (AC-T07-02)', async () => {
    const { socks, messages } = await connected()
    const ctx = { externalAdReply: { sourceId: '120', ctwaClid: 'clid-1', sourceUrl: 'https://fb.me/x', thumbnailUrl: 'https://img', title: 'Promo' }, stanzaId: 'Q1' }
    socks[0]!.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { id: 'A1', remoteJid: '5511@s.whatsapp.net' }, message: { extendedTextMessage: { text: 'quero', contextInfo: ctx } } },
        { key: { id: 'A2', remoteJid: '5511@s.whatsapp.net' }, message: { extendedTextMessage: { text: 'x', contextInfo: { externalAdReply: { title: 'só título' } } } } },
      ],
    })
    await flush()
    expect(messages[0]!.ad).toEqual({ source_id: '120', ctwa_clid: 'clid-1', source_url: 'https://fb.me/x', media_url: 'https://img', title: 'Promo' })
    expect(messages[0]!.quoted_id).toBe('Q1')
    expect(messages[1]!.ad).toBeUndefined()
  })

  it('DisconnectReason e guarda de socket substituído (AC-T07-03)', async () => {
    expect([401, 403, 515, 428, undefined].map(mapDisconnectReason)).toEqual(['loggedOut', 'forbidden', 'transient', 'transient', 'transient'])
    const { t, socks, messages } = await connected()
    const conns: unknown[] = []
    t.on('connection', (u) => conns.push(u))
    await t.connect({ sessionId: 's1', auth })
    socks[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } })
    socks[0]!.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'X', remoteJid: 'a@s.whatsapp.net' }, message: { conversation: 'x' } }] })
    await flush()
    expect(conns).toEqual([])
    expect(messages).toEqual([])
    socks[1]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 403 } } } })
    await flush()
    expect(conns).toEqual([{ state: 'close', reason: 'forbidden', statusCode: 403 }])
  })

  it('PTT com mimetype opus e reação com a key original (AC-T07-04)', async () => {
    const { t, socks } = await connected()
    await t.sendMessage('5511@s.whatsapp.net', { audio: { url: 'file:///a.ogg' }, ptt: true, mimetype: 'audio/mpeg' })
    expect(socks[0]!.sendMessage).toHaveBeenLastCalledWith('5511@s.whatsapp.net', { audio: { url: 'file:///a.ogg' }, ptt: true, mimetype: PTT_MIMETYPE })
    const key = { remoteJid: '5511@s.whatsapp.net', fromMe: false, id: 'M9', participant: 'p@s.whatsapp.net' }
    await t.react('5511@s.whatsapp.net', key, '👍')
    expect(socks[0]!.sendMessage).toHaveBeenLastCalledWith('5511@s.whatsapp.net', { react: { text: '👍', key } })
    expect((socks[0]!.sendMessage.mock.lastCall![1] as { react: { key: unknown } }).react.key).toBe(key)
  })

  it('recibos, presença, leitura, apagar e ack de status', async () => {
    const { t, socks } = await connected()
    const receipts: unknown[] = []
    t.on('receipt', (r) => receipts.push(r))
    socks[0]!.ev.emit('messages.update', [{ key: { id: 'O1', fromMe: true }, update: { status: 3 } }, { key: { id: 'O1', fromMe: true }, update: { status: 5 } }, { key: { id: 'I', fromMe: false }, update: { status: 4 } }])
    socks[0]!.ws.emit('CB:status', { tag: 'status', attrs: { id: 'S1', from: 'x@s.whatsapp.net' } })
    await flush()
    expect(receipts).toEqual([{ messageId: 'O1', status: 'delivered' }, { messageId: 'O1', status: 'read' }])
    expect(socks[0]!.sendNode).toHaveBeenCalledWith(ackFor({ tag: 'status', attrs: { id: 'S1', from: 'x@s.whatsapp.net' } }))
    await t.sendPresence('a@s.whatsapp.net', 'recording')
    expect(socks[0]!.sendPresenceUpdate).toHaveBeenCalledWith('recording', 'a@s.whatsapp.net')
    await t.markRead([{ id: 'I', remoteJid: 'a@s.whatsapp.net' }])
    expect(socks[0]!.readMessages).toHaveBeenCalledWith([{ id: 'I', remoteJid: 'a@s.whatsapp.net' }])
    await t.deleteForEveryone('a@s.whatsapp.net', { id: 'O1', fromMe: true, remoteJid: 'a@s.whatsapp.net' })
    expect(socks[0]!.sendMessage).toHaveBeenLastCalledWith('a@s.whatsapp.net', { delete: { id: 'O1', fromMe: true, remoteJid: 'a@s.whatsapp.net' } })
    expect(t.ownPhone()).toBe('+5511999990000')
  })

  it('contatos, lid-mapping, presença e histórico', async () => {
    const { t, socks, messages } = await connected()
    const got: Record<string, unknown[]> = { contact: [], lid: [], presence: [], history: [] }
    t.on('contact', (c) => got.contact!.push(c))
    t.on('lid-mapping', (m) => got.lid!.push(m))
    t.on('presence', (p) => got.presence!.push(p))
    t.on('history', (h) => got.history!.push(h))
    socks[0]!.ev.emit('contacts.upsert', [{ id: '99@lid', phoneNumber: '5511977776666@s.whatsapp.net', notify: 'Bia' }])
    socks[0]!.ev.emit('contacts.update', [{ id: '99@lid', name: 'Beatriz' }])
    socks[0]!.ev.emit('lid-mapping.update', { lid: '99@lid', pn: '5511977776666:2@s.whatsapp.net' })
    socks[0]!.ev.emit('presence.update', { id: 'a@s.whatsapp.net', presences: { 'a@s.whatsapp.net': { lastKnownPresence: 'composing' } } })
    socks[0]!.ev.emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [{ key: { id: 'H1', remoteJid: 'a@s.whatsapp.net' }, message: { conversation: 'antiga' } }],
      lidPnMappings: [{ lid: '1@lid', pn: '5511911112222@s.whatsapp.net' }],
      isLatest: true,
      syncType: 2,
    })
    await flush()
    expect(got.contact![1]).toEqual({ jid: '99@lid', phone: '+5511977776666', lid: '99@lid', push_name: 'Bia', name: 'Beatriz' })
    expect(await t.listContacts()).toHaveLength(1)
    expect(got.lid).toEqual([{ lid: '99@lid', pn: '5511977776666@s.whatsapp.net', phone: '+5511977776666' }])
    expect(got.presence).toEqual([{ jid: 'a@s.whatsapp.net', presence: 'composing' }])
    expect(got.history![0]).toMatchObject({ is_latest: true, sync_type: '2', lid_mappings: [{ lid: '1@lid', phone: '+5511911112222' }], messages: [{ id: 'H1', historical: true }] })
    expect(messages).toHaveLength(0)
  })

  it('downloadMedia usa a mensagem guardada; getMessage acha o que foi enviado', async () => {
    const download = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const sock = fakeSocket()
    let cfg: BaileysSocketConfig | undefined
    const t = new BaileysTransport({ makeSocket: (c) => ((cfg = c), sock), downloadMedia: download })
    await t.connect({ sessionId: 's', auth })
    sock.ev.emit('connection.update', { connection: 'open' })
    sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'IMG', remoteJid: 'a@s.whatsapp.net' }, message: { imageMessage: { mimetype: 'image/png', fileLength: 10 } } }] })
    await flush()
    expect(await t.downloadMedia('IMG')).toEqual(new Uint8Array([1, 2, 3]))
    await expect(t.downloadMedia('NOPE')).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' })
    const { messageId } = await t.sendMessage('a@s.whatsapp.net', { text: 'oi' })
    expect(await cfg!.getMessage!({ id: messageId })).toEqual({ conversation: 'oi' })
  })

  it('pede pairing code uma vez quando não registrado', async () => {
    const sock = fakeSocket()
    const t = new BaileysTransport({ makeSocket: () => sock })
    const codes: string[] = []
    t.on('pairing-code', (c) => codes.push(c))
    await t.connect({ sessionId: 's', auth: { creds: { registered: false }, keys: {} } as unknown as ConnectOptions['auth'], pairingPhone: '+55 11 99999-0000' })
    sock.ev.emit('connection.update', { qr: 'q1' })
    sock.ev.emit('connection.update', { qr: 'q2' })
    await flush()
    await flush()
    expect(sock.requestPairingCode).toHaveBeenCalledTimes(1)
    expect(sock.requestPairingCode).toHaveBeenCalledWith('5511999990000')
    expect(codes).toEqual(['ABCD1234'])
  })

  it('sem conexão aberta, envio lança TransportNotConnectedError', async () => {
    const t = new BaileysTransport({ makeSocket: () => fakeSocket() })
    await t.connect({ sessionId: 's', auth })
    await expect(t.sendMessage('a@s.whatsapp.net', { text: 'x' })).rejects.toMatchObject({ code: 'TRANSPORT_NOT_CONNECTED' })
  })
})
