// T75 (aditivo): GET /api/chats/:id/messages/:mid/media, reactions no histórico e POST .../retry, com escopo (T119).
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chats, companyMembers, connections, contacts, createDb, departments, messageReactions, messages, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let storage: string
let blobs: FsBlobStore
let app: ReturnType<typeof createApp>
const gateway = new FakeWaGateway({ sessions: [{ id: 'sess-1', state: 'STABLE' }] })
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const CONN = '00000000-0000-4000-8000-0000000000c7'

interface Session {
  cookie: string
  companyId: string
  userId: string
  headers: Record<string, string>
}

async function signUp(): Promise<Session> {
  const email = `t75-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.75.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'S', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id, headers: {} }
}

const call = (s: Session, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...H, ...s.headers, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

let owner: Session
let member: Session
let deptX: string
let deptY: string

async function seedChat(departmentId: string | null) {
  const [contact] = await db
    .insert(contacts)
    .values({ companyId: owner.companyId, name: 'Cli', phoneE164: `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}` })
    .returning({ id: contacts.id })
  const [chat] = await db.insert(chats).values({ companyId: owner.companyId, connectionId: CONN, contactId: contact!.id, departmentId }).returning({ id: chats.id })
  const insert = async (values: Partial<typeof messages.$inferInsert>) =>
    (await db.insert(messages).values({ companyId: owner.companyId, chatId: chat!.id, direction: 'outbound', senderType: 'user', type: 'text', status: 'sent', ...values }).returning())[0]!
  return { chatId: chat!.id, insert }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  storage = await mkdtemp(join(tmpdir(), 't75-api-'))
  blobs = new FsBlobStore(storage)
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    waGateway: gateway,
    resolveSession: async () => 'sess-1',
    blobStore: blobs,
    mediaSigningKey: Buffer.alloc(32, 7),
    chatPublisher: { publish: async () => undefined },
    logger: createLogger({ level: 'silent' }),
  })
  owner = await signUp()
  await db.insert(connections).values({ id: CONN, companyId: owner.companyId, sessionId: `s-${rnd()}`, name: 'Conexão' })
  const [x] = await db.insert(departments).values({ companyId: owner.companyId, name: 'X' }).returning({ id: departments.id })
  const [y] = await db.insert(departments).values({ companyId: owner.companyId, name: 'Y' }).returning({ id: departments.id })
  deptX = x!.id
  deptY = y!.id
  const m = await signUp()
  const [row] = await db.insert(companyMembers).values({ companyId: owner.companyId, userId: m.userId, role: 'member', permissionKeys: ['chat.view'] }).returning({ id: companyMembers.id })
  await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, m.userId))
  member = { ...m, companyId: owner.companyId, headers: { 'x-company-id': owner.companyId } }
  expect((await call(owner, 'PUT', `/api/departments/members/${row!.id}/scope`, { department_ids: [deptX] })).status).toBe(200)
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
  await rm(storage, { recursive: true, force: true })
})

describe('GET /api/chats/:id/messages/:mid/media', () => {
  it('saída: serve o blob com content-type, inline ou attachment e cache privado', async () => {
    const c = await seedChat(deptX)
    const blob = await blobs.put(new Uint8Array([1, 2, 3, 4]), 'application/pdf')
    const doc = await c.insert({ type: 'document', media: { key: blob.key, mime: 'application/pdf', file_name: 'proposta final.pdf' } })
    const res = await call(owner, 'GET', `/api/chats/${c.chatId}/messages/${doc.id}/media`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(res.headers.get('content-disposition')).toBe(`inline; filename*=UTF-8''proposta%20final.pdf`)
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4])
    const dl = await call(owner, 'GET', `/api/chats/${c.chatId}/messages/${doc.id}/media?download=1`)
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; /)
  })

  it('entrada: baixa pelo gateway; fora do escopo e sem mídia → 404', async () => {
    const c = await seedChat(deptX)
    gateway.setMedia('wa-in-1', new Uint8Array([9, 8]))
    const img = await c.insert({
      direction: 'inbound',
      senderType: 'contact',
      status: 'received',
      type: 'image',
      waMessageId: 'wa-in-1',
      media: { session_id: 'sess-1', message_id: 'wa-in-1', mime: 'image/jpeg', size: null, sha256: null, key: null, status: 'pending' },
    })
    const res = await call(member, 'GET', `/api/chats/${c.chatId}/messages/${img.id}/media`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([9, 8])

    const hidden = await seedChat(deptY)
    const blob = await blobs.put(new Uint8Array([1]), 'image/png')
    const out = await hidden.insert({ type: 'image', media: { key: blob.key, mime: 'image/png' } })
    expect((await call(member, 'GET', `/api/chats/${hidden.chatId}/messages/${out.id}/media`)).status).toBe(404)
    const text = await c.insert({ body: 'oi' })
    expect((await call(owner, 'GET', `/api/chats/${c.chatId}/messages/${text.id}/media`)).status).toBe(404)
  })
})

describe('reactions no histórico', () => {
  it('GET /messages devolve reactions por item', async () => {
    const c = await seedChat(deptX)
    const m = await c.insert({ direction: 'inbound', senderType: 'contact', status: 'received', body: 'oi', waMessageId: `w-${rnd()}` })
    await db.insert(messageReactions).values({ companyId: owner.companyId, messageId: m.id, actorType: 'user', actorUserId: owner.userId, emoji: '🔥' })
    const body = (await (await call(owner, 'GET', `/api/chats/${c.chatId}/messages`)).json()) as Json
    expect(body.items).toEqual([expect.objectContaining({ id: m.id, reactions: [{ emoji: '🔥', actor_type: 'user', user_id: owner.userId }] })])
  })
})

describe('POST /api/chats/:id/messages/:mid/retry', () => {
  it('reenvia a mensagem com falha; não-failed → 409; fora do escopo → 404 sem envio', async () => {
    const c = await seedChat(deptX)
    const failed = await c.insert({ body: 'tentar de novo', status: 'failed', error: 'x' })
    const before = gateway.sent.length
    const res = await call(owner, 'POST', `/api/chats/${c.chatId}/messages/${failed.id}/retry`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Json).message).toMatchObject({ id: failed.id, error: null })
    expect(gateway.sent.length).toBe(before + 1)
    expect((await call(owner, 'POST', `/api/chats/${c.chatId}/messages/${failed.id}/retry`)).status).toBe(409)

    const hidden = await seedChat(deptY)
    const hf = await hidden.insert({ body: 'escondida', status: 'failed' })
    expect((await call(member, 'POST', `/api/chats/${hidden.chatId}/messages/${hf.id}/retry`)).status).toBe(404)
    expect(gateway.sent.length).toBe(before + 1)
  })
})
