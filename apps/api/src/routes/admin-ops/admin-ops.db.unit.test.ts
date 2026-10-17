/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Operações do admin pela API (T96): guard platform_admin, avisos/banners (admin + cliente + bootstrap), saúde,
// sessões WhatsApp (perfil crm × ai-manager), segredos só de escrita e uso de IA agregado, com auditoria global.
import { randomBytes } from 'node:crypto'
import { aiUsage, auditLogs, connections, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { and, desc, eq, like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const T0 = Date.parse('2026-05-01T12:00:00Z')
const clock = { t: T0 }
const gateway = new FakeWaGateway({
  sessions: [
    { id: 's-1', name: 'Vendas', state: 'STABLE' },
    { id: 's-orphan', name: 'Solta', state: 'NEW' },
  ],
})
const cipher = createCipher({ key: generateCredentialsKey() })
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const rnd = () => randomBytes(4).toString('hex')
const stream = `t96:api:wsm:${rnd()}`

interface Session {
  cookie: string
  companyId: string
  userId: string
}

const baseDeps = () => ({
  db,
  redis,
  mailer: new MemoryMailer(),
  trustProxy: true,
  logger: createLogger({ level: 'silent' }),
  credentialsCipher: cipher,
  realtimePublisher: { publish: async () => undefined } as never,
})

async function signUp(a = app): Promise<Session> {
  const email = `t96-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.96.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await a.request('/api/auth/register', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }),
  })
  const { user } = (await reg.json()) as any
  const login = await a.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ email, password: '12345678' }),
  })
  return {
    cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0],
    companyId: user.last_company_id,
    userId: user.id,
  }
}
async function platformAdmin(a = app): Promise<Session> {
  const s = await signUp(a)
  await db.update(users).set({ systemRole: 'platform_admin' }).where(eq(users.id, s.userId))
  return s
}
const call = async (s: Session | null, method: string, path: string, body?: unknown, a = app) => {
  const res = await a.request(path, {
    method,
    headers: { ...H, ...(s ? { cookie: s.cookie } : {}) },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }
}
const lastAudit = async (action: string) =>
  (await db.select().from(auditLogs).where(eq(auditLogs.action, action)).orderBy(desc(auditLogs.createdAt)).limit(1))[0]

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    ...baseDeps(),
    waGateway: gateway,
    waProfile: 'crm',
    adminOps: {
      now: () => new Date(clock.t),
      queues: ['mass-dispatch', 'flow-step'],
      waEventsStream: stream,
      env: { GROQ_API_KEY: 'gsk-env-ENVSECRET-7777' },
    },
  })
}, 120_000)

afterAll(async () => {
  await redis?.del(stream)
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('guard /api/admin/*', () => {
  it('sem platform_admin → 403 (inclusive owner); sem sessão → 401; rota inexistente do admin → 403 para não admin', async () => {
    const owner = await signUp()
    for (const [method, path] of [
      ['GET', '/api/admin/announcements'],
      ['POST', '/api/admin/announcements'],
      ['GET', '/api/admin/banners'],
      ['GET', '/api/admin/health'],
      ['GET', '/api/admin/wa/sessions'],
      ['GET', '/api/admin/platform-secrets'],
      ['PUT', '/api/admin/platform-secrets/openai'],
      ['GET', '/api/admin/ai/usage'],
      ['GET', '/api/admin/nao-existe'],
    ] as const)
      expect(
        (await call(owner, method, path, method === 'GET' ? undefined : { value: 'x', title: 't', message: 'm' }))
          .status,
      ).toBe(403)
    expect((await call(null, 'GET', '/api/admin/health')).status).toBe(401)
    expect((await call(null, 'GET', '/api/announcements')).status).toBe(401)
  })
})

describe('AC-T96-01 avisos e banners', () => {
  it('CRUD de avisos com auditoria global (company_id nulo, ação admin.*) e 422 sem normalizar', async () => {
    const admin = await platformAdmin()
    clock.t = T0
    const bad = await call(admin, 'POST', '/api/admin/announcements', {
      title: 'x',
      message: 'y',
      announcement_type: 'danger',
      expires_at: 'amanhã',
    })
    expect(bad.status).toBe(422)
    expect(bad.body.error.code).toBe('VALIDATION_ERROR')
    expect(bad.body.error.details.fields.map((f: any) => f.path).sort()).toEqual(['announcement_type', 'expires_at'])
    expect((await call(admin, 'POST', '/api/admin/announcements', '{oops')).status).toBe(400)

    const created = await call(admin, 'POST', '/api/admin/announcements', {
      announcement: { title: 'Manutenção', message: 'Hoje às 22h', announcement_type: 'warning', priority: 3 },
    })
    expect(created.status).toBe(201)
    const a = created.body.announcement
    expect(a).toMatchObject({
      title: 'Manutenção',
      announcement_type: 'warning',
      priority: 3,
      active: true,
      expires_at: null,
    })
    const audit = await lastAudit('admin.announcement.create')
    expect(audit).toMatchObject({
      companyId: null,
      actorUserId: admin.userId,
      targetType: 'announcement',
      targetId: a.id,
    })
    expect(audit!.detail).toMatchObject({ admin: true, global: true })
    // Nada de auditoria automática duplicada com a empresa ativa do admin.
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, admin.companyId), like(auditLogs.action, '%announcements%'))),
    ).toEqual([])

    const patched = await call(admin, 'PATCH', `/api/admin/announcements/${a.id}`, { priority: 8 })
    expect(patched.body.announcement.priority).toBe(8)
    expect((await lastAudit('admin.announcement.update'))!.detail).toMatchObject({ fields: ['priority'] })
    expect(
      (await call(admin, 'PUT', `/api/admin/announcements/${a.id}`, { active: false })).body.announcement.active,
    ).toBe(false)
    expect((await call(admin, 'GET', `/api/admin/announcements/${a.id}`)).body.announcement.id).toBe(a.id)
    const list = await call(admin, 'GET', '/api/admin/announcements?search=manut&page=1&limit=20')
    expect(list.body.items.map((x: any) => x.id)).toEqual([a.id])
    expect(list.body.page).toMatchObject({ page: 1, limit: 20, total_count: 1 })
    expect((await call(admin, 'DELETE', `/api/admin/announcements/${a.id}`)).status).toBe(204)
    expect((await lastAudit('admin.announcement.delete'))!.targetId).toBe(a.id)
    expect((await call(admin, 'GET', `/api/admin/announcements/${a.id}`)).status).toBe(404)
    expect((await call(admin, 'PATCH', '/api/admin/announcements/nao-uuid', { priority: 1 })).status).toBe(404)
  })

  it('banner exige imagem (422); cliente e bootstrap recebem só ativos e não expirados, por prioridade decrescente', async () => {
    const admin = await platformAdmin()
    const member = await signUp()
    clock.t = T0
    const noImage = await call(admin, 'POST', '/api/admin/banners', { title: 'Sem imagem' })
    expect(noImage.status).toBe(422)
    expect(noImage.body.error.details.fields.map((f: any) => f.path)).toEqual(['image_url'])

    const mk = async (path: string, body: any) => (await call(admin, 'POST', path, body)).body
    const low = (await mk('/api/admin/announcements', { title: 'low', message: 'm', priority: 1 })).announcement
    const high = (
      await mk('/api/admin/announcements', {
        title: 'high',
        message: 'm',
        priority: 9,
        expires_at: new Date(T0 + 60_000).toISOString(),
      })
    ).announcement
    await mk('/api/admin/announcements', { title: 'off', message: 'm', priority: 50, active: false })
    // Expira no futuro distante para o bootstrap (relógio real) também enxergar a ordem.
    const b1 = (await mk('/api/admin/banners', { image_url: 'https://cdn.example.com/1.png', priority: 1 })).banner
    const b2 = (
      await mk('/api/admin/banners', {
        banner: { title: 'Promo', image_url: 'https://cdn.example.com/2.png', url: 'https://example.com', priority: 5 },
      })
    ).banner
    await mk('/api/admin/banners', {
      image_url: 'https://cdn.example.com/old.png',
      priority: 99,
      expires_at: '2020-01-01T00:00:00Z',
    })
    expect((await lastAudit('admin.banner.create'))!.companyId).toBeNull()

    const ann = await call(member, 'GET', '/api/announcements')
    expect(ann.status).toBe(200)
    expect(ann.body.items.map((x: any) => x.id)).toEqual([high.id, low.id])
    expect((await call(member, 'GET', '/api/banners')).body.items.map((x: any) => x.id)).toEqual([b2.id, b1.id])
    // O relógio passa da expiração do aviso de prioridade 9.
    clock.t = T0 + 60_000
    expect((await call(member, 'GET', '/api/announcements')).body.items.map((x: any) => x.id)).toEqual([low.id])

    const boot = await call(member, 'GET', '/api/dashboard/bootstrap')
    expect(boot.status).toBe(200)
    expect(boot.body.banners.map((x: any) => x.id)).toEqual([b2.id, b1.id])
    expect(boot.body.announcements.map((x: any) => x.id)).toContain(low.id)
    expect(boot.body.announcements.map((x: any) => x.title)).not.toContain('off')

    await call(admin, 'PATCH', `/api/admin/banners/${b2.id}`, { active: false })
    expect((await call(member, 'GET', '/api/banners')).body.items.map((x: any) => x.id)).toEqual([b1.id])
    expect((await call(admin, 'DELETE', `/api/admin/banners/${b1.id}`)).status).toBe(204)
    expect((await lastAudit('admin.banner.delete'))!.targetId).toBe(b1.id)
    expect((await call(admin, 'GET', '/api/admin/banners?active=false')).body.items.map((x: any) => x.id)).toContain(
      b2.id,
    )
  })
})

describe('AC-T96-02 saúde', () => {
  it('devolve filas (waiting/active/failed/delayed/paused), Redis, Postgres e lag do grupo crm', async () => {
    const admin = await platformAdmin()
    await redis.xadd(stream, '*', 'e', '1')
    await redis.xadd(stream, '*', 'e', '2')
    await redis.xgroup('CREATE', stream, 'crm', '0')
    const r = await call(admin, 'GET', '/api/admin/health')
    expect(r.status).toBe(200)
    expect(r.body.queues.map((q: any) => q.name)).toEqual(['mass-dispatch', 'flow-step'])
    for (const q of r.body.queues)
      expect(q).toMatchObject({
        status: 'ok',
        waiting: 0,
        active: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
        is_paused: false,
      })
    expect(r.body.redis.status).toBe('ok')
    expect(r.body.redis.used_memory_bytes).toBeGreaterThan(0)
    expect(r.body.postgres).toMatchObject({ status: 'ok' })
    expect(r.body.postgres.connections).toBeGreaterThan(0)
    expect(r.body.postgres.database_size_bytes).toBeGreaterThan(0)
    expect(r.body.wa_events).toMatchObject({ status: 'ok', group: 'crm', stream, exists: true, lag: 2 })
    expect(r.body.checked_at).toBe(new Date(clock.t).toISOString())
  })
})

describe('AC-T96-03 sessões WhatsApp', () => {
  it('perfil crm: lista as sessões de todas as empresas com estado e empresa dona; órfã com company null', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    // Conexão da empresa do owner apontando para a sessão s-1 do gateway.
    await db.insert(connections).values({ companyId: owner.companyId, sessionId: 's-1', name: 'Vendas' })
    const r = await call(admin, 'GET', '/api/admin/wa/sessions')
    expect(r.status).toBe(200)
    expect(r.body.profile).toBe('crm')
    const byId = Object.fromEntries(r.body.items.map((i: any) => [i.id, i]))
    expect(byId['s-1']).toMatchObject({
      state: 'STABLE',
      company: { id: owner.companyId },
      connection: { name: 'Vendas' },
    })
    expect(byId['s-orphan']).toMatchObject({ state: 'NEW', company: null, connection: null })
    expect(
      (await call(admin, 'GET', `/api/admin/wa/sessions?company_id=${owner.companyId}`)).body.items.map(
        (i: any) => i.id,
      ),
    ).toEqual(['s-1'])
    expect((await call(admin, 'GET', '/api/admin/wa/sessions?orphan=1')).body.total).toBe(1)
  })

  it('WA_RPC_PROFILE=ai-manager (modo extensão) → 404; sem gateway → 502 com mensagem clara', async () => {
    const ext = createApp({ ...baseDeps(), waGateway: gateway, waProfile: 'ai-manager' })
    const admin = await platformAdmin(ext)
    const r = await call(admin, 'GET', '/api/admin/wa/sessions', undefined, ext)
    expect(r.status).toBe(404)
    // O resto do admin segue disponível no modo extensão.
    expect((await call(admin, 'GET', '/api/admin/announcements', undefined, ext)).status).toBe(200)

    const none = createApp({ ...baseDeps(), waProfile: 'crm' })
    const r2 = await call(admin, 'GET', '/api/admin/wa/sessions', undefined, none)
    expect(r2.status).toBe(502)
    expect(r2.body.error).toMatchObject({ code: 'UPSTREAM_ERROR', message: 'Gateway WhatsApp não configurado' })
  })
})

describe('AC-T96-04 segredos de plataforma e uso de IA', () => {
  it('segredos são só de escrita: leitura devolve configured, origem e máscara; auditoria sem o valor', async () => {
    const admin = await platformAdmin()
    const SECRET = 'sk-ant-SUPERSECRET-abcd'
    const before = await call(admin, 'GET', '/api/admin/platform-secrets')
    expect(before.body.items.find((x: any) => x.key === 'groq')).toMatchObject({
      configured: true,
      source: 'env',
      hint: '…7777',
    })
    expect(before.body.items.find((x: any) => x.key === 'anthropic')).toMatchObject({
      configured: false,
      source: null,
      hint: null,
    })

    expect((await call(admin, 'PUT', '/api/admin/platform-secrets/anthropic', { value: '  ' })).status).toBe(422)
    expect((await call(admin, 'PUT', '/api/admin/platform-secrets/aws', { value: 'x' })).status).toBe(404)
    const put = await call(admin, 'PUT', '/api/admin/platform-secrets/anthropic', { value: SECRET })
    expect(put.status).toBe(200)
    expect(put.body.secret).toMatchObject({
      key: 'anthropic',
      configured: true,
      source: 'db',
      hint: '…abcd',
      updated_by_user_id: admin.userId,
    })
    const after = await call(admin, 'GET', '/api/admin/platform-secrets')
    expect(JSON.stringify(after.body)).not.toContain('SUPERSECRET')
    expect(JSON.stringify(after.body)).not.toContain('ENVSECRET')
    expect((await call(admin, 'GET', '/api/admin/platform-secrets/anthropic')).body.secret.source).toBe('db')
    const audit = await lastAudit('admin.platform_secret.update')
    expect(audit).toMatchObject({ companyId: null, targetType: 'platform_secret', targetId: 'anthropic' })
    expect(JSON.stringify(audit!.detail)).not.toContain('SUPERSECRET')
    expect(JSON.stringify(audit!.detail)).not.toContain('abcd')

    // O efeito no runtime (empresa → segredo salvo → env) é coberto em core/admin-ops/platform-secrets.db.unit.test.ts.
    const del = await call(admin, 'DELETE', '/api/admin/platform-secrets/anthropic')
    expect(del.body).toMatchObject({ removed: true, secret: { configured: false, source: null } })
    expect((await lastAudit('admin.platform_secret.delete'))!.targetId).toBe('anthropic')
  })

  it('uso de IA agregado por empresa × modelo, com filtros de período e empresa', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    const row = (model: string, status: 'charged' | 'error', at: string) => ({
      companyId: owner.companyId,
      requestId: `r-${rnd()}`,
      provider: 'anthropic',
      model,
      inputTokens: 10,
      outputTokens: 5,
      costMicros: 100,
      billedMicros: 150,
      credits: 2,
      status,
      createdAt: new Date(at),
    })
    await db
      .insert(aiUsage)
      .values([
        row('m1', 'charged', '2026-04-02T00:00:00Z'),
        row('m1', 'charged', '2026-04-03T00:00:00Z'),
        row('m1', 'error', '2026-04-03T00:00:00Z'),
        row('m2', 'charged', '2026-05-03T00:00:00Z'),
      ])
    const r = await call(admin, 'GET', `/api/admin/ai/usage?company_id=${owner.companyId}`)
    expect(r.status).toBe(200)
    expect(r.body.items.map((i: any) => [i.model, i.count, i.credits, i.cost_micros])).toEqual([
      ['m1', 2, 4, 200],
      ['m2', 1, 2, 100],
    ])
    expect(r.body.items[0]).toMatchObject({
      company_id: owner.companyId,
      company_name: expect.any(String),
      provider: 'anthropic',
    })
    const april = await call(
      admin,
      'GET',
      `/api/admin/ai/usage?company_id=${owner.companyId}&from=2026-04-01T00:00:00Z&to=2026-05-01T00:00:00Z`,
    )
    expect(april.body.totals).toEqual({
      count: 2,
      input_tokens: 20,
      output_tokens: 10,
      cost_micros: 200,
      billed_micros: 300,
      credits: 4,
    })
    expect((await call(admin, 'GET', '/api/admin/ai/usage?from=ontem')).status).toBe(422)
  })
})
