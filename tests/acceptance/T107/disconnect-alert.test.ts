// AC-T107-01 e AC-T107-03 pela porta HTTP: `GET /api/connections/disconnect-alert` (contrato em
// spec/reports/T107-entrega.md) com `createApp` sobre Postgres temporário e o relógio injetável
// `deps.connectionsAlert.now`. A queda é o estado que o projetor da T47 grava (`connection_state='close'`,
// `disconnected_at`); o caminho real (fake do gateway → worker → SSE) é coberto no E2E.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, expectApiError, type ApiClient } from '../helpers/http'
import { fakeEmail } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const PATH = '/api/connections/disconnect-alert'
const HOUR = 3_600_000
const T0 = new Date('2026-10-17T12:00:00.000Z')
let now = T0
const ago = (ms: number) => new Date(now.getTime() - ms)

let tmp: TempDatabase
let db: Any
let redis: Any
let app: Any
const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows as Any[]

interface Actor {
  c: ApiClient
  userId: string
  companyId: string
}

const randomIp = () => `10.107.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

async function signUp(): Promise<Actor> {
  const ip = randomIp()
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return app.request(path, { ...init, headers })
    },
  })
  const email = fakeEmail('t107')
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const reg = await c.post('/api/auth/register', { name: 'Pessoa T107', email, password, password_confirmation: password })
  expect(reg.status, reg.text).toBeLessThan(300)
  const login = await c.post('/api/auth/login', { email, password })
  expect(login.status, login.text).toBe(200)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  return { c, userId: login.body.user.id, companyId }
}

/** Outro usuário entrando na empresa de `owner` com o papel/lista de permissões dados. */
async function joinAs(owner: Actor, role: 'admin' | 'member', perms: string[] | null): Promise<Actor> {
  const u = await signUp()
  await q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4)`, [
    owner.companyId,
    u.userId,
    role,
    perms,
  ])
  u.c.setCompany(owner.companyId)
  return { ...u, companyId: owner.companyId }
}

