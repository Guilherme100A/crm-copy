// Postgres real (SPEC 3.10): banco descartável; FakeWaGateway, BlobStore em disco temporário e publisher em memória.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chats, companies, connections, contacts, createDb, messages, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MediaService } from '../../media/service'
import { MemoryIdempotencyStore } from './idempotency'
import { ChatSendService } from './service'

let temp: TempDatabase
let db: Database
let dir: string

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  dir = await mkdtemp(join(tmpdir(), 't49-send-'))
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
  await rm(dir, { recursive: true, force: true })
})

async function setup() {
  const slug = `c-${randomBytes(4).toString('hex')}`
  const [company] = await db.insert(companies).values({ name: slug, slug }).returning({ id: companies.id })
  const [user] = await db.insert(users).values({ email: `${slug}@x.com`, passwordHash: 'x', name: 'Bia' }).returning({ id: users.id })
  const [contact] = await db.insert(contacts).values({ companyId: company!.id, name: 'Ana', phoneE164: '+5511999990001' }).returning({ id: contacts.id })
  // T40: chats.connection_id referencia crm.connections.
  const [connection] = await db.insert(connections).values({ companyId: company!.id, sessionId: `sess-${slug}`, name: 'Conexão teste' }).returning({ id: connections.id })
  const [chat] = await db.insert(chats).values({ companyId: company!.id, connectionId: connection!.id, contactId: contact!.id }).returning()
  const gw = new FakeWaGateway({ sessions: [{ id: 'sess-1', state: 'STABLE' }] })
  const published: Array<{ type: string; data: Record<string, unknown> }> = []
  const conversions: string[] = []
  const media = new MediaService({ blobStore: new FsBlobStore(dir), signingKey: Buffer.alloc(32, 1) })
  let session: string | null = 'sess-1'
  const svc = new ChatSendService({
    db,
    waGateway: gw,
    resolveSession: async () => session,
    media,
    pttConverter: async (_data, mime) => {
      conversions.push(mime)
      return { audio: new Uint8Array([79, 103, 103, 83]), mime: 'audio/ogg; codecs=opus', seconds: 3 }
    },
    idempotency: new MemoryIdempotencyStore(),
    publisher: { publish: async (_c, type, data) => void published.push({ type, data: data as Record<string, unknown> }) },
  })
  const companyId = company!.id
  const sender = { userId: user!.id, name: 'Bia' }
  return { companyId, chatId: chat!.id, sender, gw, svc, media, published, conversions, setSession: (s: string | null) => (session = s) }
}

