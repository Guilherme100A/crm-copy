/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Admin interno pela API (T95): guard platform_admin (AC-T95-01), usuários e auditoria (AC-T95-02), limites da
// empresa (AC-T95-03), cota de disparos (AC-T95-04), estatísticas e o guard de empresa desativada.
import { randomBytes } from 'node:crypto'
import { auditLogs, chats, companies, connections, contacts, createDb, messages, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'
import { isPlatformAdminExempt } from '../companies/guard'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const clock = { t: new Date('2026-10-31T12:00:00Z') }
const published: { companyId: string; type: string; data: any }[] = []
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const rnd = () => randomBytes(4).toString('hex')

interface Session {
  cookie: string
  companyId: string
  userId: string
  email: string
}

async function login(email: string, password: string): Promise<string> {
  const ip = { 'x-forwarded-for': `10.95.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ email, password }),
  })
  return /crm_session=[^;]+/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? ''
}
async function signUp(): Promise<Session> {
  const email = `t95-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.95.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }),
  })
  const { user } = (await reg.json()) as any
  return { cookie: await login(email, '12345678'), companyId: user.last_company_id, userId: user.id, email }
}
async function platformAdmin(): Promise<Session> {
  const s = await signUp()
  await db.update(users).set({ systemRole: 'platform_admin' }).where(eq(users.id, s.userId))
  return s
}
const call = async (s: Session | null, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { ...H, ...(s ? { cookie: s.cookie, 'x-company-id': s.companyId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as any }
}
const adminLogs = (targetId: string) => db.select().from(auditLogs).where(eq(auditLogs.targetId, targetId))

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
    waGateway: new FakeWaGateway(),
    credentialsCipher: createCipher({ key: generateCredentialsKey() }),
    admin: { now: () => clock.t },
    realtimePublisher: {
      publish: async (companyId: string, type: string, data: unknown) => void published.push({ companyId, type, data }),
    } as never,
  })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('AC-T95-01 guard platform_admin', () => {
  it('sem sessão → 401; usuário comum e owner de empresa → 403 em todo /api/admin/* (inclusive rota inexistente); support → 403', async () => {
    const owner = await signUp()
    expect((await call(null, 'GET', '/api/admin/users')).status).toBe(401)
    for (const [m, p] of [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users'],
      ['GET', `/api/admin/users/${owner.userId}`],
      ['PUT', `/api/admin/users/${owner.userId}`],
      ['GET', `/api/admin/users/${owner.userId}/companies`],
      ['GET', '/api/admin/companies'],
      ['PATCH', `/api/admin/companies/${owner.companyId}`],
      ['GET', '/api/admin/mass-dispatch-settings'],
      ['PATCH', '/api/admin/mass-dispatch-settings'],
      ['PATCH', `/api/admin/companies/${owner.companyId}/mass-dispatch-quota`],
      ['GET', '/api/admin/statistics'],
      ['GET', '/api/admin/audit-logs'],
      ['GET', '/api/admin/nao-existe'],
    ] as const) {
      const r = await call(owner, m, p, m === 'GET' ? undefined : {})
      expect(r.status, `${m} ${p}`).toBe(403)
      expect(r.body.error.code).toBe('FORBIDDEN')
    }
    await db.update(users).set({ systemRole: 'support' }).where(eq(users.id, owner.userId))
    expect((await call(owner, 'GET', '/api/admin/companies')).status).toBe(403)
    const admin = await platformAdmin()
    expect((await call(admin, 'GET', '/api/admin/users')).status).toBe(200)
    expect((await call(admin, 'GET', '/api/admin/nao-existe')).status).toBe(404)
  })

  it('empresa ativa do admin desativada não bloqueia /api/admin e /api/platform (só para platform_admin)', async () => {
    const admin = await platformAdmin()
    await db.update(companies).set({ active: false }).where(eq(companies.id, admin.companyId))
    expect((await call(admin, 'GET', '/api/admin/companies')).status).toBe(200)
    expect((await call(admin, 'GET', '/api/platform/ai/prices')).status).toBe(200)
    const r = await call(admin, 'GET', '/api/contacts')
    expect(r.status).toBe(403)
    expect(r.body.error.details.error_code).toBe('company_inactive')
    expect(isPlatformAdminExempt('platform_admin', '/api/admin')).toBe(true)
    expect(isPlatformAdminExempt('platform_admin', '/api/administrator')).toBe(false)
    expect(isPlatformAdminExempt('user', '/api/admin/users')).toBe(false)
    expect(isPlatformAdminExempt('support', '/api/platform/ai/prices')).toBe(false)
  })
})

