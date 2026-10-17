/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Acesso de suporte pela API (AC-T32-01..04): pedido do `support`, aprovação só por owner/admin (12 h), escopo só
// fluxos/MCP, expiração e revogação na próxima requisição, eventos na empresa e no stream do suporte, SSE do suporte.
import { randomBytes, randomUUID } from 'node:crypto'
import { RealtimePublisher } from '@crm/core'
import { auditLogs, companyMembers, createDb, supportAccessGrants, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, hashPassword, MemoryMailer, redisConnection } from '@crm/node-kit'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'
import { stopRealtimeHub } from '../events/index'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const prefix = `crm:rt:t32:${rnd()}`
const HOUR = 60 * 60 * 1000
let offsetMs = 0
const now = () => new Date(Date.now() + offsetMs)

interface Session {
  cookie: string
  companyId: string
  userId: string
  email: string
}

async function login(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, 'x-forwarded-for': `10.32.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ email, password }) })
  expect(res.status).toBe(200)
  return /crm_session=[^;]+/.exec(res.headers.get('set-cookie') ?? '')![0]
}

async function signUp(): Promise<Session> {
  const email = `o-${rnd()}@x.com`
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Dono', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  return { cookie: await login(email, '12345678'), companyId: user.last_company_id, userId: user.id, email }
}

/** Usuário sem empresa inserido direto no banco; `support` assim (o admin que cria esse papel é a T95). */
async function insertUser(systemRole: 'user' | 'support', lastCompanyId: string | null = null): Promise<Session> {
  const email = `${systemRole}-${rnd()}@x.com`
  const [u] = await db
    .insert(users)
    .values({ email, name: systemRole === 'support' ? 'Suporte' : 'Membro', passwordHash: await hashPassword('12345678'), systemRole, lastCompanyId })
    .returning({ id: users.id })
  return { cookie: await login(email, '12345678'), companyId: lastCompanyId ?? '', userId: u!.id, email }
}
const supportUser = () => insertUser('support')

/** Membro (`role`) só da empresa de `owner`, com sessão própria. */
async function memberOf(owner: Session, role: 'admin' | 'member'): Promise<Session> {
  const s = await insertUser('user', owner.companyId)
  await db.insert(companyMembers).values({ companyId: owner.companyId, userId: s.userId, role })
  return s
}

const call = async (s: Session, method: string, path: string, body?: unknown, companyId?: string) => {
  const res = await app.request(path, {
    method,
    headers: { ...H, cookie: s.cookie, ...(companyId ? { 'x-company-id': companyId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : {} }
}

async function events(stream: string): Promise<{ type: string; data: any }[]> {
  const rows = (await redis.xrange(stream, '-', '+')) as [string, string[]][]
  return rows.map(([, f]) => {
    const m: Record<string, string> = {}
    for (let i = 0; i < f.length; i += 2) m[f[i]!] = f[i + 1]!
    return { type: m.type!, data: JSON.parse(m.data!) }
  })
}
const companyEvents = (companyId: string) => events(`${prefix}:${companyId}`)
const userEvents = (userId: string) => events(`${prefix}:user:${userId}`)

/** Pedido do suporte aprovado pelo owner: devolve o pedido e a concessão. */
async function granted(owner: Session, sup: Session) {
  const req = await call(sup, 'POST', '/api/support/access-requests', { email: owner.email })
  expect(req.status).toBe(201)
  const ok = await call(owner, 'POST', `/api/support-access/requests/${req.body.request.id}/approve`)
  expect(ok.status).toBe(200)
  return ok.body as { request: any; grant: any }
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
    logger: createLogger({ level: 'silent' }),
    realtime: { prefix, heartbeatMs: 60_000 },
    supportAccess: { now },
  })
}, 120_000)

afterAll(async () => {
  await stopRealtimeHub(redis)
  const keys = await redis.keys(`${prefix}*`)
  if (keys.length) await redis.del(...keys)
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('lado do suporte', () => {
  it('AC-T32-04: quem não é support não faz lookup nem cria pedido (403)', async () => {
    const owner = await signUp()
    const other = await signUp()
    expect((await call(other, 'POST', '/api/support/access-requests', { email: owner.email })).status).toBe(403)
    expect((await call(other, 'POST', '/api/support/access-requests/lookup', { email: owner.email })).status).toBe(403)
    expect((await call(other, 'GET', '/api/support/access-requests')).status).toBe(403)
    expect((await call(other, 'GET', '/api/support/access-grants')).status).toBe(403)
  })

  it('lookup só devolve empresas em que o e-mail é owner/admin; pedido escolhe sozinho a única empresa', async () => {
    const owner = await signUp()
    const plain = await memberOf(owner, 'member')
    const admin = await memberOf(owner, 'admin')
    const sup = await supportUser()
    expect((await call(sup, 'POST', '/api/support/access-requests/lookup', { email: plain.email })).body).toEqual({ accounts: [] })
    expect((await call(sup, 'POST', '/api/support/access-requests/lookup', { email: 'ninguem@x.com' })).body).toEqual({ accounts: [] })
    const viaAdmin = await call(sup, 'POST', '/api/support/access-requests/lookup', { access_request: { email: admin.email.toUpperCase() } })
    expect(viaAdmin.body.accounts.map((a: any) => a.id)).toContain(owner.companyId)

    expect((await call(sup, 'POST', '/api/support/access-requests', { email: plain.email })).body.error.details.error_code).toBe('account_not_found')
    // Admin também em outra empresa: 2 contas → precisa escolher.
    const second = await signUp()
    await db.insert(companyMembers).values({ companyId: second.companyId, userId: admin.userId, role: 'admin' })
    const ambiguous = await call(sup, 'POST', '/api/support/access-requests', { email: admin.email })
    expect(ambiguous.status).toBe(422)
    expect(ambiguous.body.error.details.error_code).toBe('account_required')
    expect(ambiguous.body.error.details.accounts).toHaveLength(2)
    const chosen = await call(sup, 'POST', '/api/support/access-requests', { access_request: { email: admin.email, account_id: owner.companyId } })
    expect(chosen.status).toBe(201)
    expect(chosen.body.request).toMatchObject({ status: 'pending', support_user_id: sup.userId, support_name: 'Suporte', support_email: sup.email, company_id: owner.companyId })
    expect((await call(sup, 'POST', '/api/support/access-requests', { email: owner.email })).body.error.details.error_code).toBe('request_pending')
  })

  it('reenviar e cancelar só pedidos pendentes do próprio suporte; cancelar publica support_access.cancelled', async () => {
    const owner = await signUp()
    const sup = await supportUser()
    const other = await supportUser()
    const { request } = (await call(sup, 'POST', '/api/support/access-requests', { email: owner.email })).body
    expect((await call(other, 'DELETE', `/api/support/access-requests/${request.id}`)).status).toBe(404)
    const resent = await call(sup, 'POST', `/api/support/access-requests/${request.id}/resend`)
    expect(resent.status).toBe(200)
    expect(resent.body.request.resent_at).toEqual(expect.any(String))
    expect((await companyEvents(owner.companyId)).filter((e) => e.type === 'support_access.requested')).toHaveLength(2)

    const cancelled = await call(sup, 'DELETE', `/api/support/access-requests/${request.id}`)
    expect(cancelled.body.request.status).toBe('cancelled')
    expect((await call(sup, 'DELETE', `/api/support/access-requests/${request.id}`)).status).toBe(409)
    expect((await call(sup, 'POST', `/api/support/access-requests/${request.id}/resend`)).body.error.code).toBe('INVALID_TRANSITION')
    expect((await companyEvents(owner.companyId)).map((e) => e.type)).toContain('support_access.cancelled')
    expect((await userEvents(sup.userId)).map((e) => e.type)).toContain('support_access.cancelled')
    expect((await call(sup, 'GET', '/api/support/access-requests')).body.requests[0]).toMatchObject({ id: request.id, status: 'cancelled' })

    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, owner.companyId), eq(auditLogs.action, 'support_access.cancel')))
    expect(audit).toMatchObject({ actorUserId: sup.userId, targetId: request.id })
  })
})

describe('lado da empresa', () => {
  it('AC-T32-01: só owner/admin aprova (member e o próprio suporte → 403); a concessão expira em 12 h', async () => {
    const owner = await signUp()
    const member = await memberOf(owner, 'member')
    const admin = await memberOf(owner, 'admin')
    const sup = await supportUser()
    const { request } = (await call(sup, 'POST', '/api/support/access-requests', { email: owner.email })).body

    expect((await call(member, 'GET', '/api/support-access/requests')).status).toBe(403)
    const denied = await call(member, 'POST', `/api/support-access/requests/${request.id}/approve`)
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('FORBIDDEN')
    expect((await call(member, 'POST', `/api/support-access/requests/${request.id}/reject`)).status).toBe(403)

    const pending = await call(admin, 'GET', '/api/support-access/requests')
    expect(pending.body.requests).toEqual([expect.objectContaining({ id: request.id, status: 'pending', support_email: sup.email })])

    const before = now().getTime()
    const ok = await call(admin, 'POST', `/api/support-access/requests/${request.id}/approve`)
    expect(ok.status).toBe(200)
    expect(ok.body.request.status).toBe('approved')
    expect(ok.body.grant).toMatchObject({ support_user_id: sup.userId, name: 'Suporte', email: sup.email, company_id: owner.companyId })
    const ttl = new Date(ok.body.grant.expires_at).getTime() - before
    expect(ttl).toBeGreaterThanOrEqual(12 * HOUR - 1000)
    expect(ttl).toBeLessThanOrEqual(12 * HOUR + 1000)
    expect((await call(owner, 'POST', `/api/support-access/requests/${request.id}/approve`)).status).toBe(409)
    expect((await call(owner, 'GET', '/api/support-access/grants')).body.grants).toEqual([expect.objectContaining({ support_user_id: sup.userId })])
    expect((await call(member, 'GET', '/api/support-access/grants')).status).toBe(403)
    // O suporte, agora com concessão, também não aprova nada na empresa.
    expect((await call(sup, 'GET', '/api/support-access/requests', undefined, owner.companyId)).status).toBe(403)

    // Outra empresa não enxerga o pedido (404).
    const stranger = await signUp()
    expect((await call(stranger, 'POST', `/api/support-access/requests/${request.id}/reject`)).status).toBe(404)
  })

  it('recusar publica support_access.rejected para a empresa e o suporte', async () => {
    const owner = await signUp()
    const sup = await supportUser()
    const { request } = (await call(sup, 'POST', '/api/support/access-requests', { email: owner.email })).body
    const rejected = await call(owner, 'POST', `/api/support-access/requests/${request.id}/reject`)
    expect(rejected.body.request.status).toBe('rejected')
    expect((await companyEvents(owner.companyId)).map((e) => e.type)).toContain('support_access.rejected')
    expect((await userEvents(sup.userId)).find((e) => e.type === 'support_access.rejected')?.data.request.id).toBe(request.id)
    expect((await call(sup, 'GET', '/api/flows', undefined, owner.companyId)).status).toBe(404)
  })
})

describe('concessão ativa', () => {
  it('AC-T32-02: o support lê e edita fluxos e MCP; contatos, equipe e variáveis globais → 403', async () => {
    const owner = await signUp()
    const sup = await supportUser()
    const { grant } = await granted(owner, sup)
    const created = await call(sup, 'POST', '/api/flows', { name: 'Fluxo do suporte' }, owner.companyId)
    expect(created.status).toBe(201)
    const flowId = created.body.flow.id
    expect((await call(sup, 'PATCH', `/api/flows/${flowId}`, { name: 'Renomeado' }, owner.companyId)).status).toBe(200)
    const list = await call(sup, 'GET', '/api/flows', undefined, owner.companyId)
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body)).toContain('Renomeado')
    expect((await call(sup, 'GET', '/api/mcp_credentials', undefined, owner.companyId)).status).toBe(200)

    for (const path of ['/api/contacts', '/api/team', '/api/chats', '/api/global-variables']) {
      expect((await call(sup, 'GET', path, undefined, owner.companyId)).status, path).toBe(403)
    }
    expect((await call(sup, 'POST', '/api/contacts', { name: 'X', phone: '+5511999990000' }, owner.companyId)).status).toBe(403)

    // Área do suporte: concessões e fluxos da empresa concedida.
    expect((await call(sup, 'GET', '/api/support/access-grants')).body.grants).toEqual([expect.objectContaining({ id: grant.id, company_id: owner.companyId })])
    expect((await call(sup, 'GET', `/api/support/access-grants/${owner.companyId}/flows`)).body.flows).toEqual([
      expect.objectContaining({ id: flowId, name: 'Renomeado' }),
    ])
    const stranger = await signUp()
    expect((await call(sup, 'GET', `/api/support/access-grants/${stranger.companyId}/flows`)).status).toBe(404)
    expect((await call(sup, 'GET', '/api/flows', undefined, stranger.companyId)).status).toBe(404)

    // Perfil/troca de empresa: a empresa concedida aparece com as permissões da concessão.
    const profile = await call(sup, 'GET', '/api/auth/profile')
    const entry = profile.body.companies.find((c: any) => c.id === owner.companyId)
    expect(entry).toMatchObject({ support_access: { grant_id: grant.id, expires_at: grant.expires_at } })
    expect(entry.effective_permissions).toContain('flows.edit')
    expect(entry.effective_permissions).not.toContain('contacts.view')
    expect(entry.effective_permissions).not.toContain('settings.global_variables.view')

    // Auditoria: a ação do suporte identifica a concessão.
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, owner.companyId), eq(auditLogs.action, 'flow.create')))
    expect(audit!.actorUserId).toBe(sup.userId)
    expect(audit!.detail).toMatchObject({ support_grant_id: grant.id })
  })

  it('AC-T32-02: concessão expirada (relógio) → 403 support_access_expired na próxima requisição', async () => {
    const owner = await signUp()
    const sup = await supportUser()
    await granted(owner, sup)
    expect((await call(sup, 'GET', '/api/flows', undefined, owner.companyId)).status).toBe(200)
    offsetMs = 12 * HOUR + 1000
    try {
      const res = await call(sup, 'GET', '/api/flows', undefined, owner.companyId)
      expect(res.status).toBe(403)
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { error_code: 'support_access_expired' } })
      // Sem X-Company-Id: o suporte fica sem empresa ativa → 403.
      expect((await call(sup, 'GET', '/api/flows')).status).toBe(403)
      expect((await call(owner, 'GET', '/api/support-access/grants')).body.grants).toEqual([])
    } finally {
      offsetMs = 0
    }
  })

  it('AC-T32-02/03: revogar vale na próxima requisição e publica support_access.revoked', async () => {
    const owner = await signUp()
    const sup = await supportUser()
    const { request, grant } = await granted(owner, sup)
    // Sem header: a empresa concedida vira a ativa do suporte.
    expect((await call(sup, 'GET', '/api/flows')).status).toBe(200)
    expect((await call(owner, 'DELETE', `/api/support-access/grants/${randomUUID()}`)).status).toBe(404)
    const revoked = await call(owner, 'DELETE', `/api/support-access/grants/${sup.userId}`)
    expect(revoked.status).toBe(200)
    expect(revoked.body.grant).toMatchObject({ id: grant.id, support_user_id: sup.userId })
    expect((await call(sup, 'GET', '/api/flows')).status).toBe(403)
    const after = await call(sup, 'POST', '/api/flows', { name: 'X' }, owner.companyId)
    expect(after.status).toBe(403)
    expect(after.body.error.details.error_code).toBe('support_access_expired')
    const [row] = await db.select().from(supportAccessGrants).where(eq(supportAccessGrants.id, grant.id))
    expect(row!.revokedByUserId).toBe(owner.userId)

    // AC-T32-03: pedir, aprovar e revogar → eventos na empresa e no stream do suporte.
    const types = ['support_access.requested', 'support_access.granted', 'support_access.revoked']
    const company = await companyEvents(owner.companyId)
    const mine = await userEvents(sup.userId)
    for (const t of types) {
      expect(company.map((e) => e.type), t).toContain(t)
      expect(mine.map((e) => e.type), t).toContain(t)
    }
    expect(company.find((e) => e.type === 'support_access.requested')!.data.request).toMatchObject({
      id: request.id,
      status: 'pending',
      support_name: 'Suporte',
      support_email: sup.email,
      company_id: owner.companyId,
    })
    expect(mine.find((e) => e.type === 'support_access.granted')!.data.grant).toMatchObject({ id: grant.id, expires_at: grant.expires_at })
    expect(mine.find((e) => e.type === 'support_access.revoked')!.data.grant.id).toBe(grant.id)
  })
})

describe('SSE do suporte', () => {
  async function open(s: Session, companyId: string) {
    const res = await app.request(`/api/events?company_id=${companyId}`, { headers: { cookie: s.cookie } })
    if (res.status !== 200) return { status: res.status, text: () => '', cancel: async () => undefined }
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          text += decoder.decode(value, { stream: true })
        }
      } catch {
        // cancelado
      }
    })()
    return { status: 200, text: () => text, cancel: () => reader.cancel().catch(() => undefined) }
  }
  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const until = Date.now() + ms
    while (Date.now() < until && !pred()) await new Promise((r) => setTimeout(r, 20))
    return pred()
  }

  it('AC-T32-03: sem pedido → 404; com pedido pendente recebe só a decisão; com concessão recebe os eventos de fluxos', async () => {
    const owner = await signUp()
    const sup = await supportUser()
    expect((await open(sup, owner.companyId)).status).toBe(404)

    const { request } = (await call(sup, 'POST', '/api/support/access-requests', { email: owner.email })).body
    const pending = await open(sup, owner.companyId)
    expect(pending.status).toBe(200)
    // Espera a conexão assinar o hub: reenvio publica `support_access.requested` de novo.
    await waitFor(() => pending.text().includes('retry'))
    await call(sup, 'POST', `/api/support/access-requests/${request.id}/resend`)
    expect(await waitFor(() => pending.text().includes('event: support_access.requested'))).toBe(true)
    // Evento comum da empresa antes da decisão: não pode chegar a quem só tem pedido pendente.
    await new RealtimePublisher({ redis, prefix }).publish(owner.companyId, 'company.updated', { name: 'Empresa renomeada' })
    await call(owner, 'POST', `/api/support-access/requests/${request.id}/approve`)
    expect(await waitFor(() => pending.text().includes('event: support_access.granted'))).toBe(true)
    expect(pending.text()).not.toContain('company.updated')
    await pending.cancel()

    const active = await open(sup, owner.companyId)
    expect(active.status).toBe(200)
    await waitFor(() => active.text().includes('retry'))
    await call(owner, 'DELETE', `/api/support-access/grants/${sup.userId}`)
    expect(await waitFor(() => active.text().includes('event: support_access.revoked'))).toBe(true)
    await active.cancel()
    expect((await open(sup, owner.companyId)).status).toBe(404)
  })
})
