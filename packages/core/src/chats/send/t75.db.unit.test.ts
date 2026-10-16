// T75 (aditivo à T49): reações no histórico, reenvio de mensagem com falha e mídia da mensagem (saída/entrada).
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chats, companies, connections, contacts, createDb, messageReactions, messages, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MediaService } from '../../media/service'
import { mediaDownloadName, MessageMediaService } from './message-media'
import { ChatSendService } from './service'

let temp: TempDatabase
let db: Database
let dir: string

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  dir = await mkdtemp(join(tmpdir(), 't75-send-'))
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
  const [connection] = await db.insert(connections).values({ companyId: company!.id, sessionId: `sess-${slug}`, name: 'Conexão teste' }).returning({ id: connections.id })
  const [chat] = await db.insert(chats).values({ companyId: company!.id, connectionId: connection!.id, contactId: contact!.id }).returning()
  const gw = new FakeWaGateway({ sessions: [{ id: 'sess-1', state: 'STABLE' }] })
  const published: Array<{ type: string; data: Record<string, unknown> }> = []
  const blobs = new FsBlobStore(dir)
  const svc = new ChatSendService({
    db,
    waGateway: gw,
    resolveSession: async () => 'sess-1',
    media: new MediaService({ blobStore: blobs, signingKey: Buffer.alloc(32, 1) }),
    pttConverter: async (data, mime) => ({ audio: data, mime, seconds: 1 }),
    publisher: { publish: async (_c, type, data) => void published.push({ type, data: data as Record<string, unknown> }) },
  })
  const mediaSvc = new MessageMediaService({ db, blobs, downloadMedia: (s, ref) => gw.downloadMedia(s, ref) })
  const companyId = company!.id
  const insert = async (values: Partial<typeof messages.$inferInsert>) =>
    (await db.insert(messages).values({ companyId, chatId: chat!.id, direction: 'outbound', senderType: 'user', type: 'text', status: 'failed', ...values }).returning())[0]!
  return { companyId, chatId: chat!.id, userId: user!.id, sender: { userId: user!.id, name: 'Bia' }, gw, svc, mediaSvc, blobs, published, insert }
}

describe('reações no histórico', () => {
  it('cada item traz reactions [{ emoji, actor_type, user_id }]', async () => {
    const s = await setup()
    const a = await s.insert({ direction: 'inbound', senderType: 'contact', status: 'received', body: 'oi', waMessageId: 'wa-a' })
    const b = await s.insert({ direction: 'inbound', senderType: 'contact', status: 'received', body: 'tudo bem?', waMessageId: 'wa-b' })
    await db.insert(messageReactions).values([
      { companyId: s.companyId, messageId: a.id, actorType: 'user', actorUserId: s.userId, emoji: '👍' },
      { companyId: s.companyId, messageId: a.id, actorType: 'contact', emoji: '❤️' },
    ])
    const { items } = await s.svc.list(s.companyId, s.chatId)
    const byId = Object.fromEntries(items.map((m) => [m.id, m.reactions]))
    expect(byId[a.id]).toEqual([
      { emoji: '👍', actor_type: 'user', user_id: s.userId },
      { emoji: '❤️', actor_type: 'contact', user_id: null },
    ])
    expect(byId[b.id]).toEqual([])
  })
})

