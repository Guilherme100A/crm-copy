import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { hashToken, SESSION_COOKIE } from '@crm/core'
import { apiTokens, auditLogs, authSessions, companies, companyMembers, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, redisConnection } from '@crm/node-kit'
import { createApp, getCtx, rateLimit, requirePerm, requirePlatformRole, setAudit, validate, type AppEnv, type RedisClient } from '../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const logLines: string[] = []

const ids = { coA: '', coB: '', owner: '', member: '', loner: '' }
const tokens = { owner: '', member: '', loner: '', expired: '', revoked: '', pat: '', patRevoked: '' }

const rlName = `t08-${randomBytes(4).toString('hex')}`
const tok = () => randomBytes(32).toString('base64url')
const errCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code
const cookie = (t: string) => ({ cookie: `${SESSION_COOKIE}=${t}` })
const browser = (t: string) => ({ ...cookie(t), 'x-requested-with': 'crm', 'content-type': 'application/json' })

async function session(userId: string, token: string, opts: { expired?: boolean; revoked?: boolean } = {}) {
  const now = Date.now()
  await db.insert(authSessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(opts.expired ? now - 1000 : now + 86_400_000),
    revokedAt: opts.revoked ? new Date() : null,
  })
}

function probeRoutes() {
  const probe = new Hono<AppEnv>()
  probe.get('/api/__t08/me', (c) => {
    const ctx = getCtx(c)
    return c.json({ user_id: ctx.user?.id ?? null, company_id: ctx.companyId, role: ctx.member?.role ?? null, kind: ctx.auth.kind })
  })
  probe.post('/api/__t08/contacts', requirePerm('contacts.edit'), (c) => c.json({ ok: true }, 201))
  probe.post(
    '/api/__t08/items',
    validate('json', z.object({ name: z.string().min(1), nested: z.object({ n: z.number() }), password: z.string().optional() })),
    (c) => {
      const body = c.req.valid('json')
      setAudit(c, { targetType: 'item', targetId: 'it-1', detail: { name: body.name, password: body.password, deep: { token: 'tk' } } })
      return c.json({ id: 'it-1' }, 201)
    },
  )
  probe.post('/api/__t08/boom', () => {
    throw new Error('segredo interno em /src/arquivo.ts')
  })
  probe.get('/api/__t08/admin', requirePlatformRole('platform_admin'), (c) => c.json({ ok: true }))
  probe.get('/api/__t08/limited', rateLimit({ redis, name: rlName, limit: 2, windowMs: 10_000 }), (c) => c.json({ ok: true }))
  return probe
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })

  const [a, b] = await db
    .insert(companies)
    .values([
      { name: 'A', slug: `a-${tok().slice(0, 6)}` },
      { name: 'B', slug: `b-${tok().slice(0, 6)}` },
    ])
    .returning({ id: companies.id })
  ids.coA = a!.id
  ids.coB = b!.id
  const [o, m, l] = await db
    .insert(users)
    .values([
      { email: 'owner@x.com', passwordHash: 'h', name: 'Owner', lastCompanyId: ids.coA },
      { email: 'member@x.com', passwordHash: 'h', name: 'Member', lastCompanyId: ids.coA },
      { email: 'loner@x.com', passwordHash: 'h', name: 'Loner' },
    ])
    .returning({ id: users.id })
  ids.owner = o!.id
  ids.member = m!.id
  ids.loner = l!.id
  await db.insert(companyMembers).values([
    { companyId: ids.coA, userId: ids.owner, role: 'owner' },
    { companyId: ids.coB, userId: ids.owner, role: 'owner' },
    { companyId: ids.coA, userId: ids.member, role: 'member', permissionKeys: ['chat.view'] },
  ])
  for (const k of ['owner', 'member', 'loner', 'expired', 'revoked'] as const) tokens[k] = tok()
  await session(ids.owner, tokens.owner)
  await session(ids.member, tokens.member)
  await session(ids.loner, tokens.loner)
  await session(ids.owner, tokens.expired, { expired: true })
  await session(ids.owner, tokens.revoked, { revoked: true })
  tokens.pat = `crm_pat_${tok()}`
  tokens.patRevoked = `crm_pat_${tok()}`
  await db.insert(apiTokens).values([
    { companyId: ids.coA, createdByUserId: ids.owner, name: 'int', tokenHash: hashToken(tokens.pat), tokenPrefix: 'crm_pat_x' },
    { companyId: ids.coA, name: 'old', tokenHash: hashToken(tokens.patRevoked), tokenPrefix: 'crm_pat_y', revokedAt: new Date() },
  ])

  const destination = new Writable({
    write(chunk, _e, cb) {
      logLines.push(String(chunk))
      cb()
    },
  })
  app = createApp({ db, redis, logger: createLogger({ destination, level: 'debug' }) })
  app.route('/', probeRoutes())
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('AC-T08-01 health', () => {
  it('GET /health sem auth → 200 { status, db, redis }', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok', redis: 'ok' })
  })

  it('Redis fora → redis: "down" e 200, rápido', async () => {
    const dead = redisConnection({ url: 'redis://127.0.0.1:1/1', lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null })
    const down = createApp({ db, redis: dead, logger: createLogger({ level: 'silent' }), healthTimeoutMs: 500 })
    const t0 = Date.now()
    const res = await down.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'degraded', db: 'ok', redis: 'down' })
    expect(Date.now() - t0).toBeLessThan(3000)
    dead.disconnect()
  })
})

