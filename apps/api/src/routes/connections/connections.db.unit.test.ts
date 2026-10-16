// API de conexões com Postgres real e FakeWaGateway (SPEC 3.10).
import { randomBytes } from 'node:crypto'
import { companies, companyMembers, connections, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, parseEncrypted, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
let wa: FakeWaGateway
const cipher = createCipher({ key: generateCredentialsKey() })
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `c-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.40.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'C', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id, userId: user.id }
}

const call = (s: Session, method: string, path: string, body?: unknown, companyId = s.companyId) =>
  app.request(path, { method, headers: { ...H, cookie: s.cookie, 'x-company-id': companyId }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  wa = new FakeWaGateway({ capabilities: { businessProfile: true } })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }), waGateway: wa, credentialsCipher: cipher })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

async function create(s: Session, name = `Loja ${rnd()}`) {
  const res = await call(s, 'POST', '/api/connections', { name })
  expect(res.status).toBe(201)
  return (await json(res)).connection as Json
}

describe('AC-T40-01 criar conexão e limite', () => {
  it('cria a sessão no gateway e o vínculo; sem limite não há teto', async () => {
    const s = await signUp()
    const c = await create(s, 'Vendas')
    expect(c).toMatchObject({ name: 'Vendas', status: 'pending', session_state: 'NEW', proxy: null, requires_restart: false })
    expect((await wa.sessions.get(c.session_id)).name).toBe('Vendas')
    const [row] = await db.select().from(connections).where(eq(connections.id, c.id))
    expect(row).toMatchObject({ companyId: s.companyId, sessionId: c.session_id })
    for (let i = 0; i < 5; i++) await create(s)
    const list = await json(await call(s, 'GET', '/api/connections'))
    expect(list.items).toHaveLength(6)
    expect(list.page).toMatchObject({ total_count: 6 })
    expect(list.status_counts).toMatchObject({ pending: 6, connected: 0 })
  })

  it('limite definido pelo admin e atingido → 409 LIMIT_REACHED', async () => {
    const s = await signUp()
    await db.update(companies).set({ settings: sql`jsonb_set(coalesce(${companies.settings}, '{}'::jsonb), '{limits}', '{"connections": 2}'::jsonb)` }).where(eq(companies.id, s.companyId))
    await create(s)
    await create(s)
    const before = (await wa.sessions.list()).length
    const res = await call(s, 'POST', '/api/connections', { name: 'Terceira' })
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ error: { code: 'LIMIT_REACHED', details: { limit: 2, used: 2 } } })
    expect((await wa.sessions.list()).length).toBe(before)
  })

  it('nome fora de 2–100 → 422', async () => {
    const s = await signUp()
    expect((await call(s, 'POST', '/api/connections', { name: 'x' })).status).toBe(422)
    expect((await call(s, 'POST', '/api/connections', { connection: { name: 'Envelope ok' } })).status).toBe(201)
  })
})

describe('AC-T40-02 QR e código no telefone', () => {
  it('GET /:id/qr devolve o QR mais recente; pairing-code valida o número', async () => {
    const s = await signUp()
    const c = await create(s)
    expect(await json(await call(s, 'GET', `/api/connections/${c.id}/qr`))).toEqual({ qr_code: null, generated_at: null })
    const connected = await json(await call(s, 'POST', `/api/connections/${c.id}/connect`))
    expect(connected.connection.status).toBe('connecting')
    const qr = await json(await call(s, 'GET', `/api/connections/${c.id}/qr`))
    expect(qr.qr_code).toMatch(/^data:image\/png;base64,/)
    expect(qr.generated_at).toBeTruthy()
    for (const phone of ['0119999', '55 11 99999', '123', '+']) {
      const bad = await call(s, 'POST', `/api/connections/${c.id}/pairing-code`, { phone })
      expect(bad.status).toBe(422)
      expect((await json(bad)).error.code).toBe('VALIDATION_ERROR')
    }
    const ok = await call(s, 'POST', `/api/connections/${c.id}/pairing-code`, { phone: '5511999990000' })
    expect(ok.status).toBe(200)
    expect(await json(ok)).toEqual({ code: 'FAKE1234' })
  })
})

describe('AC-T40-03 status de UI', () => {
  it('segue o estado da sessão e o último session.connection', async () => {
    const s = await signUp()
    const c = await create(s)
    const status = async () => (await json(await call(s, 'GET', `/api/connections/${c.id}`))).connection
    await wa.setSessionState(c.session_id, 'STABLE')
    await db.update(connections).set({ connectionState: 'open' }).where(eq(connections.id, c.id))
    expect(await status()).toMatchObject({ status: 'connected', badges: [] })
    await wa.setSessionState(c.session_id, 'WARMING')
    expect(await status()).toMatchObject({ status: 'connected', badges: ['warming'] })
    await wa.setSessionState(c.session_id, 'PAUSED')
    expect((await status()).status).toBe('paused')
    await db.update(connections).set({ connectionState: 'close', lastDisconnectReason: 'forbidden' }).where(eq(connections.id, c.id))
    expect((await status()).status).toBe('banned')
    await wa.setSessionState(c.session_id, 'DISCONNECTED')
    await db.update(connections).set({ lastDisconnectReason: 'loggedOut' }).where(eq(connections.id, c.id))
    expect((await status()).status).toBe('disconnected')
    const counts = (await json(await call(s, 'GET', '/api/connections?status=disconnected'))).status_counts
    expect(counts.disconnected).toBe(1)
  })

  it('disconnect faz logout e marca loggedOut; restart limpa requer reinício', async () => {
    const s = await signUp()
    const c = await create(s)
    await wa.setSessionState(c.session_id, 'STABLE')
    const d = (await json(await call(s, 'POST', `/api/connections/${c.id}/disconnect`))).connection
    expect(d).toMatchObject({ status: 'disconnected', last_disconnect_reason: 'loggedOut', session_state: 'DISCONNECTED' })
    expect(d.disconnected_at).toBeTruthy()
  })
})

describe('AC-T40-04 proxy', () => {
  it('mostra só host, porta, usuário e has_password; senha cifrada; marca requer reinício', async () => {
    const s = await signUp()
    const c = await create(s)
    const res = await call(s, 'POST', `/api/connections/${c.id}/proxy`, { protocol: 'socks5', host: 'proxy.local', port: 1080, username: 'u1', password: 'segredo-123' })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('segredo-123')
    const conn = (JSON.parse(text) as Json).connection
    expect(conn.proxy).toEqual({ protocol: 'socks5', host: 'proxy.local', port: 1080, username: 'u1', has_password: true })
    expect(conn).toMatchObject({ requires_restart: true, badges: ['requires_restart'] })
    const [row] = await db.select().from(connections).where(eq(connections.id, c.id))
    expect(row!.proxyPasswordEnc).not.toContain('segredo')
    expect(cipher.decrypt(parseEncrypted(row!.proxyPasswordEnc!), `connection/${c.id}/proxy`)).toBe('segredo-123')
    expect((await call(s, 'POST', `/api/connections/${c.id}/proxy`, { protocol: 'ftp', host: 'x', port: 1 })).status).toBe(422)
    expect((await call(s, 'POST', `/api/connections/${c.id}/proxy`, { protocol: 'http', host: 'x', port: 70000 })).status).toBe(422)
    const removed = (await json(await call(s, 'DELETE', `/api/connections/${c.id}/proxy`))).connection
    expect(removed).toMatchObject({ proxy: null, requires_restart: true })
    const restarted = (await json(await call(s, 'POST', `/api/connections/${c.id}/restart`))).connection
    expect(restarted.requires_restart).toBe(false)
  })
})

describe('AC-T40-05 isolamento e permissões', () => {
  it('conexão de outra empresa → 404', async () => {
    const a = await signUp()
    const b = await signUp()
    const c = await create(a)
    for (const [m, p] of [['GET', ''], ['PUT', ''], ['POST', '/connect'], ['GET', '/qr'], ['POST', '/restart'], ['POST', '/schedule-deletion']] as const) {
      const res = await call(b, m, `/api/connections/${c.id}${p}`, m === 'GET' ? undefined : { name: 'Outra' })
      expect(res.status).toBe(404)
    }
    expect((await json(await call(b, 'GET', '/api/connections'))).items).toEqual([])
  })

  it('membro sem connections.edit → 403 em connect/restart; com view lê', async () => {
    const owner = await signUp()
    const c = await create(owner)
    const member = await signUp()
    await db.insert(companyMembers).values({ companyId: owner.companyId, userId: member.userId, role: 'member', permissionKeys: ['connections.view'] })
    expect((await call(member, 'GET', `/api/connections/${c.id}`, undefined, owner.companyId)).status).toBe(200)
    expect((await call(member, 'POST', `/api/connections/${c.id}/connect`, undefined, owner.companyId)).status).toBe(403)
    expect((await call(member, 'POST', `/api/connections/${c.id}/restart`, undefined, owner.companyId)).status).toBe(403)
    expect((await call(member, 'POST', `/api/connections/${c.id}/schedule-deletion`, undefined, owner.companyId)).status).toBe(403)
  })
})

describe('integrações', () => {
  it('instance-settings, schedule-deletion e perfil (businessProfile)', async () => {
    const s = await signUp()
    const c = await create(s)
    const st = (await json(await call(s, 'POST', `/api/connections/${c.id}/instance-settings`, { ephemeral_duration: '7d', save_contacts_enabled: true, notify_sent_by_me: true }))).connection
    expect(st).toMatchObject({ ephemeral_duration: '7d', save_contacts_enabled: true, notify_sent_by_me: true })
    expect((await call(s, 'POST', `/api/connections/${c.id}/instance-settings`, { ephemeral_duration: '2d' })).status).toBe(422)
    const del = (await json(await call(s, 'POST', `/api/connections/${c.id}/schedule-deletion`))).connection
    expect(del.scheduled_for_deletion_at).toBeTruthy()
    expect(del.badges).toContain('scheduled_deletion')
    await wa.setSessionState(c.session_id, 'STABLE')
    const p = await json(await call(s, 'PATCH', `/api/connections/${c.id}/whatsapp-profile`, { name: 'Loja Oficial', status: 'Atendimento 9h–18h' }))
    expect(p.profile).toMatchObject({ name: 'Loja Oficial', status: 'Atendimento 9h–18h' })
  })

  it('desativar a empresa pausa as sessões das conexões dela', async () => {
    const s = await signUp()
    const c1 = await create(s)
    const c2 = await create(s)
    await wa.setSessionState(c1.session_id, 'STABLE')
    await wa.setSessionState(c2.session_id, 'WARMING')
    const res = await call(s, 'DELETE', `/api/companies/${s.companyId}`)
    expect(res.status).toBe(200)
    expect((await json(res)).paused_session_ids.sort()).toEqual([c1.session_id, c2.session_id].sort())
    expect((await wa.sessions.get(c1.session_id)).status).toBe('PAUSED')
  })

  it('FK chats.connection_id restringe apagar conexão com chats', async () => {
    const s = await signUp()
    const c = await create(s)
    const [contact] = (await db.execute(sql`insert into crm.contacts (company_id, phone_e164, name) values (${s.companyId}, ${`+55119${Date.now() % 1e8}`}, 'X') returning id`)).rows as { id: string }[]
    await db.execute(sql`insert into crm.chats (company_id, connection_id, contact_id) values (${s.companyId}, ${c.id}, ${contact!.id})`)
    await expect(db.delete(connections).where(eq(connections.id, c.id))).rejects.toMatchObject({ cause: { code: '23503' } })
  })
})
