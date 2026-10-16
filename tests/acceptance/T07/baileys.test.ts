import { describe, expect, it } from 'vitest'
import { AUTH, boom, exp, flush, LID, PN, rawMessage, setup } from './contract'

async function connected() {
  const s = setup()
  await s.t.connect({ sessionId: 'sess-1', auth: AUTH })
  s.sockets[0]!.ev.emit('connection.update', { connection: 'open' })
  await flush()
  return s
}

describe('T07 — BaileysTransport: mensagens recebidas', () => {
  it('AC-T07-01 messages.upsert notify emite message com alt_jid vindo de key.remoteJidAlt', async () => {
    const { sockets, of } = await connected()
    sockets[0]!.ev.emit('messages.upsert', { type: 'notify', messages: [rawMessage('M1')] })
    await flush()

    const msgs = of('message')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ id: 'M1', from: LID, alt_jid: PN, from_me: false, text: 'oi' })
    expect(msgs[0].historical ?? false).toBe(false)
    expect(msgs[0].timestamp).toBe(1_760_486_400_000)
  })

  it("AC-T07-01 messages.upsert append emite com historical: true (não como mensagem nova)", async () => {
    const { sockets, of } = await connected()
    sockets[0]!.ev.emit('messages.upsert', { type: 'append', messages: [rawMessage('H1'), rawMessage('H2')] })
    await flush()

    const msgs = of('message')
    expect(msgs.map((m) => m.id)).toEqual(['H1', 'H2'])
    for (const m of msgs) expect(m.historical, m.id).toBe(true)
    expect(msgs[0].alt_jid).toBe(PN)

    // notify depois do append continua chegando como nova
    sockets[0]!.ev.emit('messages.upsert', { type: 'notify', messages: [rawMessage('N1')] })
    await flush()
    const novas = of('message').filter((m) => !m.historical)
    expect(novas.map((m) => m.id)).toEqual(['N1'])
  })

  it('AC-T07-02 contextInfo.externalAdReply { sourceId, ctwaClid, sourceUrl } produz ad preenchido', async () => {
    const { sockets, of } = await connected()
    const message = {
      extendedTextMessage: {
        text: 'Olá! Vi o anúncio',
        contextInfo: {
          externalAdReply: {
            sourceId: '120210000000000001',
            ctwaClid: 'ARAkLkA8rmlFeiCktEJQ',
            sourceUrl: 'https://fb.me/abc123',
            sourceType: 'ad',
            title: 'Promoção',
            body: 'Clique',
            thumbnailUrl: 'https://scontent.example/thumb.jpg',
            mediaType: 1,
          },
        },
      },
    }
    sockets[0]!.ev.emit('messages.upsert', { type: 'notify', messages: [rawMessage('AD1', message)] })
    await flush()

    const [m] = of('message')
    expect(m.text).toBe('Olá! Vi o anúncio')
    expect(m.ad).toMatchObject({ source_id: '120210000000000001', ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ', source_url: 'https://fb.me/abc123' })
  })

  it('AC-T07-02 sem os campos de anúncio, ad é undefined e nada lança', async () => {
    const { sockets, of } = await connected()
    const variants = [
      { conversation: 'sem contexto' },
      { extendedTextMessage: { text: 'contexto vazio', contextInfo: {} } },
      { extendedTextMessage: { text: 'reply sem campos', contextInfo: { externalAdReply: { title: 'x' } } } },
      { extendedTextMessage: { text: 'reply nulo', contextInfo: { externalAdReply: null } } },
    ]
    variants.forEach((message, i) => sockets[0]!.ev.emit('messages.upsert', { type: 'notify', messages: [rawMessage(`P${i}`, message)] }))
    await flush()

    const msgs = of('message')
    expect(msgs.map((m) => m.id)).toEqual(['P0', 'P1', 'P2', 'P3'])
    for (const m of msgs) expect(m.ad, m.id).toBeUndefined()
  })
})