describe('AC-T95-02 usuários e admin_audit_log', () => {
  it('cria (fio {user:{…}}, papel support), lista com busca e paginação de 20, detalha e lista empresas', async () => {
    const admin = await platformAdmin()
    const email = `sup-${rnd()}@x.com`
    const created = await call(admin, 'POST', '/api/admin/users', {
      user: {
        name: 'Suporte',
        email,
        role: 'support',
        personal_whatsapp: '+55 11 98888-7777',
        password: 'abc123',
        password_confirmation: 'abc123',
      },
    })
    expect(created.status).toBe(201)
    expect(created.body.user).toMatchObject({
      email,
      system_role: 'support',
      role: 'support',
      role_label: 'Suporte',
      personal_whatsapp: '5511988887777',
      companies_count: 0,
    })
    expect(created.body.user.password_hash).toBeUndefined()
    expect(JSON.stringify(created.body)).not.toContain('abc123')
    // O support entra pelo login normal.
    expect(await login(email, 'abc123')).not.toBe('')

    expect(
      (
        await call(admin, 'POST', '/api/admin/users', {
          name: 'X',
          email: email.toUpperCase(),
          password: 'abc123',
          password_confirmation: 'abc123',
        })
      ).status,
    ).toBe(409)
    const bad = await call(admin, 'POST', '/api/admin/users', {
      name: '',
      email: 'sem-arroba',
      password: '123',
      password_confirmation: '1234',
      role: 'chefe',
    })
    expect(bad.status).toBe(422)
    expect(bad.body.error.details.fields.map((f: any) => f.path).sort()).toEqual(
      expect.arrayContaining(['email', 'name', 'password', 'role']),
    )
    const mismatch = await call(admin, 'POST', '/api/admin/users', {
      name: 'X',
      email: `m-${rnd()}@x.com`,
      password: 'abcdef',
      password_confirmation: 'abcdeg',
    })
    expect(mismatch.body.error.details.fields).toEqual([{ path: 'password_confirmation', message: expect.any(String) }])

    const list = await call(admin, 'GET', `/api/admin/users?search=${encodeURIComponent(email.slice(0, 10))}`)
    expect(list.status).toBe(200)
    expect(list.body.items.map((u: any) => u.email)).toEqual([email])
    expect(list.body.page).toMatchObject({ page: 1, limit: 20, total_count: 1 })
    const byName = await call(admin, 'GET', '/api/admin/users?search=Suporte')
    expect(byName.body.items.some((u: any) => u.email === email)).toBe(true)

    const owner = await signUp()
    const detail = await call(admin, 'GET', `/api/admin/users/${owner.userId}`)
    expect(detail.body.user).toMatchObject({ role: 'client', system_role: 'user', companies_count: 1 })
    const comps = await call(admin, 'GET', `/api/admin/users/${owner.userId}/companies`)
    expect(comps.body.items).toEqual([
      {
        account_id: owner.companyId,
        account_name: expect.any(String),
        role: 'owner',
        role_label: 'Proprietário',
        active: true,
      },
    ])
    expect((await call(admin, 'GET', `/api/admin/users/${created.body.user.id}/companies`)).body.items).toEqual([])
    expect((await call(admin, 'GET', '/api/admin/users/00000000-0000-0000-0000-000000000000')).status).toBe(404)
    expect((await call(admin, 'GET', '/api/admin/users/nao-uuid')).status).toBe(404)

    const [log] = await adminLogs(created.body.user.id)
    expect(log).toMatchObject({
      action: 'admin.user.create',
      targetType: 'user',
      companyId: null,
      actorUserId: admin.userId,
    })
    expect(log!.detail).toMatchObject({ admin: true, email, system_role: 'support' })
  })

  it('PUT ignora o e-mail, só troca a senha quando informada (≥ 6) e revoga as sessões; cada PUT grava auditoria sem senha', async () => {
    const admin = await platformAdmin()
    const target = await signUp()
    const r1 = await call(admin, 'PUT', `/api/admin/users/${target.userId}`, {
      user: { name: 'Renomeado', email: 'outro@x.com', password: '', password_confirmation: '' },
    })
    expect(r1.status).toBe(200)
    expect(r1.body.user).toMatchObject({ name: 'Renomeado', email: target.email })
    expect(r1.body.password_changed).toBe(false)
    expect((await call(target, 'GET', '/api/auth/profile')).status).toBe(200)

    const short = await call(admin, 'PUT', `/api/admin/users/${target.userId}`, {
      password: '12345',
      password_confirmation: '12345',
    })
    expect(short.status).toBe(422)
    expect(short.body.error.details.fields[0].path).toBe('password')
    expect(
      (
        await call(admin, 'PUT', `/api/admin/users/${target.userId}`, {
          password: '123456',
          password_confirmation: '654321',
        })
      ).status,
    ).toBe(422)

    const r2 = await call(admin, 'PUT', `/api/admin/users/${target.userId}`, {
      password: 'novaSenha',
      password_confirmation: 'novaSenha',
      role: 'admin',
    })
    expect(r2.status).toBe(200)
    expect(r2.body).toMatchObject({ password_changed: true, user: { system_role: 'platform_admin', role: 'admin' } })
    expect((await call(target, 'GET', '/api/auth/profile')).status).toBe(401)
    expect(await login(target.email, '12345678')).toBe('')
    expect(await login(target.email, 'novaSenha')).not.toBe('')

    const logs = (await adminLogs(target.userId)).filter((l) => l.action === 'admin.user.update')
    expect(logs).toHaveLength(2)
    expect(logs.map((l) => l.companyId)).toEqual([null, null])
    const changed = logs.find((l) => (l.detail as any).password_changed)!
    expect(changed.detail).toMatchObject({ admin: true, fields: expect.arrayContaining(['password', 'system_role']) })
    expect(JSON.stringify(logs)).not.toContain('novaSenha')
    expect(logs.find((l) => !(l.detail as any).password_changed)!.detail).toMatchObject({
      email_ignored: true,
      fields: ['name'],
    })
    // Nada duplicado na empresa ativa do admin.
    const own = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, admin.companyId), eq(auditLogs.actorUserId, admin.userId)))
    expect(own.filter((l) => l.action.includes('admin'))).toEqual([])
  })

  it('o admin não remove o próprio platform_admin (409 self_demotion)', async () => {
    const admin = await platformAdmin()
    const r = await call(admin, 'PUT', `/api/admin/users/${admin.userId}`, { system_role: 'user' })
    expect(r.status).toBe(409)
    expect(r.body.error.details.error_code).toBe('self_demotion')
    expect((await call(admin, 'PUT', `/api/admin/users/${admin.userId}`, { name: 'Eu' })).status).toBe(200)
  })
})

