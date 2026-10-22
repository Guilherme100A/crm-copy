/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// MCP com escrita: a ferramenta chama a própria API como o usuário dono da credencial (permissões, auditoria e
// isolamento da rota valem); credencial `read` nunca grava; o ator só existe no fetch interno (não vem da rede).
import { randomBytes } from 'node:crypto'
import { auditLogs, chats, companyMembers, connections, contacts, createDb, flows, mcpCredentials, memberConnections, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'
import { internalApi } from './index'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const T94 = ['get_contact', 'list_chats', 'list_connections', 'list_contacts', 'list_flows']

interface Session {
  cookie: string
  companyId: string
  userId: string
}
async function signUp(): Promise<Session> {
  const email = `w-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.95.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'W', email, password: '12345678', password_confirmation: '12345678' }) })
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
async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}
const toolNames = async (token: string) => ((await rpc(token, 'tools/list')).body.result.tools as any[]).map((t) => t.name as string)
const credential = async (s: Session, access: 'read' | 'write') =>
  (await call(s, 'POST', '/api/mcp_credentials', { mcp_credential: { name: `c-${access}`, access } })).body as { token: string; mcp_credential: { id: string; access: string } }
/** `perms` substitui as permissões calculadas do vínculo (o dono tem todas). */
const actorFor = async (s: Session, credentialId: string, permsOverride?: string[]) => {
  const [member] = await db.select().from(companyMembers).where(and(eq(companyMembers.userId, s.userId), eq(companyMembers.companyId, s.companyId)))
  const [user] = await db.select().from(users).where(eq(users.id, s.userId))
  const { effectivePermissions } = await import('@crm/shared')
  const perms = permsOverride ? new Set(permsOverride as any[]) : effectivePermissions({ role: member!.role, permissionKeys: member!.permissionKeys, systemRole: user!.systemRole })
  return { user: { id: user!.id, email: user!.email, name: user!.name, systemRole: user!.systemRole, locale: user!.locale, lastCompanyId: user!.lastCompanyId }, companyId: s.companyId, member: member!, perms, credentialId }
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

describe('credencial MCP com escrita', () => {
  it('nasce `read` por padrão; `access: write` fica na credencial', async () => {
    const s = await signUp()
    expect((await call(s, 'POST', '/api/mcp_credentials', { name: 'Padrão' })).body.mcp_credential.access).toBe('read')
    expect((await credential(s, 'write')).mcp_credential.access).toBe('write')
    expect((await call(s, 'POST', '/api/mcp_credentials', { name: 'X', access: 'admin' })).status).toBe(422)
  })

  it('`read` lista só ferramentas de leitura; `write` acrescenta as que gravam', async () => {
    const s = await signUp()
    const read = await rpc((await credential(s, 'read')).token, 'tools/list')
    const readTools = read.body.result.tools as any[]
    expect(readTools.map((t) => t.name)).toEqual(expect.arrayContaining(T94))
    for (const t of readTools) expect(t.annotations.readOnlyHint).toBe(true)
    const write = await rpc((await credential(s, 'write')).token, 'tools/list')
    const writeTools = write.body.result.tools as any[]
    expect(writeTools.length).toBeGreaterThan(readTools.length)
    expect(writeTools.some((t) => t.annotations.readOnlyHint === false)).toBe(true)
  })

  it('sem usuário dono (ou dono fora da empresa) → só as 5 ferramentas da T94', async () => {
    const s = await signUp()
    const c = await credential(s, 'write')
    await db.update(mcpCredentials).set({ createdByUserId: null }).where(eq(mcpCredentials.id, c.mcp_credential.id))
    expect((await toolNames(c.token)).sort()).toEqual(T94)

    const owner = await signUp()
    const u = await signUp()
    await db.insert(companyMembers).values({ companyId: owner.companyId, userId: u.userId, role: 'admin' })
    await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, u.userId))
    const uc = await credential({ ...u, companyId: owner.companyId }, 'write')
    expect((await toolNames(uc.token)).length).toBeGreaterThan(T94.length)
    await db.delete(companyMembers).where(and(eq(companyMembers.userId, u.userId), eq(companyMembers.companyId, owner.companyId)))
    expect((await toolNames(uc.token)).sort()).toEqual(T94)
  })
})

describe('chamada interna (internalApi)', () => {
  it('`write` grava como o usuário, na empresa dele, com auditoria da credencial', async () => {
    const s = await signUp()
    const c = await credential(s, 'write')
    const api = internalApi(app, await actorFor(s, c.mcp_credential.id), 'write')
    const res = await api.request('POST', '/api/flows', { body: { name: 'Pelo MCP' }, write: true })
    expect(res.status).toBe(201)
    const [row] = await db.select().from(flows).where(and(eq(flows.companyId, s.companyId), eq(flows.name, 'Pelo MCP')))
    expect(row).toBeDefined()
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, s.companyId), eq(auditLogs.actorUserId, s.userId)))
    expect(audit.some((a) => a.detail?.mcp_credential_id === c.mcp_credential.id)).toBe(true)
    expect((await api.request('GET', '/api/flows', { query: { search: 'Pelo MCP' } })).status).toBe(200)
  })

  it('`read` recusa gravação antes da rota; leitura não grava nem por POST (exceto validar/simular)', async () => {
    const s = await signUp()
    const c = await credential(s, 'read')
    const api = internalApi(app, await actorFor(s, c.mcp_credential.id), 'read')
    expect((await api.request('POST', '/api/flows', { body: { name: 'Não' }, write: true })).status).toBe(403)
    expect((await api.request('POST', '/api/flows', { body: { name: 'Não' } })).status).toBe(403)
    expect(await db.select().from(flows).where(and(eq(flows.companyId, s.companyId), eq(flows.name, 'Não')))).toEqual([])
    const flow = (await call(s, 'POST', '/api/flows', { name: 'Validar' })).body
    const id = flow.flow?.id ?? flow.id
    expect((await api.request('POST', `/api/flows/${id}/validate`)).status).toBe(200)
  })

  it('a rota aplica as permissões do usuário; MCP e SSE ficam fora', async () => {
    const s = await signUp()
    const c = await credential(s, 'write')
    const api = internalApi(app, await actorFor(s, c.mcp_credential.id, ['flows.view']), 'write')
    expect((await api.request('POST', '/api/flows', { body: { name: 'Sem permissão' }, write: true })).status).toBe(403)
    expect((await api.request('GET', '/api/flows')).status).toBe(200)
    expect((await api.request('POST', '/api/mcp', { body: {}, write: true })).status).toBe(403)
    expect((await api.request('GET', '/api/events')).status).toBe(403)
  })

  it('escopo de chat da T31 vale pelo MCP: membro restrito a outra conexão não vê o chat', async () => {
    const owner = await signUp()
    const [contact] = await db.insert(contacts).values({ companyId: owner.companyId, name: 'Cliente', phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }).returning()
    const [conn] = await db.insert(connections).values({ companyId: owner.companyId, sessionId: `s-${rnd()}`, name: 'Chip', phoneNumber: '5511999990000', connectionState: 'open' }).returning()
    await db.insert(chats).values({ companyId: owner.companyId, connectionId: conn!.id, contactId: contact!.id, status: 'waiting', lastMessageAt: new Date() })
    const ownerApi = internalApi(app, await actorFor(owner, (await credential(owner, 'read')).mcp_credential.id), 'read')
    expect(((await ownerApi.request('GET', '/api/chats')).body as any).items).toHaveLength(1)

    const u = await signUp()
    const [m] = await db.insert(companyMembers).values({ companyId: owner.companyId, userId: u.userId, role: 'member', permissionKeys: ['chat.view'] }).returning()
    const [other] = await db.insert(connections).values({ companyId: owner.companyId, sessionId: `s-${rnd()}`, name: 'Outro chip', phoneNumber: '5511999990001', connectionState: 'open' }).returning()
    await db.insert(memberConnections).values({ companyId: owner.companyId, memberId: m!.id, connectionId: other!.id })
    const member = { ...u, companyId: owner.companyId }
    const res = await internalApi(app, await actorFor(member, (await credential(owner, 'read')).mcp_credential.id), 'read').request('GET', '/api/chats')
    expect(res.status).toBe(200)
    expect((res.body as any).items).toEqual([])
  })

  it('o ator não vem da rede: sem credencial a API continua 401', async () => {
    const res = await app.request('/api/flows', { headers: { 'x-mcp-actor': 'qualquer' } })
    expect(res.status).toBe(401)
  })
})
