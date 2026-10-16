// T119: rotas de mensagens respeitam o escopo de chat (T31/T48): fora do escopo → 404 sem efeito colateral.
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { count, eq, isNotNull } from 'drizzle-orm'
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
let app: ReturnType<typeof createApp>
const gateway = new FakeWaGateway({ sessions: [{ id: 'sess-1', state: 'STABLE' }] })
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const CONN = '00000000-0000-4000-8000-0000000000c1'

interface Session {
  cookie: string
  companyId: string
  userId: string
  headers: Record<string, string>
}

async function signUp(): Promise<Session> {
  const email = `s-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.119.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'S', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id, headers: {} }
}

const call = (s: Session, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...H, ...s.headers, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json

async function seedChat(companyId: string, departmentId: string | null) {
  const [contact] = await db
    .insert(contacts)
    .values({ companyId, name: 'Cli', phoneE164: `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}` })
    .returning({ id: contacts.id })
  const [chat] = await db.insert(chats).values({ companyId, connectionId: CONN, contactId: contact!.id, departmentId, unreadCount: 2 }).returning({ id: chats.id })
  const [msg] = await db
    .insert(messages)
    .values({ companyId, chatId: chat!.id, direction: 'inbound', senderType: 'contact', type: 'text', body: 'oi', status: 'received', waMessageId: `w-${rnd()}`, waKey: { remoteJid: 'x@s.whatsapp.net', fromMe: false, id: rnd() } })
    .returning({ id: messages.id })
  // Enviada pela conta e já com id do WhatsApp: pode ser apagada para todos (regra da T49).
  const [out] = await db
    .insert(messages)
    .values({ companyId, chatId: chat!.id, direction: 'outbound', senderType: 'user', type: 'text', body: 'r', status: 'sent', waMessageId: `w-${rnd()}`, waKey: { remoteJid: 'x@s.whatsapp.net', fromMe: true, id: rnd() } })
    .returning({ id: messages.id })
  return { chatId: chat!.id, messageId: msg!.id, outboundId: out!.id }
}

const counts = async () => {
  const [m] = await db.select({ n: count() }).from(messages)
  const [r] = await db.select({ n: count() }).from(messageReactions)
  const [d] = await db.select({ n: count() }).from(messages).where(isNotNull(messages.deletedAt))
  return { messages: m!.n, reactions: r!.n, deleted: d!.n, sent: gateway.sent.length, reads: gateway.reads.length, presences: gateway.presences.length }
}

let owner: Session
let member: Session & { memberId: string }
let deptX: string
let deptY: string

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  storage = await mkdtemp(join(tmpdir(), 't119-'))
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    waGateway: gateway,
    resolveSession: async () => 'sess-1',
    blobStore: new FsBlobStore(storage),
    mediaSigningKey: Buffer.alloc(32, 7),
    chatPublisher: { publish: async () => undefined },
    logger: createLogger({ level: 'silent' }),
  })
  owner = await signUp()
  // T40: chats.connection_id referencia crm.connections.
  await db.insert(connections).values({ id: CONN, companyId: owner.companyId, sessionId: `s-${rnd()}`, name: 'Conexão' })
  const [x] = await db.insert(departments).values({ companyId: owner.companyId, name: 'X' }).returning({ id: departments.id })
  const [y] = await db.insert(departments).values({ companyId: owner.companyId, name: 'Y' }).returning({ id: departments.id })
  deptX = x!.id
  deptY = y!.id
  const m = await signUp()
  const [row] = await db.insert(companyMembers).values({ companyId: owner.companyId, userId: m.userId, role: 'member', permissionKeys: ['chat.view'] }).returning({ id: companyMembers.id })
  await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, m.userId))
  member = { ...m, companyId: owner.companyId, headers: { 'x-company-id': owner.companyId }, memberId: row!.id }
  expect((await call(owner, 'PUT', `/api/departments/members/${member.memberId}/scope`, { department_ids: [deptX] })).status).toBe(200)
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
  await rm(storage, { recursive: true, force: true })
})

async function upload(s: Session): Promise<string> {
  const form = new FormData()
  const png = new Uint8Array(64)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  form.append('file', new File([png], 'a.png', { type: 'image/png' }))
  const res = await app.request('/api/media', { method: 'POST', headers: { cookie: s.cookie, 'x-requested-with': 'crm', ...s.headers }, body: form })
  expect(res.status).toBe(201)
  return (await json(res)).media.id
}

describe('AC-T119-01 fora do escopo → 404 sem efeito', () => {
  it('listar, enviar texto, enviar mídia, ler, reagir e apagar', async () => {
    const y = await seedChat(owner.companyId, deptY)
    const mediaId = await upload(member)
    const before = await counts()
    const attempts: [string, string, unknown?][] = [
      ['GET', `/api/chats/${y.chatId}/messages`],
      ['POST', `/api/chats/${y.chatId}/messages`, { type: 'text', text: 'vazou?' }],
      ['POST', `/api/chats/${y.chatId}/messages`, { type: 'image', media_id: mediaId }],
      ['POST', `/api/chats/${y.chatId}/read`],
      ['POST', `/api/chats/${y.chatId}/messages/${y.messageId}/react`, { emoji: '👍' }],
      ['POST', `/api/chats/${y.chatId}/messages/${y.outboundId}/delete`],
      // corpo inválido: 404 vem antes da validação (não revela nada do chat)
      ['POST', `/api/chats/${y.chatId}/messages`, { type: 'nope' }],
    ]
    for (const [method, path, body] of attempts) {
      const res = await call(member, method, path, body)
      expect(res.status, `${method} ${path}`).toBe(404)
      expect((await json(res)).error.code).toBe('NOT_FOUND')
    }
    expect(await counts()).toEqual(before)
    const [chat] = await db.select({ unread: chats.unreadCount }).from(chats).where(eq(chats.id, y.chatId))
    expect(chat!.unread).toBe(2)
  })
})

describe('AC-T119-02 dentro do escopo continua funcionando', () => {
  it('owner, membro do depto e membro sem restrição fazem tudo; ganhar o escopo libera o chat', async () => {
    const x = await seedChat(owner.companyId, deptX)
    const y = await seedChat(owner.companyId, deptY)
    for (const [who, chat] of [
      [member, x],
      [owner, y],
    ] as const) {
      expect((await call(who, 'GET', `/api/chats/${chat.chatId}/messages`)).status).toBe(200)
      const sent = await call(who, 'POST', `/api/chats/${chat.chatId}/messages`, { type: 'text', text: 'olá' })
      expect(sent.status).toBe(201)
      expect((await call(who, 'POST', `/api/chats/${chat.chatId}/read`)).status).toBe(200)
      expect((await call(who, 'POST', `/api/chats/${chat.chatId}/messages/${chat.messageId}/react`, { emoji: '👍' })).status).toBe(200)
      expect((await call(who, 'POST', `/api/chats/${chat.chatId}/messages/${chat.outboundId}/delete`)).status).toBe(200)
    }
    expect((await call(member, 'GET', `/api/chats/${y.chatId}/messages`)).status).toBe(404)
    await call(owner, 'PUT', `/api/departments/members/${member.memberId}/scope`, { department_ids: [deptX, deptY] })
    expect((await call(member, 'GET', `/api/chats/${y.chatId}/messages`)).status).toBe(200)
    // sem restrição nenhuma também vê
    await call(owner, 'PUT', `/api/departments/members/${member.memberId}/scope`, { department_ids: [] })
    expect((await call(member, 'GET', `/api/chats/${y.chatId}/messages`)).status).toBe(200)
    await call(owner, 'PUT', `/api/departments/members/${member.memberId}/scope`, { department_ids: [deptX] })
  })
})

describe('AC-T119-03 encaminhar', () => {
  it('origem ou destino fora do escopo → 404; dentro → 201', async () => {
    const x1 = await seedChat(owner.companyId, deptX)
    const x2 = await seedChat(owner.companyId, deptX)
    const y = await seedChat(owner.companyId, deptY)
    const before = await counts()
    const fromY = await call(member, 'POST', `/api/chats/${y.chatId}/messages/${y.messageId}/forward`, { chat_id: x1.chatId })
    expect(fromY.status).toBe(404)
    const toY = await call(member, 'POST', `/api/chats/${x1.chatId}/messages/${x1.messageId}/forward`, { chat_id: y.chatId })
    expect(toY.status).toBe(404)
    expect(await counts()).toEqual(before)
    expect((await call(member, 'POST', `/api/chats/${x1.chatId}/messages/${x1.messageId}/forward`, { chat_id: x2.chatId })).status).toBe(201)
  })
})