describe('AC-T95-03 limites da empresa', () => {
  it('padrão ilimitado; valida inteiros ≥ 0 (422); limite de conexões abaixo do atual impede novas sem desconectar; remover volta a ilimitado', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    const before = await call(admin, 'GET', `/api/admin/companies/${owner.companyId}`)
    expect(before.body.company.limits).toEqual({
      connections: null,
      ai_agents: null,
      members: null,
      flows: null,
      webhooks: null,
    })
    expect(before.body.company).toMatchObject({
      owner_email: owner.email,
      users_count: 1,
      inbox_limits: null,
      active: true,
    })

    for (const body of [
      { limits: { connections: -1 } },
      { limits: { connections: 1.5 } },
      { limits: { connections: '2' } },
      { limits: { foo: 1 } },
      { inbox_limits: { waiting: 1 } },
      {},
    ]) {
      const r = await call(admin, 'PATCH', `/api/admin/companies/${owner.companyId}`, body)
      expect(r.status, JSON.stringify(body)).toBe(422)
    }

    for (let i = 0; i < 2; i++)
      expect((await call(owner, 'POST', '/api/connections', { name: `Loja ${i}` })).status).toBe(201)
    const set = await call(admin, 'PATCH', `/api/admin/companies/${owner.companyId}`, {
      limits: { connections: 1, members: 1, flows: 0, webhooks: 0, ai_agents: 0 },
      inbox_limits: { waiting: 10, attending: 5, resolved: 100 },
    })
    expect(set.status).toBe(200)
    expect(set.body.company.limits).toEqual({ connections: 1, ai_agents: 0, members: 1, flows: 0, webhooks: 0 })
    expect(set.body.company.inbox_limits).toEqual({ waiting: 10, attending: 5, resolved: 100 })
    expect(set.body.company.usage).toMatchObject({ connections: 2, members: 1 })

    const blocked = await call(owner, 'POST', '/api/connections', { name: 'Terceira' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe('LIMIT_REACHED')
    expect(
      await db
        .select()
        .from(connections)
        .where(and(eq(connections.companyId, owner.companyId), isNull(connections.scheduledForDeletionAt))),
    ).toHaveLength(2)
    const inv = await call(owner, 'POST', '/api/team/invitations', { email: `m-${rnd()}@x.com`, role: 'member' })
    expect(inv.status).toBe(409)
    expect(inv.body.error).toMatchObject({ code: 'LIMIT_REACHED', details: { limit: 1, used: 1 } })
    const flow = await call(owner, 'POST', '/api/flows', { name: 'F' })
    expect(flow.body.error).toMatchObject({ code: 'LIMIT_REACHED', details: { limit: 0, used: 0 } })
    const hook = await call(owner, 'POST', '/api/inbound-webhooks', { name: 'W' })
    expect(hook.status).toBe(409)
    expect(hook.body.error.code).toBe('LIMIT_REACHED')

    const cleared = await call(admin, 'PATCH', `/api/admin/companies/${owner.companyId}`, {
      limits: { connections: null, members: null, flows: null, webhooks: null, ai_agents: null },
      inbox_limits: null,
    })
    expect(cleared.body.company.limits).toEqual({
      connections: null,
      ai_agents: null,
      members: null,
      flows: null,
      webhooks: null,
    })
    expect(cleared.body.company.inbox_limits).toBeNull()
    expect((await call(owner, 'POST', '/api/connections', { name: 'Terceira' })).status).toBe(201)
    expect((await call(owner, 'POST', '/api/flows', { name: 'F' })).status).toBe(201)

    const logs = (await adminLogs(owner.companyId)).filter((l) => l.action === 'admin.company.update')
    expect(logs).toHaveLength(2)
    expect(logs.every((l) => l.companyId === owner.companyId && (l.detail as any).admin === true)).toBe(true)
    const q = await call(admin, 'GET', `/api/admin/audit-logs?company_id=${owner.companyId}&action=admin.company`)
    expect(q.body.items).toHaveLength(2)
    expect(q.body.items[0]).toMatchObject({
      action: 'admin.company.update',
      target_type: 'company',
      target_id: owner.companyId,
      actor_user_id: admin.userId,
    })
  })

  it('desativar/reativar: bloqueia os membros (company_inactive), publica company.updated e audita na empresa alvo', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    published.length = 0
    const off = await call(admin, 'PATCH', `/api/admin/companies/${owner.companyId}`, { active: false })
    expect(off.status).toBe(200)
    expect(off.body.company).toMatchObject({ active: false, deactivated_at: expect.any(String) })
    expect(published).toEqual([
      { companyId: owner.companyId, type: 'company.updated', data: expect.objectContaining({ fields: ['active'] }) },
    ])
    expect((await call(owner, 'GET', '/api/contacts')).body.error.details.error_code).toBe('company_inactive')
    const on = await call(admin, 'PATCH', `/api/admin/companies/${owner.companyId}`, { active: true })
    expect(on.body.company).toMatchObject({ active: true, deactivated_at: null })
    expect((await call(owner, 'GET', '/api/contacts')).status).toBe(200)
    expect(
      (await call(admin, 'PATCH', '/api/admin/companies/00000000-0000-0000-0000-000000000000', { active: true }))
        .status,
    ).toBe(404)
  })

  it('lista empresas com busca por nome/e-mail do dono, owner e usuários, paginada', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    const r = await call(admin, 'GET', `/api/admin/companies?search=${encodeURIComponent(owner.email)}`)
    expect(r.status).toBe(200)
    expect(r.body.items).toHaveLength(1)
    expect(r.body.items[0]).toMatchObject({
      id: owner.companyId,
      owner: { id: owner.userId, email: owner.email },
      owner_email: owner.email,
      users_count: 1,
      mass_dispatch_quota: { period: expect.any(String) },
    })
    expect(r.body.page).toMatchObject({ page: 1, limit: 20, total_count: 1, has_more: false })
    const page = await call(admin, 'GET', '/api/admin/companies?limit=1&page=2')
    expect(page.body.items).toHaveLength(1)
    expect(page.body.page.has_more).toBe(true)
  })
})

