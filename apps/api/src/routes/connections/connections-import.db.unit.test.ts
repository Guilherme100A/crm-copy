// Importar chips do ai-manager (modo extensão, WA_RPC_PROFILE=ai-manager): lista as sessões do gateway sem conexão,
// importa apontando para a MESMA sessão (sem QR, sem criar sessão, sem restart/logout) e desvincula sem tocar no chip.
import { randomBytes } from 'node:crypto'
import { crmConnectionsResolver } from '@crm/core'
import { auditLogs, companyMembers, connections, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
let plain: ReturnType<typeof createApp>
let wa: FakeWaGateway
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `imp-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.41.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ name: 'C', email, password: '12345678', password_confirmation: '12345678' }),
  })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ email, password: '12345678' }),
  })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id, userId: user.id }
}

const call = (s: Session, method: string, path: string, body?: unknown, companyId = s.companyId, target = app) =>
  target.request(path, {
    method,
    headers: { ...H, cookie: s.cookie, 'x-company-id': companyId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (r: Response) => (await r.json()) as Json

/** Métodos do gateway que mexem no chip: nenhum pode ser chamado ao importar/desvincular. */
const LIFECYCLE = ['create', 'startQr', 'requestPairingCode', 'pause', 'resume', 'restart', 'logout', 'remove'] as const
const spies = () => Object.fromEntries(LIFECYCLE.map((m) => [m, vi.spyOn(wa.sessions, m)]))

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  wa = new FakeWaGateway()
  const base = {
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    waGateway: wa,
  }
  app = createApp({ ...base, waProfile: 'ai-manager' })
  plain = createApp({ ...base, waProfile: 'crm' })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

beforeEach(() => vi.restoreAllMocks())

/** Chip criado direto no ai-manager (sem passar pelo CRM). */
const chip = (name: string, state: 'WARMING' | 'STABLE' | 'DISCONNECTED' | 'NEW' = 'STABLE') =>
  wa.addSession({
    name,
    state,
    phone: `+55119${String(Date.now() % 1e8).padStart(8, '0')}${Math.floor(Math.random() * 9)}`,
  })

describe('importar chips do ai-manager', () => {
  it('fora do modo extensão: rota 404 e a lista avisa que não há importação', async () => {
    const s = await signUp()
    expect((await call(s, 'GET', '/api/connections/importable', undefined, s.companyId, plain)).status).toBe(404)
    expect((await call(s, 'POST', '/api/connections/import', { session_ids: ['x'] }, s.companyId, plain)).status).toBe(
      404,
    )
    expect((await json(await call(s, 'GET', '/api/connections', undefined, s.companyId, plain))).features).toEqual({
      import_ai_manager: false,
    })
    expect((await json(await call(s, 'GET', '/api/connections'))).features).toEqual({ import_ai_manager: true })
  })

  it('lista só sessões sem conexão (em qualquer empresa), importa sem QR nem restart e audita', async () => {
    const other = await signUp()
    const taken = await json(await call(other, 'POST', '/api/connections', { name: 'Da outra empresa' }))
    const a = chip('Chip aquecendo', 'WARMING')
    const b = chip('Chip pronto', 'STABLE')
    const s = await signUp()

    const list = (await json(await call(s, 'GET', '/api/connections/importable'))).items as Json[]
    const ids = list.map((i) => i.session_id)
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]))
    expect(ids).not.toContain(taken.connection.session_id)
    expect(list.find((i) => i.session_id === a.id)).toMatchObject({
      name: 'Chip aquecendo',
      phone_number: a.phone,
      session_state: 'WARMING',
      connected: true,
    })

    const spy = spies()
    const res = await call(s, 'POST', '/api/connections/import', { session_ids: [a.id, b.id] })
    expect(res.status).toBe(201)
    const items = (await json(res)).items as Json[]
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      session_id: a.id,
      origin: 'ai-manager',
      name: 'Chip aquecendo',
      phone_number: a.phone,
      status: 'connected',
      badges: ['warming'],
      connection_state: 'open',
    })
    expect(items[1]).toMatchObject({ session_id: b.id, origin: 'ai-manager', status: 'connected', badges: [] })
    for (const m of LIFECYCLE) expect(spy[m], m).not.toHaveBeenCalled()
    expect((await wa.sessions.get(a.id)).status).toBe('WARMING')

    const page = await json(await call(s, 'GET', '/api/connections'))
    expect(page.items.map((i: Json) => i.session_id).sort()).toEqual([a.id, b.id].sort())
    expect(page.status_counts).toMatchObject({ connected: 2 })
    expect(
      (await json(await call(s, 'GET', '/api/connections/importable'))).items.map((i: Json) => i.session_id),
    ).not.toContain(a.id)

    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'connections.import'), eq(auditLogs.companyId, s.companyId)))
    expect(logs).toHaveLength(1)
    expect(logs[0]!.detail).toMatchObject({ session_ids: [a.id, b.id] })
  })

  it('uma sessão só pode ter uma conexão: reimportar (mesma ou outra empresa) → 409; sessão inexistente → 404', async () => {
    const c = chip('Único')
    const s1 = await signUp()
    const s2 = await signUp()
    expect((await call(s1, 'POST', '/api/connections/import', { session_ids: [c.id] })).status).toBe(201)
    for (const s of [s1, s2]) {
      const res = await call(s, 'POST', '/api/connections/import', { session_ids: [c.id] })
      expect(res.status).toBe(409)
      expect((await json(res)).error).toMatchObject({ code: 'CONFLICT', details: { session_ids: [c.id] } })
    }
    expect((await call(s2, 'POST', '/api/connections/import', { session_ids: ['nao-existe'] })).status).toBe(404)
    expect((await call(s2, 'POST', '/api/connections/import', { session_ids: [] })).status).toBe(422)
    // A constraint do banco também segura uma corrida que passasse pela checagem.
    await expect(
      db
        .insert(connections)
        .values({ companyId: s2.companyId, sessionId: c.id, name: 'Duplicada', origin: 'ai-manager' }),
    ).rejects.toMatchObject({ cause: { code: '23505' } })
  })

  it('permissão: importar exige connections.edit (a de criar conexão); limite da empresa vale', async () => {
    const owner = await signUp()
    const member = await signUp()
    await db
      .insert(companyMembers)
      .values({
        companyId: owner.companyId,
        userId: member.userId,
        role: 'member',
        permissionKeys: ['connections.view'],
      })
    const c = chip('Sem permissão')
    expect((await call(member, 'GET', '/api/connections/importable', undefined, owner.companyId)).status).toBe(403)
    expect(
      (await call(member, 'POST', '/api/connections/import', { session_ids: [c.id] }, owner.companyId)).status,
    ).toBe(403)

    await db.execute(
      sql`update crm.companies set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{limits}', '{"connections": 1}'::jsonb) where id = ${owner.companyId}`,
    )
    const res = await call(owner, 'POST', '/api/connections/import', { session_ids: [c.id, chip('Segundo').id] })
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('LIMIT_REACHED')
  })

  it('ações de ciclo de vida do chip ficam no ai-manager (409) e não chamam o gateway; renomear vale só no CRM', async () => {
    const s = await signUp()
    const c = chip('Gerenciado lá', 'WARMING')
    const [conn] = (await json(await call(s, 'POST', '/api/connections/import', { session_ids: [c.id] })))
      .items as Json[]
    const spy = spies()
    for (const [m, p, body] of [
      ['POST', '/connect', undefined],
      ['POST', '/disconnect', undefined],
      ['POST', '/restart', undefined],
      ['POST', '/schedule-deletion', undefined],
      ['POST', '/pairing-code', { phone: '5511999999999' }],
      ['POST', '/proxy', { protocol: 'http', host: 'p.local', port: 8080 }],
      ['DELETE', '/proxy', undefined],
    ] as const) {
      const res = await call(s, m, `/api/connections/${conn!.id}${p}`, body)
      expect(res.status, p).toBe(409)
      expect((await json(res)).error.message).toContain('ai-manager')
    }
    for (const m of LIFECYCLE) expect(spy[m], m).not.toHaveBeenCalled()
    const renamed = (await json(await call(s, 'PATCH', `/api/connections/${conn!.id}`, { name: 'Nome no CRM' })))
      .connection
    expect(renamed).toMatchObject({ name: 'Nome no CRM', session_id: c.id })
    expect((await wa.sessions.get(c.id)).name).toBe('Gerenciado lá')
  })

  it('mensagens e eventos chegam pela mesma sessão; desvincular larga o chip sem chamar o gateway', async () => {
    const s = await signUp()
    const c = chip('Para desvincular', 'STABLE')
    const [conn] = (await json(await call(s, 'POST', '/api/connections/import', { session_ids: [c.id] })))
      .items as Json[]
    const resolve = crmConnectionsResolver(db)
    expect(await resolve(c.id)).toEqual({ companyId: s.companyId, connectionId: conn!.id })

    // Conexão criada pelo CRM não é "desvinculável" (a remoção dela é a exclusão agendada).
    const own = (await json(await call(s, 'POST', '/api/connections', { name: 'Própria' }))).connection
    expect((await call(s, 'POST', `/api/connections/${own.id}/unlink`)).status).toBe(409)

    const spy = spies()
    const res = await call(s, 'POST', `/api/connections/${conn!.id}/unlink`)
    expect(res.status).toBe(200)
    expect((await json(res)).unlinked).toEqual({ id: conn!.id, session_id: c.id })
    for (const m of LIFECYCLE) expect(spy[m], m).not.toHaveBeenCalled()
    expect(await wa.sessions.get(c.id)).toMatchObject({ id: c.id, status: 'STABLE' })

    expect(await resolve(c.id)).toBeNull()
    expect((await json(await call(s, 'GET', '/api/connections'))).items.map((i: Json) => i.id)).not.toContain(conn!.id)
    expect((await call(s, 'GET', `/api/connections/${conn!.id}`)).status).toBe(404)
    const [row] = await db.select().from(connections).where(eq(connections.id, conn!.id))
    expect(row).toMatchObject({ sessionId: `unlinked:${conn!.id}`, unlinkedSessionId: c.id })
    expect(row!.unlinkedAt).toBeInstanceOf(Date)
    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'connections.unlink'), eq(auditLogs.targetId, conn!.id)))
    expect(logs).toHaveLength(1)

    // Volta a aparecer para importar (em qualquer empresa).
    const other = await signUp()
    expect(
      (await json(await call(other, 'GET', '/api/connections/importable'))).items.map((i: Json) => i.session_id),
    ).toContain(c.id)
    expect((await call(other, 'POST', '/api/connections/import', { session_ids: [c.id] })).status).toBe(201)
  })

  it('desativar a empresa não pausa chips importados', async () => {
    const s = await signUp()
    const c = chip('Não pausar', 'STABLE')
    await call(s, 'POST', '/api/connections/import', { session_ids: [c.id] })
    const res = await call(s, 'DELETE', `/api/companies/${s.companyId}`)
    expect(res.status).toBe(200)
    expect((await json(res)).paused_session_ids).not.toContain(c.id)
    expect((await wa.sessions.get(c.id)).status).toBe('STABLE')
  })
})