async function connection(companyId: string, v: { state?: 'open' | 'close'; disconnectedAt?: Date | null; scheduledAt?: Date | null } = {}) {
  const [row] = await q(
    `INSERT INTO crm.connections (company_id, session_id, name, connection_state, disconnected_at, scheduled_for_deletion_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [companyId, `t107-${randomBytes(5).toString('hex')}`, `Loja ${randomBytes(2).toString('hex')}`, v.state ?? 'close', v.disconnectedAt ?? null, v.scheduledAt ?? null],
  )
  return row.id as string
}

const alertOf = (a: Actor) => a.c.get(PATH)

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  redis.on?.('error', () => {})
  const api: Any = await import('@crm/api')
  app = api.createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    connectionsAlert: { now: () => now },
  })
}, 120_000)

afterAll(async () => {
  await db?.$client.end().catch(() => {})
  redis?.disconnect?.()
  await tmp?.drop()
}, 120_000)

describe('T107 — GET /api/connections/disconnect-alert', () => {
  it('AC-T107-01 empresa sem conexões → 200 { has_recent_disconnected: false, last_disconnected_at: null } (rota não é capturada por /api/connections/:id)', async () => {
    now = T0
    const o = await signUp()
    const r = await alertOf(o)
    expect(r.status, r.text).toBe(200)
    expect(r.body).toEqual({ has_recent_disconnected: false, last_disconnected_at: null })
  })

  it('AC-T107-01 queda nas últimas 24 h → true com a queda mais recente; continua true depois de reconectar', async () => {
    now = T0
    const o = await signUp()
    // nunca caiu / queda antiga (30 h) não contam
    await connection(o.companyId, { state: 'open', disconnectedAt: null })
    await connection(o.companyId, { state: 'open', disconnectedAt: ago(30 * HOUR) })
    expect((await alertOf(o)).body).toEqual({ has_recent_disconnected: false, last_disconnected_at: null })

    await connection(o.companyId, { state: 'close', disconnectedAt: ago(20 * HOUR) })
    // reconectada (o `open` não zera disconnected_at): a queda de 2 h atrás ainda vale e é a mais recente
    await connection(o.companyId, { state: 'open', disconnectedAt: ago(2 * HOUR) })
    const r = await alertOf(o)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ has_recent_disconnected: true, last_disconnected_at: ago(2 * HOUR).toISOString() })
  })

  it('AC-T107-01 janela de 24 h pelo relógio injetado: 24 h − 1 s conta; ao passar das 24 h deixa de contar', async () => {
    now = T0
    const o = await signUp()
    const at = new Date(T0.getTime() - (24 * HOUR - 1000))
    await connection(o.companyId, { state: 'close', disconnectedAt: at })
    expect((await alertOf(o)).body).toEqual({ has_recent_disconnected: true, last_disconnected_at: at.toISOString() })
    now = new Date(T0.getTime() + 1000) // exatamente 24 h depois da queda
    expect((await alertOf(o)).body.has_recent_disconnected).toBe(false)
    now = new Date(T0.getTime() + HOUR)
    expect((await alertOf(o)).body).toEqual({ has_recent_disconnected: false, last_disconnected_at: null })
    now = T0
  })

  it('AC-T107-01 só a empresa ativa: queda de outra empresa não vaza; conexão agendada para exclusão não conta', async () => {
    now = T0
    const a = await signUp()
    const b = await signUp()
    await connection(b.companyId, { state: 'close', disconnectedAt: ago(HOUR) })
    await connection(a.companyId, { state: 'close', disconnectedAt: ago(HOUR), scheduledAt: ago(HOUR / 2) })
    expect((await alertOf(a)).body).toEqual({ has_recent_disconnected: false, last_disconnected_at: null })
    expect((await alertOf(b)).body.has_recent_disconnected).toBe(true)
    // o mesmo usuário com o X-Company-Id da outra empresa (não é membro) não lê o alerta dela
    a.c.setCompany(b.companyId)
    const cross = await alertOf(a)
    expect(cross.status).toBeGreaterThanOrEqual(400)
    expect(cross.body?.has_recent_disconnected).toBeUndefined()
  })

  it('AC-T107-03 owner e admin leem; member sem connections.view → 403; member com a chave → 200', async () => {
    now = T0
    const o = await signUp()
    await connection(o.companyId, { state: 'close', disconnectedAt: ago(HOUR) })
    expect((await alertOf(o)).body.has_recent_disconnected).toBe(true)
    const admin = await joinAs(o, 'admin', null)
    const ra = await alertOf(admin)
    expect(ra.status, ra.text).toBe(200)
    expect(ra.body.has_recent_disconnected).toBe(true)
    expectApiError(await alertOf(await joinAs(o, 'member', null)), 'FORBIDDEN', 403)
    const withKey = await alertOf(await joinAs(o, 'member', ['connections.view']))
    expect(withKey.status, withKey.text).toBe(200)
    expect(withKey.body.has_recent_disconnected).toBe(true)
    // owner com lista explícita sem a chave continua vendo (owner sempre vê)
    await q(`UPDATE crm.company_members SET permission_keys = '{}'::text[] WHERE company_id = $1 AND user_id = $2`, [o.companyId, o.userId])
    expect((await alertOf(o)).status).toBe(200)
  })

  it('AC-T107-03 support → 403: como membro com connections.view e entrando por concessão de acesso', async () => {
    now = T0
    const o = await signUp()
    await connection(o.companyId, { state: 'close', disconnectedAt: ago(HOUR) })
    const asMember = await joinAs(o, 'admin', ['connections.view'])
    await q(`UPDATE crm.users SET system_role = 'support' WHERE id = $1`, [asMember.userId])
    const rm = await alertOf(asMember)
    expect(rm.status, rm.text).toBe(403)
    expect(rm.body?.has_recent_disconnected).toBeUndefined()

    const sup = await signUp()
    await q(`UPDATE crm.users SET system_role = 'support' WHERE id = $1`, [sup.userId])
    await q(`INSERT INTO crm.support_access_grants (company_id, support_user_id, granted_by_user_id, expires_at) VALUES ($1, $2, $3, $4)`, [
      o.companyId,
      sup.userId,
      o.userId,
      new Date(Date.now() + HOUR),
    ])
    sup.c.setCompany(o.companyId)
    const rg = await alertOf(sup)
    expect(rg.status, rg.text).toBe(403)
    expect(rg.body?.has_recent_disconnected).toBeUndefined()
  })
})
