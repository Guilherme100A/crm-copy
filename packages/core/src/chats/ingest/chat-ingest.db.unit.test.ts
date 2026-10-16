// Postgres real (SPEC 3.10): banco descartável; FakeWaGateway e publisher em memória.
import { randomBytes } from 'node:crypto'
import { auditLogs, chats, companies, connections, contacts, createDb, messages, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import type { IncomingMessage, WaEvent } from '@crm/wa-port'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChatIngest, type CrmInboundEvent } from './chat-ingest'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

const AT = '2026-10-16T12:00:00.000Z'

async function setup(settings: Record<string, unknown> = {}) {
  const slug = `c-${randomBytes(4).toString('hex')}`
  const [company] = await db.insert(companies).values({ name: slug, slug, settings }).returning({ id: companies.id })
  const companyId = company!.id
  const sessionId = `sess-${randomBytes(4).toString('hex')}`
  // T40: chats.connection_id referencia crm.connections; a conexão precisa existir.
  const [connection] = await db.insert(connections).values({ companyId, sessionId, name: 'Conexão teste' }).returning({ id: connections.id })
  const connectionId = connection!.id
  const gw = new FakeWaGateway()
  const published: Array<{ type: string; data: Record<string, unknown> }> = []
  const inbound: CrmInboundEvent[] = []
  const ingest = new ChatIngest({
    db,
    waGateway: gw,
    publisher: { publish: async (_c, type, data) => void published.push({ type, data: data as Record<string, unknown> }) },
    resolveConnection: async (sid) => (sid === sessionId ? { companyId, connectionId } : null),
    onInbound: (e) => void inbound.push(e),
  })
  let n = 0
  const msg = (over: Partial<IncomingMessage> & { historical?: boolean } = {}): WaEvent =>
    ({
      v: 1,
      type: 'message.inbound',
      session_id: sessionId,
      at: AT,
      message: { id: `WA-${++n}-${randomBytes(3).toString('hex')}`, from: '5511999990001@s.whatsapp.net', from_me: false, timestamp: Date.parse(AT) + n, type: 'conversation', text: 'oi', ...over },
    }) as WaEvent
  const chatOf = async (contactId: string) => (await db.select().from(chats).where(and(eq(chats.companyId, companyId), eq(chats.contactId, contactId))))[0]!
  return { companyId, connectionId, sessionId, gw, published, inbound, ingest, msg, chatOf }
}