describe('AC-T08-02 sessão', () => {
  it('sem sessão → 401 UNAUTHORIZED', async () => {
    const res = await app.request('/api/__t08/me')
    expect(res.status).toBe(401)
    expect((await errCode(res))).toBe('UNAUTHORIZED')
  })

  it('sessão expirada, revogada ou desconhecida → 401', async () => {
    for (const t of [tokens.expired, tokens.revoked, tok()]) {
      const res = await app.request('/api/__t08/me', { headers: cookie(t) })
      expect(res.status).toBe(401)
    }
  })

  it('sessão válida → 200 e renova last_seen/expires', async () => {
    const res = await app.request('/api/__t08/me', { headers: cookie(tokens.owner) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user_id: ids.owner, kind: 'session' })
    expect(res.headers.get('set-cookie')).toMatch(/crm_session=.*HttpOnly.*SameSite=Lax/i)
  })

  it('Bearer crm_pat_ válido → empresa do token; revogado ou não-PAT → 401', async () => {
    const ok = await app.request('/api/__t08/me', { headers: { authorization: `Bearer ${tokens.pat}` } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ company_id: ids.coA, user_id: ids.owner, kind: 'api_token' })
    for (const h of [`Bearer ${tokens.patRevoked}`, `Bearer ${tokens.owner}`, 'Basic abc'])
      expect((await app.request('/api/__t08/me', { headers: { authorization: h } })).status).toBe(401)
    const other = await app.request('/api/__t08/me', { headers: { authorization: `Bearer ${tokens.pat}`, 'x-company-id': ids.coB } })
    expect(other.status).toBe(404)
  })

  it('rota pública não exige sessão (cai no 404 de rota)', async () => {
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'crm' } })
    expect(res.status).toBe(404)
  })
})

describe('AC-T08-03 empresa ativa', () => {
  it('X-Company-Id de empresa sem vínculo → 404 NOT_FOUND', async () => {
    for (const h of [ids.coB, 'nao-e-uuid', '00000000-0000-0000-0000-000000000000']) {
      const res = await app.request('/api/__t08/me', { headers: { ...cookie(tokens.member), 'x-company-id': h } })
      expect(res.status).toBe(404)
      expect((await errCode(res))).toBe('NOT_FOUND')
    }
  })

  it('sem header vale last_company_id; com header de empresa própria troca', async () => {
    const a = await app.request('/api/__t08/me', { headers: cookie(tokens.owner) })
    expect(await a.json()).toMatchObject({ company_id: ids.coA })
    const b = await app.request('/api/__t08/me', { headers: { ...cookie(tokens.owner), 'x-company-id': ids.coB } })
    expect(await b.json()).toMatchObject({ company_id: ids.coB, role: 'owner' })
  })

  it('usuário sem empresa → company_id null', async () => {
    const res = await app.request('/api/__t08/me', { headers: cookie(tokens.loner) })
    expect(await res.json()).toMatchObject({ company_id: null, role: null })
  })
})