describe('ChatSendService', () => {
  it('texto: 1 envio por Idempotency-Key; assinatura; auto-atribuição e first_human_reply', async () => {
    const s = await setup()
    const first = await s.svc.send(s.companyId, s.chatId, s.sender, { type: 'text', text: 'Olá', signature: true }, 'k1')
    const again = await s.svc.send(s.companyId, s.chatId, s.sender, { type: 'text', text: 'Olá', signature: true }, 'k1')
    expect(again).toMatchObject({ replay: true, message: { id: first.message.id } })
    expect(s.gw.sent).toHaveLength(1)
    expect(s.gw.sent[0]).toMatchObject({ phone: '+5511999990001', content: { text: '*Bia*:\nOlá' }, actor: `crm:${s.sender.userId}` })
    expect(first.message).toMatchObject({ status: 'queued', direction: 'outbound', sender_type: 'user' })
    const [chat] = await db.select().from(chats).where(eq(chats.id, s.chatId))
    expect(chat).toMatchObject({ status: 'attending', assignedUserId: s.sender.userId, firstHumanReplyBy: s.sender.userId })
    const firstAt = chat!.firstHumanReplyAt
    await s.svc.send(s.companyId, s.chatId, s.sender, { type: 'text', text: 'de novo' })
    const [after] = await db.select().from(chats).where(eq(chats.id, s.chatId))
    expect(after!.firstHumanReplyAt).toEqual(firstAt)
    expect(s.gw.presences.map((p) => p.kind)).toEqual(['composing', 'composing'])
    expect(s.published.map((p) => p.type)).toEqual(['message.created', 'chat.updated', 'message.created', 'chat.updated'])
  })

  it('PTT convertido antes do gateway; mídia com url blob: e mimetype', async () => {
    const s = await setup()
    const audio = await s.media.upload(s.companyId, new Uint8Array([1, 2, 3]), 'audio/mpeg')
    await s.svc.send(s.companyId, s.chatId, s.sender, { type: 'audio', mediaId: audio.id, ptt: true })
    expect(s.conversions).toEqual(['audio/mpeg'])
    expect(s.gw.sent[0]!.content).toMatchObject({ audio: { url: expect.stringMatching(/^blob:[a-f0-9]{64}$/) }, mimetype: 'audio/ogg; codecs=opus', ptt: true })
    const img = await s.media.upload(s.companyId, new Uint8Array([9]), 'image/png')
    await s.svc.send(s.companyId, s.chatId, s.sender, { type: 'image', mediaId: img.id, caption: 'foto' })
    expect(s.gw.sent[1]!.content).toEqual({ image: { url: `blob:${img.sha256}` }, mimetype: 'image/png', caption: 'foto' })
    await expect(s.svc.send(s.companyId, s.chatId, s.sender, { type: 'video', mediaId: img.id })).rejects.toMatchObject({ code: 'validation' })
  })

  it('falha do gateway → failed + message.status; sessão desconectada → 409 sem registro', async () => {
    const s = await setup()
    s.gw.failNext('RATE_LIMIT')
    await expect(s.svc.send(s.companyId, s.chatId, s.sender, { type: 'text', text: 'x' }, 'kf')).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    const rows = await db.select().from(messages).where(eq(messages.chatId, s.chatId))
    expect(rows.map((r) => r.status)).toEqual(['failed'])
    expect(s.published.find((p) => p.type === 'message.status')?.data).toMatchObject({ status: 'failed' })
    // A repetição da mesma chave devolve a mensagem que falhou, sem reenviar.
    expect(await s.svc.send(s.companyId, s.chatId, s.sender, { type: 'text', text: 'x' }, 'kf')).toMatchObject({ replay: true, message: { status: 'failed' } })

    s.setSession(null)
    await expect(s.svc.send(s.companyId, s.chatId, s.sender, { type: 'text', text: 'y' })).rejects.toMatchObject({ code: 'session_not_connected' })
    s.setSession('sess-1')
    s.gw.failNext('SESSION_NOT_CONNECTED')
    await expect(s.svc.send(s.companyId, s.chatId, s.sender, { type: 'text', text: 'z' })).rejects.toMatchObject({ code: 'SESSION_NOT_CONNECTED' })
    expect((await db.select().from(messages).where(eq(messages.chatId, s.chatId))).map((r) => r.status)).toEqual(['failed'])
  })

  it('reação usa o id do WhatsApp; apagar marca deleted_at; leitura zera não lidas; histórico paginado', async () => {
    const s = await setup()
    const [inbound] = await db
      .insert(messages)
      .values({ companyId: s.companyId, chatId: s.chatId, direction: 'inbound', senderType: 'contact', type: 'text', body: 'oi', status: 'received', waMessageId: 'WA-IN-1' })
      .returning()
    await s.svc.react(s.companyId, s.chatId, inbound!.id, '👍', s.sender)
    expect(s.gw.sent.at(-1)!.content).toEqual({ react: { messageId: 'WA-IN-1', emoji: '👍' } })
    const [out] = await db
      .insert(messages)
      .values({ companyId: s.companyId, chatId: s.chatId, direction: 'outbound', senderType: 'user', type: 'text', body: 'x', status: 'sent', waMessageId: 'WA-OUT-1' })
      .returning()
    const deleted = await s.svc.deleteForEveryone(s.companyId, s.chatId, out!.id, s.sender)
    expect(deleted.deleted_at).not.toBeNull()
    expect(s.gw.sent.at(-1)!.content).toEqual({ delete: { messageId: 'WA-OUT-1' } })
    await expect(s.svc.deleteForEveryone(s.companyId, s.chatId, inbound!.id, s.sender)).rejects.toMatchObject({ code: 'conflict' })

    await db.update(chats).set({ unreadCount: 3 }).where(eq(chats.id, s.chatId))
    expect((await s.svc.markRead(s.companyId, s.chatId)).unreadCount).toBe(0)

    const page = await s.svc.list(s.companyId, s.chatId, { limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.next_cursor).not.toBeNull()
    const older = await s.svc.list(s.companyId, s.chatId, { limit: 1, before: page.next_cursor! })
    expect(older.items[0]!.id).not.toBe(page.items[0]!.id)
    await expect(s.svc.list(randomUUID(), s.chatId)).rejects.toMatchObject({ code: 'not_found' })
  })
})
