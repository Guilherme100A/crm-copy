import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chats, companyMembers, connections, contacts, createDb, departments, messages, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const gateway = new FakeWaGateway()
const published: { companyId: string; type: string; data: any; scope?: Record<string, unknown> }[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
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
  const email = `c-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.48.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: `U ${rnd()}`, email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id, userId: user.id, headers: {} }
}

/** Outro usuário entra na empresa de `owner` como member com as permissões dadas. */
async function joinAs(owner: Session, permissionKeys: string[]): Promise<Session & { memberId: string }> {
  const s = await signUp()
  const [m] = await db.insert(companyMembers).values({ companyId: owner.companyId, userId: s.userId, role: 'member', permissionKeys }).returning({ id: companyMembers.id })
  await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, s.userId))
  return { ...s, companyId: owner.companyId, headers: { 'x-company-id': owner.companyId }, memberId: m!.id }
}

const call = (s: Session, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...H, ...s.headers, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json

async function seedChat(companyId: string, opts: { name?: string; phone?: string; status?: 'waiting' | 'attending' | 'resolved'; departmentId?: string | null; last?: 'inbound' | 'outbound'; unread?: number; createdAt?: Date } = {}) {
  const [contact] = await db
    .insert(contacts)
    .values({ companyId, name: opts.name ?? `Cliente ${rnd()}`, phoneE164: opts.phone ?? `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}` })
    .returning({ id: contacts.id })
  const [chat] = await db
    .insert(chats)
    .values({
      companyId,
      connectionId: CONN,
      contactId: contact!.id,
      status: opts.status ?? 'waiting',
      departmentId: opts.departmentId ?? null,
      unreadCount: opts.unread ?? 0,
      lastMessageAt: new Date(),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: chats.id })
  if (opts.last) {
    const t = Date.now()
    await db.insert(messages).values([
      { companyId, chatId: chat!.id, direction: opts.last === 'inbound' ? 'outbound' : 'inbound', senderType: 'contact', type: 'text', body: 'a', status: 'sent', createdAt: new Date(t - 1000) },
      { companyId, chatId: chat!.id, direction: opts.last, senderType: opts.last === 'inbound' ? 'contact' : 'user', type: 'text', body: 'b', status: 'sent', createdAt: new Date(t) },
    ])
  }
  return chat!.id
}

async function allPages(s: Session, qs: string): Promise<Json[]> {
  const items: Json[] = []
  let cursor: string | null = null
  do {
    const page: Json = await json(await call(s, 'GET', `/api/chats?${qs}${cursor ? `&cursor=${cursor}` : ''}`))
    items.push(...page.items)
    cursor = page.next_cursor
  } while (cursor)
  return items
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    waGateway: gateway,
    logger: createLogger({ level: 'silent' }),
    chatPublisher: { publish: async (companyId, type, data, opts) => void published.push({ companyId, type, data, scope: opts?.scope }) },
  })
  // T40: chats.connection_id referencia crm.connections.
  const holder = await signUp()
  await db.insert(connections).values({ id: CONN, companyId: holder.companyId, sessionId: `s-${rnd()}`, name: 'Conexão' })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('AC-T48-01 escopo', () => {
  it('membro do depto X não vê chats de Y (lista, contadores, detalhe); owner vê todos', async () => {
    const owner = await signUp()
    const [x] = await db.insert(departments).values({ companyId: owner.companyId, name: 'X' }).returning({ id: departments.id })
    const [y] = await db.insert(departments).values({ companyId: owner.companyId, name: 'Y' }).returning({ id: departments.id })
    const cx = await seedChat(owner.companyId, { departmentId: x!.id })
    const cy = await seedChat(owner.companyId, { departmentId: y!.id })
    const cn = await seedChat(owner.companyId, { departmentId: null })
    const member = await joinAs(owner, ['chat.view'])
    expect((await call(owner, 'PUT', `/api/departments/members/${member.memberId}/scope`, { department_ids: [x!.id] })).status).toBe(200)

    const list = await json(await call(member, 'GET', '/api/chats'))
    expect(list.items.map((i: Json) => i.id).sort()).toEqual([cx, cn].sort())
    expect(list.counts).toEqual({ waiting: 2, attending: 0, resolved: 0 })
    expect((await call(member, 'GET', `/api/chats/${cy}`)).status).toBe(404)
    expect((await call(member, 'POST', `/api/chats/${cy}/resolve`)).status).toBe(404)
    expect((await call(member, 'GET', `/api/chats/${cx}`)).status).toBe(200)
    const all = await json(await call(owner, 'GET', '/api/chats'))
    expect(all.counts.waiting).toBe(3)

    // outra empresa nunca vê
    const stranger = await signUp()
    expect((await call(stranger, 'GET', `/api/chats/${cx}`)).status).toBe(404)
  })
})

describe('AC-T48-02 filtros', () => {
  it('não respondidas, período obrigatório nos dois lados e busca por nome/telefone', async () => {
    const s = await signUp()
    const unanswered = await seedChat(s.companyId, { name: 'José Antônio', phone: '+5511999887766', last: 'inbound' })
    const answered = await seedChat(s.companyId, { name: 'Maria', last: 'outbound' })
    const silent = await seedChat(s.companyId, { name: 'Sem mensagens' })

    const un = await json(await call(s, 'GET', '/api/chats?response_status=unanswered'))
    expect(un.items.map((i: Json) => i.id)).toEqual([unanswered])
    const ans = await json(await call(s, 'GET', '/api/chats?response_status=answered'))
    expect(ans.items.map((i: Json) => i.id).sort()).toEqual([answered, silent].sort())

    const onlyFrom = await call(s, 'GET', '/api/chats?created_from=2026-01-01T00:00:00Z')
    expect(onlyFrom.status).toBe(422)
    expect((await json(onlyFrom)).error.details.fields[0].path).toBe('created_to')
    expect((await json(await call(s, 'GET', '/api/chats?created_to=2026-01-01T00:00:00Z'))).error.details.fields[0].path).toBe('created_from')
    const range = await json(await call(s, 'GET', `/api/chats?created_from=2020-01-01T00:00:00Z&created_to=2099-01-01T00:00:00Z`))
    expect(range.items).toHaveLength(3)
    expect((await json(await call(s, 'GET', `/api/chats?created_from=2020-01-01T00:00:00Z&created_to=2020-01-02T00:00:00Z`))).items).toHaveLength(0)

    for (const term of ['jose', 'ANTONIO', '99988', '(11) 99988']) {
      const r = await json(await call(s, 'GET', `/api/chats?search=${encodeURIComponent(term)}`))
      expect(r.items.map((i: Json) => i.id), term).toEqual([unanswered])
    }
  })

  it('não lidas, atendente, etiquetas e listas em csv/repetidas', async () => {
    const s = await signUp()
    const unread = await seedChat(s.companyId, { unread: 3 })
    await seedChat(s.companyId)
    expect((await json(await call(s, 'GET', '/api/chats?read_status=unread'))).items.map((i: Json) => i.id)).toEqual([unread])
    await call(s, 'PATCH', `/api/chats/${unread}/assign`, {})
    expect((await json(await call(s, 'GET', '/api/chats?assigned_to=me'))).items.map((i: Json) => i.id)).toEqual([unread])
    expect((await json(await call(s, 'GET', '/api/chats?assigned_to=none'))).items).toHaveLength(1)
    const label = await json(await call(s, 'POST', '/api/labels', { name: 'VIP', color: '#3B82F6' }))
    await call(s, 'POST', `/api/chats/${unread}/labels`, { label_id: label.label.id })
    expect((await json(await call(s, 'GET', `/api/chats?label_ids=${label.label.id}`))).items.map((i: Json) => i.id)).toEqual([unread])
    expect((await json(await call(s, 'GET', `/api/chats?connection_ids=${CONN},${CONN}`))).items).toHaveLength(2)
    expect((await call(s, 'GET', '/api/chats?label_ids=xyz')).status).toBe(422)
    expect((await json(await call(s, 'POST', '/api/chats/mark-all-read'))).updated).toBe(1)
  })
})

describe('AC-T48-03 ciclo de vida', () => {
  it('assumir de outro exige chat.assign_others; resolve/reopen; transições inválidas → 409', async () => {
    const owner = await signUp()
    const plain = await joinAs(owner, ['chat.view'])
    const lead = await joinAs(owner, ['chat.view', 'chat.assign_others'])
    const chat = await seedChat(owner.companyId)

    const mine = await json(await call(plain, 'PATCH', `/api/chats/${chat}/assign`, {}))
    expect(mine.chat).toMatchObject({ status: 'attending', assigned_user_id: plain.userId })
    const steal = await call(owner, 'PATCH', `/api/chats/${chat}/assign`, {})
    expect(steal.status).toBe(200) // owner tem tudo
    const back = await call(plain, 'PATCH', `/api/chats/${chat}/assign`, {})
    expect(back.status).toBe(403)
    expect((await call(plain, 'PATCH', `/api/chats/${chat}/assign`, { user_id: lead.userId })).status).toBe(403)
    expect((await call(lead, 'PATCH', `/api/chats/${chat}/assign`, { user_id: plain.userId })).status).toBe(200)
    expect((await call(lead, 'PATCH', `/api/chats/${chat}/assign`, { user_id: '00000000-0000-4000-8000-000000000999' })).status).toBe(422)

    const resolved = await json(await call(plain, 'POST', `/api/chats/${chat}/resolve`))
    expect(resolved.chat.status).toBe('resolved')
    expect(resolved.chat.resolved_at).not.toBeNull()
    const again = await call(plain, 'POST', `/api/chats/${chat}/resolve`)
    expect(again.status).toBe(409)
    expect((await json(again)).error.code).toBe('INVALID_TRANSITION')
    expect((await call(plain, 'PATCH', `/api/chats/${chat}/assign`, {})).status).toBe(409)
    const reopened = await json(await call(plain, 'POST', `/api/chats/${chat}/reopen`))
    expect(reopened.chat).toMatchObject({ status: 'waiting', resolved_at: null, assigned_user_id: null })
    expect((await call(plain, 'POST', `/api/chats/${chat}/reopen`)).status).toBe(409)
    expect((await call(plain, 'POST', `/api/chats/${chat}/unassign`)).status).toBe(409)

    expect((await call(plain, 'POST', `/api/chats/${chat}/block`)).status).toBe(403)
    expect((await call(owner, 'POST', `/api/chats/${chat}/block`)).status).toBe(200)
    expect((await call(owner, 'POST', `/api/chats/${chat}/block`)).status).toBe(409)
    expect((await call(plain, 'DELETE', `/api/chats/${chat}`)).status).toBe(403)
    expect((await call(owner, 'DELETE', `/api/chats/${chat}`)).status).toBe(200)
    expect(published.some((p) => p.type === 'chat.deleted' && p.data.chat_id === chat)).toBe(true)
  })

  it('abrir chat com contato e conexão (idempotente)', async () => {
    const s = await signUp()
    const [contact] = await db.insert(contacts).values({ companyId: s.companyId, name: 'Novo' }).returning({ id: contacts.id })
    const a = await call(s, 'POST', '/api/chats', { contact_id: contact!.id, connection_id: CONN })
    expect(a.status).toBe(201)
    const b = await call(s, 'POST', '/api/chats', { contact_id: contact!.id, connection_id: CONN })
    expect(b.status).toBe(200)
    expect((await json(b)).chat.id).toBe((await json(a)).chat.id)
  })
})

describe('AC-T48-04 transferência', () => {
  it('publica chat.updated com o escopo novo e o chat some da lista de quem perde o escopo', async () => {
    const owner = await signUp()
    const [x] = await db.insert(departments).values({ companyId: owner.companyId, name: 'X' }).returning({ id: departments.id })
    const [y] = await db.insert(departments).values({ companyId: owner.companyId, name: 'Y' }).returning({ id: departments.id })
    const chat = await seedChat(owner.companyId, { departmentId: x!.id })
    const member = await joinAs(owner, ['chat.view'])
    await call(owner, 'PUT', `/api/departments/members/${member.memberId}/scope`, { department_ids: [x!.id] })
    expect((await json(await call(member, 'GET', '/api/chats'))).items.map((i: Json) => i.id)).toContain(chat)

    published.length = 0
    const res = await call(member, 'PATCH', `/api/chats/${chat}`, { department_id: y!.id })
    expect(res.status).toBe(200)
    const ev = published.find((p) => p.type === 'chat.updated' && p.data.chat_id === chat)
    expect(ev?.scope).toEqual({ department_id: y!.id, connection_id: CONN })
    expect((await json(await call(member, 'GET', '/api/chats'))).items.map((i: Json) => i.id)).not.toContain(chat)
    expect((await call(member, 'GET', `/api/chats/${chat}`)).status).toBe(404)
    const events = await json(await call(owner, 'GET', `/api/chats/${chat}/events`))
    expect(events.items[0]).toMatchObject({ type: 'transferred', detail: { from: x!.id, to: y!.id }, actor: { id: member.userId } })
    expect((await call(owner, 'PATCH', `/api/chats/${chat}`, { department_id: '00000000-0000-4000-8000-000000000999' })).status).toBe(422)
  })
})

describe('AC-T48-05 notas internas', () => {
  it('não chamam o gateway e aparecem no histórico com autor', async () => {
    const s = await signUp()
    const chat = await seedChat(s.companyId)
    const sentBefore = gateway.sent.length
    const res = await call(s, 'POST', `/api/chats/${chat}/notes`, { body: 'cliente pediu desconto' })
    expect(res.status).toBe(201)
    const { note } = await json(res)
    expect(note).toMatchObject({ body: 'cliente pediu desconto', author: { id: s.userId } })
    expect(gateway.sent.length).toBe(sentBefore)
    expect((await json(await call(s, 'GET', `/api/chats/${chat}/notes`))).items).toEqual([note])
    const events = await json(await call(s, 'GET', `/api/chats/${chat}/events`))
    expect(events.items[0]).toMatchObject({ type: 'note_added', actor: { id: s.userId }, detail: { note_id: note.id } })
    expect((await call(s, 'POST', `/api/chats/${chat}/notes`, { body: '  ' })).status).toBe(422)
  })
})

describe('AC-T48-06 contadores', () => {
  it('batem com a lista paginada sob os mesmos filtros', async () => {
    const s = await signUp()
    for (let i = 0; i < 17; i++) await seedChat(s.companyId, { status: 'waiting', last: i % 2 ? 'inbound' : 'outbound' })
    for (let i = 0; i < 4; i++) await seedChat(s.companyId, { status: 'attending', last: 'inbound' })
    for (let i = 0; i < 2; i++) await seedChat(s.companyId, { status: 'resolved' })
    for (const filters of ['', 'response_status=unanswered']) {
      const { counts } = await json(await call(s, 'GET', `/api/chats/counts?${filters}`))
      for (const status of ['waiting', 'attending', 'resolved']) {
        const items = await allPages(s, `status=${status}&${filters}`)
        expect(items.length, `${status} ${filters}`).toBe(counts[status])
        expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
      }
    }
    const first = await json(await call(s, 'GET', '/api/chats?status=waiting'))
    expect(first.items).toHaveLength(15)
    expect(first.next_cursor).not.toBeNull()
    expect(first.counts).toEqual({ waiting: 17, attending: 4, resolved: 2 })
  })
})