describe('retry (AC-T75-03)', () => {
  it('texto com falha volta a ser enviado pelo gateway com o mesmo conteúdo', async () => {
    const s = await setup()
    const m = await s.insert({ body: 'Olá de novo', error: 'boom' })
    const out = await s.svc.retry(s.companyId, s.chatId, m.id, s.sender)
    expect(s.gw.sent).toHaveLength(1)
    expect(s.gw.sent[0]).toMatchObject({ phone: '+5511999990001', content: { text: 'Olá de novo' }, actor: `crm:${s.userId}` })
    expect(out).toMatchObject({ id: m.id, error: null, pipeline_message_id: expect.any(String) })
    expect(out.status).not.toBe('failed')
    expect(s.published.filter((p) => p.type === 'message.status').map((p) => p.data.status)).toEqual(['queued', out.status])
  })

  it('mídia reenviada pelo blob original; localização reconstruída', async () => {
    const s = await setup()
    const blob = await s.blobs.put(new Uint8Array([1, 2, 3]), 'image/png')
    const img = await s.insert({ type: 'image', body: 'foto', media: { key: blob.key, mime: 'image/png' } })
    await s.svc.retry(s.companyId, s.chatId, img.id, s.sender)
    expect(s.gw.sent[0]!.content).toEqual({ image: { url: `blob:${blob.key}` }, mimetype: 'image/png', caption: 'foto' })
    const loc = await s.insert({ type: 'location', body: 'Loja', media: { location: { latitude: -23.5, longitude: -46.6, name: 'Loja' } } })
    await s.svc.retry(s.companyId, s.chatId, loc.id, s.sender)
    expect(s.gw.sent[1]!.content).toEqual({ location: { latitude: -23.5, longitude: -46.6, name: 'Loja' } })
  })

  it('só failed e de saída; falha de novo volta a failed e o erro sobe', async () => {
    const s = await setup()
    const sent = await s.insert({ body: 'ok', status: 'sent' })
    await expect(s.svc.retry(s.companyId, s.chatId, sent.id, s.sender)).rejects.toMatchObject({ code: 'conflict' })
    const inbound = await s.insert({ direction: 'inbound', senderType: 'contact', status: 'failed', body: 'x' })
    await expect(s.svc.retry(s.companyId, s.chatId, inbound.id, s.sender)).rejects.toMatchObject({ code: 'conflict' })
    const m = await s.insert({ body: 'vai falhar' })
    await s.gw.optOut({ phone: '+5511999990001' })
    await expect(s.svc.retry(s.companyId, s.chatId, m.id, s.sender)).rejects.toMatchObject({ name: 'SendRejectedError' })
    const [row] = await db.select().from(messages).where(eq(messages.id, m.id))
    expect(row).toMatchObject({ status: 'failed', error: expect.stringContaining('opted_out') })
  })
})

describe('mídia da mensagem', () => {
  it('saída: bytes do blob pelo sha256', async () => {
    const s = await setup()
    const blob = await s.blobs.put(new Uint8Array([7, 7, 7]), 'application/pdf')
    const doc = await s.insert({ type: 'document', status: 'sent', media: { key: blob.key, mime: 'application/pdf', file_name: 'proposta.pdf' } })
    const got = await s.mediaSvc.get(s.companyId, s.chatId, doc.id)
    expect([...got.data]).toEqual([7, 7, 7])
    expect(got).toMatchObject({ mime: 'application/pdf', fileName: 'proposta.pdf', type: 'document' })
  })

  it('entrada: baixa pelo gateway na 1ª vez e reaproveita o blob depois', async () => {
    const s = await setup()
    s.gw.setMedia('wa-img', new Uint8Array([5, 4, 3]))
    const handle = { session_id: 'sess-1', message_id: 'wa-img', mime: 'image/jpeg', size: null, sha256: null, key: null, status: 'pending' }
    const m = await s.insert({ direction: 'inbound', senderType: 'contact', status: 'received', type: 'image', media: handle, waMessageId: 'wa-img' })
    expect([...(await s.mediaSvc.get(s.companyId, s.chatId, m.id)).data]).toEqual([5, 4, 3])
    const [row] = await db.select().from(messages).where(eq(messages.id, m.id))
    expect(row!.media).toMatchObject({ key: expect.stringMatching(/^[0-9a-f]{64}$/), status: 'ready', size: 3 })
    s.gw.setMedia('wa-img', new Uint8Array([9]))
    expect([...(await s.mediaSvc.get(s.companyId, s.chatId, m.id)).data]).toEqual([5, 4, 3])
  })

  it('sem mídia, apagada ou de outro chat → not_found', async () => {
    const s = await setup()
    const text = await s.insert({ status: 'sent', body: 'oi' })
    await expect(s.mediaSvc.get(s.companyId, s.chatId, text.id)).rejects.toMatchObject({ code: 'not_found' })
    const blob = await s.blobs.put(new Uint8Array([1]), 'image/png')
    const gone = await s.insert({ type: 'image', status: 'sent', media: { key: blob.key, mime: 'image/png' }, deletedAt: new Date() })
    await expect(s.mediaSvc.get(s.companyId, s.chatId, gone.id)).rejects.toMatchObject({ code: 'not_found' })
    const other = await setup()
    await expect(other.mediaSvc.get(other.companyId, other.chatId, gone.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('nome do download', () => {
    expect(mediaDownloadName('image', 'abcdef1234', 'image/jpeg', null)).toBe('image-abcdef12.jpg')
    expect(mediaDownloadName('document', 'x', 'application/pdf', 'contrato.pdf')).toBe('contrato.pdf')
  })
})