describe('ChatIngest', () => {
  it('1ª mensagem cria contato (consentimento inbound), chat waiting e eventos; reentrega não duplica (AC-01/02)', async () => {
    const s = await setup()
    const ev = s.msg({ push_name: 'Ana' })
    const out = await s.ingest.handle(ev)
    expect(out).toMatchObject({ status: 'stored', chatCreated: true, contactCreated: true })
    expect(await s.ingest.handle(ev)).toMatchObject({ status: 'duplicate' })
    const [contact] = await db.select().from(contacts).where(eq(contacts.companyId, s.companyId))
    expect(contact).toMatchObject({ phoneE164: '+5511999990001', consentSource: 'inbound', origin: 'whatsapp', name: 'Ana' })
    expect(s.gw.consents).toEqual([expect.objectContaining({ phone: '+5511999990001', source: 'inbound' })])
    const chat = await s.chatOf(contact!.id)
    expect(chat).toMatchObject({ status: 'waiting', unreadCount: 1, lastMessagePreview: 'oi' })
    expect(s.published.map((p) => p.type)).toEqual(['chat.created', 'message.created', 'contact.updated'])
    expect(s.inbound).toHaveLength(1)
    expect(await db.select().from(messages).where(eq(messages.chatId, chat.id))).toHaveLength(1)
  })

  it('resolved reabre para waiting; histórica não mexe em status/não lidas nem dispara crm.inbound (AC-03)', async () => {
    const s = await setup()
    const first = await s.ingest.handle(s.msg())
    const chatId = (first as { chatId: string }).chatId
    await db.update(chats).set({ status: 'resolved', unreadCount: 0, resolvedAt: new Date() }).where(eq(chats.id, chatId))
    await s.ingest.handle(s.msg({ historical: true, text: 'velha' }))
    let [chat] = await db.select().from(chats).where(eq(chats.id, chatId))
    expect(chat).toMatchObject({ status: 'resolved', unreadCount: 0 })
    expect(s.inbound).toHaveLength(1)
    await s.ingest.handle({ v: 1, type: 'history.batch', session_id: s.sessionId, at: AT, messages: [(s.msg({ text: 'lote' }) as { message: IncomingMessage }).message] } as WaEvent)
    ;[chat] = await db.select().from(chats).where(eq(chats.id, chatId))
    expect(chat).toMatchObject({ status: 'resolved', unreadCount: 0 })
    await s.ingest.handle(s.msg({ text: 'voltei' }))
    ;[chat] = await db.select().from(chats).where(eq(chats.id, chatId))
    expect(chat).toMatchObject({ status: 'waiting', unreadCount: 1, resolvedAt: null })
    expect(s.inbound.at(-1)).toMatchObject({ chat_reopened: true, text: 'voltei' })
    expect(await db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(4)
  })

  it('message.status nunca regride; lid_mapping funde contatos e chats (AC-04)', async () => {
    const s = await setup()
    const lidOut = await s.ingest.handle(s.msg({ from: '111222333444555@lid' }))
    const pnOut = await s.ingest.handle(s.msg({ from: '5511988887777@s.whatsapp.net' }))
    const [out] = await db
      .insert(messages)
      .values({ companyId: s.companyId, chatId: (pnOut as { chatId: string }).chatId, direction: 'outbound', senderType: 'user', type: 'text', body: 'olá', status: 'sent', pipelineMessageId: 'PIPE-1' })
      .returning()
    const status = (st: string) => s.ingest.handle({ v: 1, type: 'message.status', session_id: s.sessionId, at: AT, message_id: 'PIPE-1', transport_message_id: 'WAOUT-1', status: st } as WaEvent)
    await status('read')
    await status('delivered')
    await status('failed')
    const [row] = await db.select().from(messages).where(eq(messages.id, out!.id))
    expect(row).toMatchObject({ status: 'read', waMessageId: 'WAOUT-1' })

    const map = () => s.ingest.handle({ v: 1, type: 'contact.lid_mapping', session_id: s.sessionId, at: AT, lid: '111222333444555@lid', pn: '+5511988887777' } as WaEvent)
    await map()
    await map()
    const all = await db.select().from(contacts).where(eq(contacts.companyId, s.companyId))
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ phoneE164: '+5511988887777', waLid: '111222333444555@lid' })
    const chatRows = await db.select().from(chats).where(eq(chats.companyId, s.companyId))
    expect(chatRows).toHaveLength(1)
    expect(chatRows[0]!.unreadCount).toBe(2)
    expect(await db.select().from(messages).where(eq(messages.chatId, chatRows[0]!.id))).toHaveLength(3)
    expect([(lidOut as { chatId: string }).chatId, (pnOut as { chatId: string }).chatId]).toContain(chatRows[0]!.id)
  })

  it('grupo, status e sessão desconhecida são ignorados (AC-05)', async () => {
    const s = await setup()
    expect(await s.ingest.handle(s.msg({ from: '1203630@g.us', participant: '5511@s.whatsapp.net' }))).toMatchObject({ status: 'ignored' })
    expect(await s.ingest.handle(s.msg({ from: 'status@broadcast' }))).toMatchObject({ status: 'ignored' })
    expect(await s.ingest.handle({ ...s.msg(), session_id: 'outra' } as WaEvent)).toMatchObject({ status: 'ignored', reason: 'unknown_session' })
    expect(await db.select().from(contacts).where(eq(contacts.companyId, s.companyId))).toEqual([])
    expect(s.published).toEqual([])
    expect(s.gw.consents).toEqual([])
  })

  it('atribuição de anúncio só na primeira mensagem (AC-06)', async () => {
    const s = await setup()
    await s.ingest.handle(s.msg({ ad: { ctwa_clid: 'clid-1', source_id: '42', source_url: 'https://fb.me/a', media_url: 'https://img/1' } }))
    await s.ingest.handle(s.msg({ ad: { ctwa_clid: 'clid-2', source_id: '99', source_url: 'https://fb.me/b' } }))
    const [c] = await db.select().from(contacts).where(eq(contacts.companyId, s.companyId))
    expect(c).toMatchObject({ ctwaClid: 'clid-1', sourceId: '42', sourceUrl: 'https://fb.me/a', adMediaUrl: 'https://img/1' })
  })

  it('palavra de opt-out marca o contato, chama optOut e audita; lista da empresa substitui a padrão (AC-07)', async () => {
    const s = await setup()
    await s.ingest.handle(s.msg({ text: ' Parar! ' }))
    const [c] = await db.select().from(contacts).where(eq(contacts.companyId, s.companyId))
    expect(c!.optOut).toBe(true)
    expect(s.gw.isOptedOut('+5511999990001')).toBe(true)
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, s.companyId), eq(auditLogs.action, 'contacts.opt_out')))
    expect(audit).toMatchObject({ targetId: c!.id, actorUserId: null, detail: expect.objectContaining({ source: 'inbound_keyword', keyword: 'PARAR' }) })
    expect(s.inbound).toHaveLength(0)

    const custom = await setup({ opt_out_keywords: ['DESCADASTRAR'] })
    await custom.ingest.handle(custom.msg({ text: 'sair' }))
    const [c2] = await db.select().from(contacts).where(eq(contacts.companyId, custom.companyId))
    expect(c2!.optOut).toBe(false)
  })
})
