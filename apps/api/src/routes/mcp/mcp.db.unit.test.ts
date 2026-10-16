/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Servidor MCP pela API (AC-T94-01..03): credencial mostra o token uma vez; 401 para token inválido/expirado/revogado;
// ferramentas só de leitura e isoladas pela empresa do token (JSON-RPC cru, como um cliente MCP).
import { randomBytes } from 'node:crypto'
import { chats, companyMembers, connections, contacts, createDb, mcpCredentials, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Session {
  cookie: string
  companyId: string
  userId: string
}
async function signUp(): Promise<Session> {
  const email = `m-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.94.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'M', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}
const call = async (s: Session, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}
let seq = 0
async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const res = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as any) : {} }
}
const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args })
  expect(r.status).toBe(200)
  return { isError: r.body.result.isError === true, data: JSON.parse(r.body.result.content[0].text) }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }), mcpEnv: { API_PUBLIC_URL: 'https://api.crm.test' } })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('/api/mcp_credentials', () => {
  it('AC-T94-01: criar mostra o token uma vez; a listagem só traz nome, status, expiração e último uso', async () => {
    const s = await signUp()
    expect((await call(s, 'GET', '/api/mcp_credentials')).body).toEqual({ mcp_credentials: [], mcp_endpoint_url: 'https://api.crm.test/api/mcp' })
    const created = await call(s, 'POST', '/api/mcp_credentials', { mcp_credential: { name: 'Cursor', auth_type: 'static', expires_in_days: 30 } })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ token: expect.stringMatching(/^crm_mcp_[\w-]{43}$/), mcp_endpoint_url: 'https://api.crm.test/api/mcp', mcp_credential: { name: 'Cursor', auth_type: 'static', status: 'active', last_used_at: null } })
    const list = await call(s, 'GET', '/api/mcp_credentials')
    expect(Object.keys(list.body.mcp_credentials[0]).sort()).toEqual(['auth_type', 'created_at', 'expires_at', 'id', 'last_used_at', 'name', 'status'])
    expect(JSON.stringify(list.body)).not.toContain(created.body.token)
    const [row] = await db.select().from(mcpCredentials).where(eq(mcpCredentials.id, created.body.mcp_credential.id))
    expect(row!.tokenHash).not.toContain(created.body.token)

    expect((await call(s, 'POST', '/api/mcp_credentials', { name: '' })).status).toBe(422)
    expect((await call(s, 'POST', '/api/mcp_credentials', { name: 'Claude', auth_type: 'oauth' })).status).toBe(422)
    expect((await call(s, 'POST', '/api/mcp_credentials', { name: 'X', expires_at: '2000-01-01T00:00:00Z' })).status).toBe(422)
  })

  it('permissões: só view → lista, não cria nem revoga; outra empresa → 404 ao revogar', async () => {
    const s = await signUp()
    const cred = (await call(s, 'POST', '/api/mcp_credentials', { name: 'n8n' })).body.mcp_credential
    const other = await signUp()
    expect((await call(other, 'DELETE', `/api/mcp_credentials/${cred.id}`)).status).toBe(404)
    const u = await signUp()
    await db.insert(companyMembers).values({ companyId: s.companyId, userId: u.userId, role: 'member', permissionKeys: ['settings.mcp.view'] })
    await db.update(users).set({ lastCompanyId: s.companyId }).where(eq(users.id, u.userId))
    expect((await call(u, 'GET', '/api/mcp_credentials')).body.mcp_credentials).toHaveLength(1)
    expect((await call(u, 'POST', '/api/mcp_credentials', { name: 'X' })).status).toBe(403)
    expect((await call(u, 'DELETE', `/api/mcp_credentials/${cred.id}`)).status).toBe(403)
  })
})

describe('/api/mcp', () => {
  it('AC-T94-02: sem token, inválido, expirado ou revogado → 401; válido grava o último uso', async () => {
    const s = await signUp()
    const { token, mcp_credential } = (await call(s, 'POST', '/api/mcp_credentials', { name: 'Cursor' })).body
    const no = await rpc(null, 'tools/list')
    expect(no.status).toBe(401)
    expect(no.headers.get('www-authenticate')).toBe('Bearer realm="mcp"')
    expect(no.body.error.code).toBe('UNAUTHORIZED')
    expect((await rpc('crm_mcp_naoexiste', 'tools/list')).status).toBe(401)
    expect((await rpc(`${token}x`, 'tools/list')).status).toBe(401)

    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(init.status).toBe(200)
    expect(init.body.result.serverInfo).toMatchObject({ name: 'leonas-crm' })
    expect((await call(s, 'GET', '/api/mcp_credentials')).body.mcp_credentials[0].last_used_at).toEqual(expect.any(String))

    await db.update(mcpCredentials).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(mcpCredentials.id, mcp_credential.id))
    expect((await rpc(token, 'tools/list')).status).toBe(401)
    expect((await call(s, 'GET', '/api/mcp_credentials')).body.mcp_credentials[0].status).toBe('expired')

    const second = (await call(s, 'POST', '/api/mcp_credentials', { name: 'n8n' })).body
    expect((await rpc(second.token, 'tools/list')).status).toBe(200)
    expect((await call(s, 'DELETE', `/api/mcp_credentials/${second.mcp_credential.id}`)).body).toEqual({ ok: true })
    expect((await rpc(second.token, 'tools/list')).status).toBe(401)
    expect((await call(s, 'GET', '/api/mcp_credentials')).body.mcp_credentials.map((c: any) => c.id)).toEqual([mcp_credential.id])
  })

  it('AC-T94-03: ferramentas só de leitura e com dados apenas da empresa do token', async () => {
    const a = await signUp()
    const b = await signUp()
    const seed = async (s: Session, tag: string) => {
      const [contact] = await db.insert(contacts).values({ companyId: s.companyId, name: `Contato ${tag}`, phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, email: `${tag}@x.com` }).returning()
      const [conn] = await db.insert(connections).values({ companyId: s.companyId, sessionId: `s-${rnd()}`, name: `Conexão ${tag}`, phoneNumber: '5511999990000', connectionState: 'open' }).returning()
      await db.insert(chats).values({ companyId: s.companyId, connectionId: conn!.id, contactId: contact!.id, status: 'waiting', unreadCount: 2, lastMessagePreview: `oi ${tag}`, lastMessageAt: new Date() })
      await call(s, 'POST', '/api/flows', { name: `Fluxo ${tag}` })
      return contact!
    }
    const ca = await seed(a, 'A')
    const cb = await seed(b, 'B')
    const token = (await call(a, 'POST', '/api/mcp_credentials', { name: 'Cursor' })).body.token

    const list = await rpc(token, 'tools/list')
    const tools = list.body.result.tools as any[]
    expect(tools.map((t) => t.name).sort()).toEqual(['get_contact', 'list_chats', 'list_connections', 'list_contacts', 'list_flows'])
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })

    expect((await tool(token, 'list_contacts')).data.contacts.map((c: any) => c.name)).toEqual(['Contato A'])
    expect((await tool(token, 'list_contacts', { search: 'B' })).data.contacts).toEqual([])
    expect((await tool(token, 'get_contact', { id: ca.id })).data.contact).toMatchObject({ id: ca.id, name: 'Contato A', email: 'A@x.com' })
    const foreign = await tool(token, 'get_contact', { id: cb.id })
    expect(foreign).toEqual({ isError: true, data: { error: 'not_found' } })
    expect((await tool(token, 'list_connections')).data.connections.map((c: any) => c.name)).toEqual(['Conexão A'])
    expect((await tool(token, 'list_flows')).data.flows.map((f: any) => f.name)).toEqual(['Fluxo A'])
    expect((await tool(token, 'list_chats')).data.chats).toEqual([
      expect.objectContaining({ status: 'waiting', unread_count: 2, last_message_preview: 'oi A', contact: expect.objectContaining({ id: ca.id, name: 'Contato A' }) }),
    ])
    const unknown = await rpc(token, 'tools/call', { name: 'delete_contact', arguments: { id: ca.id } })
    expect(unknown.body.error ?? unknown.body.result?.isError).toBeTruthy()
    expect((await db.select().from(contacts).where(eq(contacts.id, ca.id))).length).toBe(1)
  })
})