describe('AC-T95-04 cota de disparos', () => {
  it('bônus soma no período atual sem mudar o limite global; per_connection_limit recalcula a base; 404 e 422', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    expect((await call(owner, 'POST', '/api/connections', { name: 'Loja' })).status).toBe(201)
    expect((await call(admin, 'GET', '/api/admin/mass-dispatch-settings')).body.settings).toEqual({
      per_connection_limit: 500,
      per_instance_limit: 500,
    })
    const q0 = await call(admin, 'GET', `/api/admin/companies/${owner.companyId}/mass-dispatch-quota`)
    expect(q0.body.quota).toMatchObject({
      limit: 500,
      bonus: 0,
      billable_slots: 1,
      per_instance_limit: 500,
      period: '2026-10',
    })

    const b = await call(admin, 'PATCH', `/api/admin/companies/${owner.companyId}/mass-dispatch-quota`, {
      bonus_delta: 250,
    })
    expect(b.status).toBe(200)
    expect(b.body.quota).toMatchObject({ limit: 750, bonus: 250, remaining: 750, period: '2026-10' })
    expect((await call(admin, 'GET', '/api/admin/mass-dispatch-settings')).body.settings.per_connection_limit).toBe(500)
    // O cliente vê a mesma cota.
    expect((await call(owner, 'GET', '/api/mass-dispatches/quota')).body.quota).toMatchObject({ bonus: 250 })

    const s = await call(admin, 'PATCH', '/api/admin/mass-dispatch-settings', { per_connection_limit: 300 })
    expect(s.body.settings).toEqual({ per_connection_limit: 300, per_instance_limit: 300 })
    expect(
      (await call(admin, 'GET', `/api/admin/companies/${owner.companyId}/mass-dispatch-quota`)).body.quota,
    ).toMatchObject({ limit: 550, per_instance_limit: 300, bonus: 250 })

    clock.t = new Date('2026-11-01T12:00:00Z')
    expect(
      (await call(admin, 'GET', `/api/admin/companies/${owner.companyId}/mass-dispatch-quota`)).body.quota,
    ).toMatchObject({ limit: 300, bonus: 0, period: '2026-11' })
    clock.t = new Date('2026-10-31T12:00:00Z')

    for (const body of [{ bonus_delta: 0 }, { bonus_delta: 1.5 }, { bonus_delta: '10' }, {}])
      expect(
        (await call(admin, 'PATCH', `/api/admin/companies/${owner.companyId}/mass-dispatch-quota`, body)).status,
      ).toBe(422)
    expect((await call(admin, 'PATCH', '/api/admin/mass-dispatch-settings', { per_connection_limit: -1 })).status).toBe(
      422,
    )
    expect(
      (
        await call(admin, 'PATCH', '/api/admin/companies/00000000-0000-0000-0000-000000000000/mass-dispatch-quota', {
          bonus_delta: 5,
        })
      ).status,
    ).toBe(404)
    expect((await call(admin, 'GET', '/api/admin/companies/nao-uuid/mass-dispatch-quota')).status).toBe(404)

    const bonusLog = (await adminLogs(owner.companyId)).find((l) => l.action === 'admin.mass_dispatch_quota.bonus')
    expect(bonusLog).toMatchObject({
      companyId: owner.companyId,
      detail: expect.objectContaining({ admin: true, bonus_delta: 250, period: '2026-10' }),
    })
    const [settingsLog] = await adminLogs('global')
    expect(settingsLog).toMatchObject({
      action: 'admin.mass_dispatch_settings.update',
      companyId: null,
      detail: expect.objectContaining({ from: 500, to: 300 }),
    })
    await call(admin, 'PATCH', '/api/admin/mass-dispatch-settings', { per_connection_limit: 500 })
  })
})

