// `recordOutbound` (T120): grava no chat a mensagem automática já enviada, sem reenviar; idempotente pelo id do pipeline.
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chats, companies, connections, contacts, createDb, messages, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore } from '@crm/node-kit'
import type { MessageView } from '@crm/wa-port'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MediaService } from '../../media/service'
import { ChatSendService, describeOutgoing } from './service'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

const view = (id: string, over: Partial<MessageView> = {}): MessageView => ({
  id,
  sessionId: 's',
  contactId: null,
  phone: '+5511999990001',
  content: {},
  status: 'queued',
  attempts: 0,
  lastError: null,
  transportMessageId: null,
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
})

async function setup() {
  const slug = `r-${randomBytes(4).toString('hex')}`
  const [company] = await db.insert(companies).values({ name: slug, slug }).returning({ id: companies.id })
  const [contact] = await db.insert(contacts).values({ companyId: company!.id, name: 'Ana', phoneE164: '+5511999990001' }).returning({ id: contacts.id })
  const sessionId = `sess-${slug}`
  const [connection] = await db.insert(connections).values({ companyId: company!.id, sessionId, name: 'Conexão teste' }).returning({ id: connections.id })
  const [chat] = await db.insert(chats).values({ companyId: company!.id, connectionId: connection!.id, contactId: contact!.id }).returning()
  const published: string[] = []
  const send = vi.fn(async () => view('never'))
  const svc = new ChatSendService({
    db,
    waGateway: { send, react: send, deleteForEveryone: send, presence: async () => undefined } as never,
    resolveSession: async () => sessionId,
    media: new MediaService({ blobStore: new FsBlobStore(join(tmpdir(), 't120-record')), signingKey: Buffer.alloc(32, 1) }),
    pttConverter: async () => ({ audio: new Uint8Array(), mime: 'audio/ogg', seconds: 0 }),
    publisher: { publish: async (_c, type) => void published.push(type) },
  })
  return { companyId: company!.id, contactId: contact!.id, sessionId, chatId: chat!.id, svc, published, send }
}

describe('ChatSendService.recordOutbound', () => {
  it('grava como flow/system sem chamar o gateway, atualiza a prévia e publica; repetição não duplica', async () => {
    const s = await setup()
    const first = await s.svc.recordOutbound({
      companyId: s.companyId,
      chatId: s.chatId,
      senderType: 'flow',
      actor: 'flow:run-1',
      content: { text: 'Olá do fluxo' },
      view: view('pipe-1', { status: 'sent', transportMessageId: 'WA-1', sentAt: new Date().toISOString() }),
    })
    expect(first).toMatchObject({ direction: 'outbound', sender_type: 'flow', type: 'text', body: 'Olá do fluxo', status: 'sent', wa_message_id: 'WA-1', pipeline_message_id: 'pipe-1', media: { actor: 'flow:run-1' } })
    const again = await s.svc.recordOutbound({ companyId: s.companyId, chatId: s.chatId, senderType: 'flow', actor: 'flow:run-1', content: { text: 'Olá do fluxo' }, view: view('pipe-1') })
    expect(again?.id).toBe(first!.id)
    expect(await db.select().from(messages).where(eq(messages.chatId, s.chatId))).toHaveLength(1)
    expect(s.send).not.toHaveBeenCalled()
    expect(s.published).toEqual(['message.created', 'chat.updated'])
    const [chat] = await db.select().from(chats).where(eq(chats.id, s.chatId))
    expect(chat).toMatchObject({ lastMessagePreview: 'Olá do fluxo', assignedUserId: null, status: 'waiting' })

    const sys = await s.svc.recordOutbound({ companyId: s.companyId, chatId: s.chatId, senderType: 'system', actor: 'crm:system:business-hours', content: { text: 'Fora do horário' }, view: view('pipe-2') })
    expect(sys).toMatchObject({ sender_type: 'system', body: 'Fora do horário', status: 'queued' })
  })

  it('sem chatId acha o chat pelo contato + sessão; sem chat devolve null', async () => {
    const s = await setup()
    const rec = await s.svc.recordOutbound({ companyId: s.companyId, contactId: s.contactId, sessionId: s.sessionId, senderType: 'flow', actor: 'flow:x', content: { text: 'oi' }, view: view(`p-${s.chatId}`) })
    expect(rec?.chat_id).toBe(s.chatId)
    expect(await s.svc.recordOutbound({ companyId: s.companyId, contactId: s.contactId, sessionId: 'outra', senderType: 'flow', actor: 'flow:x', content: { text: 'oi' }, view: view('p-none') })).toBeNull()
  })
})

describe('describeOutgoing', () => {
  it('mapeia texto, mídia blob, contato e localização', () => {
    expect(describeOutgoing({ text: 'a' })).toEqual({ type: 'text', body: 'a', media: null })
    expect(describeOutgoing({ image: { url: 'blob:abc' }, caption: 'foto', mimetype: 'image/png' })).toEqual({ type: 'image', body: 'foto', media: { key: 'abc', mime: 'image/png' } })
    expect(describeOutgoing({ document: { url: 'https://x/y.pdf' }, mimetype: 'application/pdf', fileName: 'y.pdf' })).toEqual({
      type: 'document',
      body: null,
      media: { url: 'https://x/y.pdf', mime: 'application/pdf', file_name: 'y.pdf' },
    })
    expect(describeOutgoing({ audio: { url: 'blob:s' }, ptt: true })).toMatchObject({ type: 'audio', media: { key: 's', ptt: true } })
    expect(describeOutgoing({ contact: { displayName: 'Bia', vcard: 'BEGIN:VCARD' } })).toMatchObject({ type: 'contact', body: 'Bia' })
    expect(describeOutgoing({ location: { latitude: 1, longitude: 2, name: 'Loja' } })).toMatchObject({ type: 'location', body: 'Loja' })
  })
})