describe('AC-T08-04 requirePerm', () => {
  it('membro sem a chave → 403; owner → 201; sem empresa → 403', async () => {
    const m = await app.request('/api/__t08/contacts', { method: 'POST', headers: browser(tokens.member) })
    expect(m.status).toBe(403)
    expect((await errCode(m))).toBe('FORBIDDEN')
    expect((await app.request('/api/__t08/contacts', { method: 'POST', headers: browser(tokens.owner) })).status).toBe(201)
    expect((await app.request('/api/__t08/contacts', { method: 'POST', headers: browser(tokens.loner) })).status).toBe(403)
  })

  it('requirePlatformRole → 403 para usuário comum', async () => {
    expect((await app.request('/api/__t08/admin', { headers: cookie(tokens.owner) })).status).toBe(403)
  })
})

describe('AC-T08-05 validação e erros', () => {
  it('corpo inválido → 422 com details.fields[].path', async () => {
    const res = await app.request('/api/__t08/items', { method: 'POST', headers: browser(tokens.owner), body: JSON.stringify({ name: '', nested: { n: 'x' } }) })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; details: { fields: { path: string }[] } } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.fields.map((f) => f.path).sort()).toEqual(['name', 'nested.n'])
  })

  it('JSON malformado → 400 MALFORMED_REQUEST', async () => {
    const res = await app.request('/api/__t08/items', { method: 'POST', headers: browser(tokens.owner), body: '{"name":' })
    expect(res.status).toBe(400)
    expect((await errCode(res))).toBe('MALFORMED_REQUEST')
  })

  it('erro não tratado → 500 INTERNAL sem stack nem mensagem interna', async () => {
    const res = await app.request('/api/__t08/boom', { method: 'POST', headers: browser(tokens.owner) })
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } })
    expect(text).not.toMatch(/segredo|\.ts|at /)
  })

  it('rota inexistente → 404 NOT_FOUND no formato padrão', async () => {
    const res = await app.request('/nada')
    expect(res.status).toBe(404)
    expect((await errCode(res))).toBe('NOT_FOUND')
  })
})

describe('AC-T08-06 auditoria e CSRF', () => {
  it('mutação bem-sucedida grava audit_logs sem segredos', async () => {
    const res = await app.request('/api/__t08/items', {
      method: 'POST',
      headers: browser(tokens.owner),
      body: JSON.stringify({ name: 'n1', nested: { n: 1 }, password: 'p4ss-SECRET' }),
    })
    expect(res.status).toBe(201)
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.actorUserId, ids.owner), eq(auditLogs.targetId, 'it-1')))
    expect(row).toMatchObject({ companyId: ids.coA, actorUserId: ids.owner, action: 'POST /api/__t08/items', targetType: 'item' })
    const detail = JSON.stringify(row!.detail)
    expect(detail).toContain('n1')
    expect(detail).not.toMatch(/p4ss-SECRET|password|token|"tk"/)
  })

  it('falha (4xx) não é auditada', async () => {
    const before = (await db.select().from(auditLogs)).length
    await app.request('/api/__t08/contacts', { method: 'POST', headers: browser(tokens.member) })
    expect((await db.select().from(auditLogs)).length).toBe(before)
  })

  it('POST de navegador sem X-Requested-With: crm → 403; Bearer não exige', async () => {
    const res = await app.request('/api/__t08/contacts', { method: 'POST', headers: cookie(tokens.owner) })
    expect(res.status).toBe(403)
    expect(await errCode(res)).toBe('FORBIDDEN')
    const pat = await app.request('/api/__t08/contacts', { method: 'POST', headers: { authorization: `Bearer ${tokens.pat}` } })
    expect(pat.status).toBe(201)
  })

  it('logs não contêm o token de sessão', () => {
    expect(logLines.join('')).not.toContain(tokens.owner)
  })
})

describe('rateLimit (Redis)', () => {
  it('excedido → 429 RATE_LIMIT com Retry-After', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) statuses.push((await app.request('/api/__t08/limited', { headers: cookie(tokens.owner) })).status)
    expect(statuses).toEqual([200, 200, 429])
    const res = await app.request('/api/__t08/limited', { headers: cookie(tokens.owner) })
    expect(await errCode(res)).toBe('RATE_LIMIT')
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})