describe('estatísticas', () => {
  it('novas empresas/usuários no período, conexões conectadas e mensagens por dia no fuso, sem dinheiro', async () => {
    const admin = await platformAdmin()
    const owner = await signUp()
    const [conn] = await db
      .insert(connections)
      .values({ companyId: owner.companyId, name: 'aberta', sessionId: `s-${rnd()}`, connectionState: 'open' })
      .returning()
    const [contact] = await db.insert(contacts).values({ companyId: owner.companyId, name: 'C' }).returning()
    const [chat] = await db
      .insert(chats)
      .values({ companyId: owner.companyId, connectionId: conn!.id, contactId: contact!.id })
      .returning()
    const msg = (direction: 'inbound' | 'outbound', at: string) => ({
      companyId: owner.companyId,
      chatId: chat!.id,
      direction,
      senderType: direction === 'inbound' ? ('contact' as const) : ('user' as const),
      type: 'text',
      status: 'sent' as const,
      createdAt: new Date(at),
    })
    // 02:30Z do dia 10 ainda é dia 09 em São Paulo.
    await db
      .insert(messages)
      .values([
        msg('inbound', '2026-03-10T02:30:00Z'),
        msg('outbound', '2026-03-10T15:00:00Z'),
        msg('outbound', '2026-03-10T16:00:00Z'),
      ])

    const r = await call(admin, 'GET', '/api/admin/statistics?start_date=2026-03-08&end_date=2026-03-10')
    expect(r.status).toBe(200)
    const st = r.body.statistics
    expect(st).toMatchObject({
      start_date: '2026-03-08',
      end_date: '2026-03-10',
      time_zone: 'America/Sao_Paulo',
      messages: { total: 3, inbound: 1, outbound: 2 },
    })
    expect(st.messages_per_day).toEqual([
      { date: '2026-03-08', total: 0, inbound: 0, outbound: 0 },
      { date: '2026-03-09', total: 1, inbound: 1, outbound: 0 },
      { date: '2026-03-10', total: 2, inbound: 0, outbound: 2 },
    ])
    expect(st.totals.connected_connections).toBeGreaterThanOrEqual(1)
    expect(st.totals.connections).toBeGreaterThanOrEqual(st.totals.connected_connections)
    expect(JSON.stringify(st)).not.toMatch(/revenue|amount|cents|official/i)

    const today = await call(admin, 'GET', '/api/admin/statistics?start_date=2026-01-01&end_date=2026-12-31')
    expect(today.body.statistics.new_companies).toBeGreaterThanOrEqual(2)
    expect(today.body.statistics.new_users).toBeGreaterThanOrEqual(2)
    const def = await call(admin, 'GET', '/api/admin/statistics')
    expect(def.body.statistics).toMatchObject({ start_date: '2026-10-25', end_date: '2026-10-31' })
    expect(def.body.statistics.messages_per_day).toHaveLength(7)
    expect((await call(admin, 'GET', '/api/admin/statistics?start_date=2026-10-10&end_date=2026-10-01')).status).toBe(
      422,
    )
    expect((await call(admin, 'GET', '/api/admin/statistics?start_date=10-10-2026')).status).toBe(422)
  })
})
