// Postgres real (SPEC 3.10): limites de membros, fluxos e webhooks aplicados nos módulos (T95, aditivo) e o
// AdminService (empresa ativa/limites, cota de disparos com relógio injetável, usuários).
import { randomBytes } from 'node:crypto'
import {
  companies,
  companyMembers,
  connections,
  createDb,
  flows,
  massDispatchQuotaBonuses,
  users,
  type Database,
} from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, verifyPassword } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FlowStore } from '../flows/store/store'
import { FlowStoreError } from '../flows/store/errors'
import { InboundWebhooksError, InboundWebhooksService } from '../inbound-webhooks/service'
import { InvitationService } from '../invitations/service'
import { SessionService } from '../platform/session-service'
import { TeamError } from '../team/errors'
import { AdminError } from './errors'
import { AdminService } from './service'

let temp: TempDatabase
let db: Database
const rnd = () => randomBytes(3).toString('hex')

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

async function user(name = 'U'): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${name.toLowerCase()}-${rnd()}@x.test`, name, passwordHash: 'x' })
    .returning({ id: users.id })
  return u!.id
}
async function company(settings: Record<string, unknown> = {}): Promise<{ id: string; ownerId: string }> {
  const ownerId = await user('Owner')
  const [c] = await db
    .insert(companies)
    .values({ name: `C ${rnd()}`, slug: `c-${rnd()}`, settings })
    .returning({ id: companies.id })
  await db.insert(companyMembers).values({ companyId: c!.id, userId: ownerId, role: 'owner' })
  return { id: c!.id, ownerId }
}
const setLimits = (companyId: string, limits: Record<string, number>) =>
  db.update(companies).set({ settings: { limits } }).where(eq(companies.id, companyId))

async function rejects<E extends Error>(p: Promise<unknown>, cls: new (...a: never[]) => E): Promise<E> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(cls)
    return err as E
  }
  throw new Error('esperava erro')
}

describe('limite de membros (convites)', () => {
  const svc = () =>
    new InvitationService({ db, mailer: new MemoryMailer(), sessions: new SessionService({ db }), resendCooldownMs: 0 })
  const invite = (s: InvitationService, c: { id: string; ownerId: string }) =>
    s.create({ userId: c.ownerId, name: 'Owner' }, c.id, { kind: 'member', email: `m-${rnd()}@x.test`, role: 'member' })
  const tokenOf = (link: string) => decodeURIComponent(link.split('/invitations/')[1]!)

  it('sem limite nada muda: convida e aceita à vontade', async () => {
    const c = await company()
    const s = svc()
    for (let i = 0; i < 3; i++)
      await s.accept(tokenOf((await invite(s, c)).link), { signup: { name: 'N', password: '12345678' } })
    const rows = await db.select().from(companyMembers).where(eq(companyMembers.companyId, c.id))
    expect(rows).toHaveLength(4)
  })

  it('limite atingido: convite novo → limit_reached {limit, used}; aceite pendente também é barrado (sem criar a conta)', async () => {
    const c = await company()
    const s = svc()
    const pending = await invite(s, c)
    await setLimits(c.id, { members: 1 })
    const e1 = await rejects(invite(s, c), TeamError)
    expect(e1.kind).toBe('limit_reached')
    expect(e1.details).toEqual({ limit: 1, used: 1 })
    const e2 = await rejects(
      s.accept(tokenOf(pending.link), { signup: { name: 'N', password: '12345678' } }),
      TeamError,
    )
    expect(e2.kind).toBe('limit_reached')
    expect(await db.select().from(users).where(eq(users.email, pending.invitation.email))).toHaveLength(0)
    // Usuário já logado: barrado dentro da transação do aceite.
    const existing = await user('Logged')
    const [u] = await db.select().from(users).where(eq(users.id, existing))
    const inv2 = await (async () => {
      await setLimits(c.id, { members: 2 })
      const r = await s.create({ userId: c.ownerId, name: 'Owner' }, c.id, {
        kind: 'member',
        email: u!.email,
        role: 'member',
      })
      await setLimits(c.id, { members: 1 })
      return r
    })()
    const e3 = await rejects(
      s.accept(tokenOf(inv2.link), { user: { id: u!.id, email: u!.email, name: u!.name } }),
      TeamError,
    )
    expect(e3.kind).toBe('limit_reached')
    // Remover o limite volta a ilimitado.
    await db.update(companies).set({ settings: {} }).where(eq(companies.id, c.id))
    await s.accept(tokenOf(inv2.link), { user: { id: u!.id, email: u!.email, name: u!.name } })
  })
})

describe('limite de fluxos', () => {
  it('sem limite cria; com limite atingido → LIMIT_REACHED {limit, used}; o que já existe fica', async () => {
    const c = await company()
    const store = new FlowStore(db)
    await store.createFlow({ companyId: c.id })
    await store.createFlow({ companyId: c.id })
    await setLimits(c.id, { flows: 1 })
    const err = await rejects(store.createFlow({ companyId: c.id }), FlowStoreError)
    expect(err.code).toBe('LIMIT_REACHED')
    expect(err.details).toEqual({ limit: 1, used: 2 })
    expect(await db.select().from(flows).where(eq(flows.companyId, c.id))).toHaveLength(2)
    await setLimits(c.id, { flows: 3 })
    await store.createFlow({ companyId: c.id })
  })
})

describe('limite de webhooks', () => {
  const env = { API_PUBLIC_URL: 'http://api.test' }
  it('sem limite vale o teto atual (maxPerCompany); com limite da empresa, ele substitui o teto', async () => {
    const c = await company()
    const svc = new InboundWebhooksService({ db, env, maxPerCompany: 2 })
    await svc.create(c.id, { name: 'a' })
    await svc.create(c.id, { name: 'b' })
    const capped = await rejects(svc.create(c.id, { name: 'c' }), InboundWebhooksError)
    expect(capped.code).toBe('limit')
    expect(capped.details).toEqual({ limit: 2 })
    await setLimits(c.id, { webhooks: 3 })
    await svc.create(c.id, { name: 'c' })
    const err = await rejects(svc.create(c.id, { name: 'd' }), InboundWebhooksError)
    expect(err.code).toBe('limit')
    expect(err.details).toEqual({ limit: 3, used: 3 })
    await setLimits(c.id, { webhooks: 0 })
    await rejects(svc.create(c.id, { name: 'e' }), InboundWebhooksError)
  })
})

describe('AdminService', () => {
  it('desativar pausa as sessões (gateway fake) e reativar limpa deactivated_at; limites mesclados e removidos', async () => {
    const c = await company({ description: 'mantém' })
    const paused: string[] = []
    const gw = { sessions: { pause: async (id: string) => void paused.push(id) } } as never
    const published: unknown[] = []
    const svc = new AdminService({
      db,
      waGateway: gw,
      sessionsSources: [() => ['s-1', 's-2']],
      publisher: { publish: async (...a: unknown[]) => void published.push(a) } as never,
    })
    const off = await svc.updateCompany(c.id, { active: false, limits: { connections: 1, members: 5 } })
    expect(off.company.active).toBe(false)
    expect(off.company.deactivated_at).not.toBeNull()
    expect(off.paused_session_ids).toEqual(['s-1', 's-2'])
    expect(paused).toEqual(['s-1', 's-2'])
    expect(off.company.limits).toEqual({ connections: 1, ai_agents: null, members: 5, flows: null, webhooks: null })
    expect(published).toHaveLength(1)
    const [row] = await db.select().from(companies).where(eq(companies.id, c.id))
    expect(row!.settings).toEqual({ description: 'mantém', limits: { connections: 1, members: 5 } })

    const on = await svc.updateCompany(c.id, { active: true, limits: { connections: null, members: null } })
    expect(on.company.active).toBe(true)
    expect(on.company.deactivated_at).toBeNull()
    expect(on.paused_session_ids).toEqual([])
    expect(on.company.limits.connections).toBeNull()
    const [row2] = await db.select().from(companies).where(eq(companies.id, c.id))
    expect(row2!.settings).toEqual({ description: 'mantém' })
  })

  it('bônus soma no período atual (relógio injetável) sem mudar o global; per_connection_limit recalcula a base', async () => {
    const c = await company()
    await db.insert(connections).values({ companyId: c.id, name: 'n1', sessionId: `s-${rnd()}` } as never)
    const clock = { t: new Date('2026-10-31T12:00:00Z') }
    const svc = new AdminService({ db, now: () => clock.t })
    await svc.setMassDispatchSettings(500)
    expect((await svc.companyQuota(c.id)).limit).toBe(500)
    const q1 = await svc.addQuotaBonus(c.id, 100)
    expect(q1).toMatchObject({ limit: 600, bonus: 100, period: '2026-10', per_instance_limit: 500 })
    expect((await svc.addQuotaBonus(c.id, -30)).bonus).toBe(70)
    expect((await svc.massDispatchSettings()).per_connection_limit).toBe(500)
    await svc.setMassDispatchSettings(200)
    expect((await svc.companyQuota(c.id)).limit).toBe(270)
    // Virada de mês: bônus não passa para o período seguinte.
    clock.t = new Date('2026-11-01T12:00:00Z')
    expect(await svc.companyQuota(c.id)).toMatchObject({ limit: 200, bonus: 0, period: '2026-11' })
    const bonuses = await db.select().from(massDispatchQuotaBonuses).where(eq(massDispatchQuotaBonuses.companyId, c.id))
    expect(bonuses.map((b) => [b.period, b.bonus])).toEqual([['2026-10', 70]])
    await rejects(svc.addQuotaBonus(c.id, 0), AdminError)
    await svc.setMassDispatchSettings(500)
  })

  it('usuários: cria com senha hash, edita sem tocar no e-mail, troca senha e revoga sessões; self_demotion barrado', async () => {
    const sessions = new SessionService({ db })
    const svc = new AdminService({ db, sessions })
    const created = await svc.createUser({
      name: ' Suporte ',
      email: `Sup-${rnd()}@X.test`,
      password: '123456',
      role: 'support',
      personal_whatsapp: '+55 (11) 9999-0000',
    })
    expect(created).toMatchObject({
      name: 'Suporte',
      system_role: 'support',
      role: 'support',
      personal_whatsapp: '551199990000',
      companies_count: 0,
    })
    expect(created.email).toBe(created.email.toLowerCase())
    const conflict = await rejects(
      svc.createUser({ name: 'X', email: created.email.toUpperCase(), password: '123456' }),
      AdminError,
    )
    expect(conflict.code).toBe('conflict')

    const s = await sessions.create(created.id, {})
    const same = await svc.updateUser({ userId: 'admin' }, created.id, { name: 'Novo nome' })
    expect(same.password_changed).toBe(false)
    expect(await sessions.verify(s.token)).not.toBeNull()
    const changed = await svc.updateUser({ userId: 'admin' }, created.id, { password: 'abcdef' })
    expect(changed.password_changed).toBe(true)
    const [row] = await db.select().from(users).where(eq(users.id, created.id))
    expect(await verifyPassword(row!.passwordHash, 'abcdef')).toBe(true)
    expect(await sessions.verify(s.token)).toBeNull()
    await rejects(svc.updateUser({ userId: 'admin' }, created.id, { password: '123' }), AdminError)

    const err = await rejects(svc.updateUser({ userId: created.id }, created.id, { system_role: 'user' }), AdminError)
    expect(err.details).toMatchObject({ error_code: 'self_demotion' })
  })
})