describe('T07 — BaileysTransport: conexão', () => {
  it('AC-T07-03 mapDisconnectReason: 401 → loggedOut, 403 → forbidden, 515 e demais → transient', () => {
    const map = exp('mapDisconnectReason')
    expect(map(401)).toBe('loggedOut')
    expect(map(403)).toBe('forbidden')
    for (const code of [515, 408, 428, 440, 500, 503, undefined]) expect(map(code), String(code)).toBe('transient')
  })

  it('AC-T07-03 connection.update close traduz o DisconnectReason do Boom no evento connection', async () => {
    const { t, sockets, of } = setup()
    const codes = [401, 403, 515, 428]
    for (const code of codes) {
      await t.connect({ sessionId: 'sess-1', auth: AUTH })
      const sock = sockets.at(-1)!
      sock.ev.emit('connection.update', { connection: 'open' })
      sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: boom(code) } })
      await flush()
    }
    const closes = of('connection').filter((u) => u.state === 'close')
    expect(closes.map((u) => u.reason)).toEqual(['loggedOut', 'forbidden', 'transient', 'transient'])
    expect(of('connection').filter((u) => u.state === 'open')).toHaveLength(codes.length)
  })

  it('AC-T07-03 eventos de um socket já substituído são ignorados', async () => {
    const { t, sockets, of, events } = setup()
    await t.connect({ sessionId: 'sess-1', auth: AUTH })
    sockets[0]!.ev.emit('connection.update', { connection: 'open' })
    await flush()
    await t.connect({ sessionId: 'sess-1', auth: AUTH })
    expect(sockets).toHaveLength(2)
    await flush()
    const before = events.length

    const old = sockets[0]!
    old.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: boom(401) } })
    old.ev.emit('messages.upsert', { type: 'notify', messages: [rawMessage('OLD1')] })
    old.ev.emit('messages.update', [{ key: { id: 'OLD1', remoteJid: PN }, update: { status: 4 } }])
    old.ev.emit('connection.update', { qr: 'QR-ANTIGO' })
    await flush()
    expect(events.slice(before)).toEqual([])

    // o socket atual continua funcionando
    sockets[1]!.ev.emit('connection.update', { connection: 'open' })
    sockets[1]!.ev.emit('messages.upsert', { type: 'notify', messages: [rawMessage('NEW1')] })
    await flush()
    expect(of('message').map((m) => m.id)).toEqual(['NEW1'])
    expect(of('connection').at(-1)).toMatchObject({ state: 'open' })
  })
})

describe('T07 — BaileysTransport: envios', () => {
  it("AC-T07-04 áudio com ptt: true envia mimetype 'audio/ogg; codecs=opus'", async () => {
    const { t, sockets } = await connected()
    await t.sendMessage(PN, { audio: { url: 'file:///tmp/voz.ogg' }, ptt: true })
    const call = sockets[0]!.sentCalls.at(-1)!
    expect(call.jid).toBe(PN)
    expect(call.content.ptt).toBe(true)
    expect(call.content.mimetype).toBe('audio/ogg; codecs=opus')
    expect(call.content.audio).toBeDefined()
  })

  it('AC-T07-04 reação envia { react: { text, key } } com a key original completa', async () => {
    const { t, sockets } = await connected()
    const key = { remoteJid: '1203630000000@g.us', fromMe: false, id: '3EB0ABCDEF123456', participant: LID }
    await t.react('1203630000000@g.us', key, '👍')
    const call = sockets[0]!.sentCalls.at(-1)!
    expect(call.content).toEqual({ react: { text: '👍', key } })
    expect(call.content.react.key).toEqual({ remoteJid: '1203630000000@g.us', fromMe: false, id: '3EB0ABCDEF123456', participant: LID })

    const key2 = { remoteJid: PN, fromMe: true, id: 'ABC' }
    await t.react(PN, key2, '')
    expect(sockets[0]!.sentCalls.at(-1)!.content).toEqual({ react: { text: '', key: key2 } })
  })
})
