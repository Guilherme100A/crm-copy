// Postgres real (SPEC 3.10): transferência atômica, convites (hash, limite de reenvio, aceite) e desativação.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companyMembers, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq } from 'drizzle-orm'
import { CompanyService } from '../companies/service'
import { InvitationService } from '../invitations/service'
import { SessionService } from '../platform/session-service'
import { TeamError } from './errors'
import { TeamService } from './service'

let tmp: TempDatabase
let db: Database
let seq = 0

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 8 })
})
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

async function user(name = 'U') {
  seq += 1
  const [u] = await db.insert(users).values({ email: `u${seq}-${Date.now()}@ex.test`, passwordHash: 'x', name: `${name}${seq}` }).returning()
  return u!
}

async function company(ownerId: string) {
  const svc = new CompanyService({ db })
  return svc.create({ userId: ownerId, systemRole: 'user' }, { name: `Empresa ${++seq}` })
}

const add = (companyId: string, userId: string, role: 'admin' | 'member') => db.insert(companyMembers).values({ companyId, userId, role })
const owners = async (companyId: string) =>
  (await db.select().from(companyMembers).where(eq(companyMembers.companyId, companyId))).filter((m) => m.role === 'owner')

const rejectsWith = async (p: Promise<unknown>, kind: TeamError['kind'], errorCode?: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(TeamError)
  expect((err as TeamError).kind).toBe(kind)
  if (errorCode) expect((err as TeamError).errorCode).toBe(errorCode)
}

describe('transferência de propriedade', () => {
  it('é atômica sob concorrência: só uma vence, termina com 1 owner e o antigo vira admin', async () => {
    const o = await user()
    const c = await company(o.id)
    const admins = [await user(), await user(), await user()]
    for (const a of admins) await add(c.id, a.id, 'admin')
    const team = new TeamService({ db })
    const results = await Promise.allSettled(admins.map((a) => team.transferOwnership({ userId: o.id, systemRole: 'user' }, c.id, a.id)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results) if (r.status === 'rejected') expect((r.reason as TeamError).kind).toBe('forbidden')
    expect(await owners(c.id)).toHaveLength(1)
    const [me] = await db.select().from(companyMembers).where(eq(companyMembers.userId, o.id))
    expect(me!.role).toBe('admin')
  })

  it('só para um admin existente; owner para si mesmo → conflito', async () => {
    const o = await user()
    const c = await company(o.id)
    const m = await user()
    await add(c.id, m.id, 'member')
    const team = new TeamService({ db })
    await rejectsWith(team.transferOwnership({ userId: o.id, systemRole: 'user' }, c.id, m.id), 'conflict', 'target_not_admin')
    await rejectsWith(team.transferOwnership({ userId: o.id, systemRole: 'user' }, c.id, o.id), 'conflict', 'target_not_admin')
    await rejectsWith(team.transferOwnership({ userId: m.id, systemRole: 'user' }, c.id, o.id), 'forbidden')
  })

  it('admin não rebaixa nem remove o owner', async () => {
    const o = await user()
    const c = await company(o.id)
    const a = await user()
    await add(c.id, a.id, 'admin')
    const team = new TeamService({ db })
    await rejectsWith(team.update({ userId: a.id, systemRole: 'user', role: 'admin' }, c.id, o.id, { role: 'member' }), 'forbidden')
    await rejectsWith(team.remove(c.id, o.id), 'forbidden')
    await rejectsWith(team.update({ userId: o.id, systemRole: 'user', role: 'owner' }, c.id, o.id, { role: 'admin' }), 'conflict', 'owner_must_transfer')
    const updated = await team.update({ userId: o.id, systemRole: 'user', role: 'owner' }, c.id, a.id, { permissionKeys: ['flows.delete'] })
    expect(updated.permission_keys).toEqual(expect.arrayContaining(['flows.delete', 'flows.view']))
  })
})

describe('convites', () => {
  const setup = async (now = { t: new Date('2026-10-16T12:00:00Z') }) => {
    const mailer = new MemoryMailer()
    const svc = new InvitationService({ db, mailer, sessions: new SessionService({ db }), resendCooldownMs: 0, now: () => now.t })
    const o = await user('Owner')
    const c = await company(o.id)
    return { mailer, svc, o, c, now }
  }

  it('token só como hash; link no e-mail; reenvio 3/dia e o 4º recusado', async () => {
    const { mailer, svc, o, c } = await setup()
    const { invitation, link } = await svc.create({ userId: o.id, name: 'Owner' }, c.id, { kind: 'member', email: 'Novo@Ex.test', role: 'admin' })
    const token = decodeURIComponent(link.split('/invitations/')[1]!)
    const sent = mailer.sent
    expect(JSON.stringify(sent.at(-1))).toContain(token)
    const raw = await db.$client.query(`select row_to_json(i)::text as j from crm.invitations i where id = $1`, [invitation.id])
    expect(raw.rows[0].j).not.toContain(token)
    expect(invitation.email).toBe('novo@ex.test')

    const remaining = []
    for (let i = 0; i < 3; i++) remaining.push((await svc.resend(c.id, invitation.id)).invitation.resends_remaining_today)
    expect(remaining).toEqual([2, 1, 0])
    await rejectsWith(svc.resend(c.id, invitation.id), 'rate_limit', 'resend_limit')
    expect((await svc.get(c.id, invitation.id)).can_resend).toBe(false)
  })

  it('reenviar troca o token: o link antigo deixa de valer', async () => {
    const { svc, o, c } = await setup()
    const first = await svc.create({ userId: o.id, name: 'Owner' }, c.id, { kind: 'member', email: `t${seq}@ex.test`, role: 'member' })
    const oldToken = decodeURIComponent(first.link.split('/invitations/')[1]!)
    await svc.resend(c.id, first.invitation.id)
    await rejectsWith(svc.getByToken(oldToken), 'not_found')
  })

  it('aceite cria a membership com o papel; expirado → gone; e-mail diferente → forbidden', async () => {
    const { svc, o, c, now } = await setup()
    const u = await user()
    const { link } = await svc.create({ userId: o.id, name: 'Owner' }, c.id, { kind: 'member', email: u.email, role: 'admin' })
    const token = decodeURIComponent(link.split('/invitations/')[1]!)
    const stranger = await user()
    await rejectsWith(svc.accept(token, { user: stranger }), 'forbidden', 'invitation_email_mismatch')
    const r = await svc.accept(token, { user: u })
    expect(r.role).toBe('admin')
    const [m] = await db.select().from(companyMembers).where(eq(companyMembers.userId, u.id))
    expect(m!.role).toBe('admin')
    await rejectsWith(svc.accept(token, { user: u }), 'gone')

    const late = await svc.create({ userId: o.id, name: 'Owner' }, c.id, { kind: 'member', email: `late${seq}@ex.test`, role: 'member' })
    now.t = new Date(now.t.getTime() + 8 * 86_400_000)
    await rejectsWith(svc.accept(decodeURIComponent(late.link.split('/invitations/')[1]!), { signup: { name: 'X', password: 'segredo123' } }), 'gone', 'invitation_expired')
  })

  it('sem login: cria a conta se o e-mail é novo; e-mail existente exige login', async () => {
    const { svc, o, c } = await setup()
    const email = `novo${seq}@ex.test`
    const { link } = await svc.create({ userId: o.id, name: 'Owner' }, c.id, { kind: 'platform', email, role: 'member' })
    const token = decodeURIComponent(link.split('/invitations/')[1]!)
    const r = await svc.accept(token, { signup: { name: 'Nova', password: 'segredo123' } })
    expect(r.user.email).toBe(email)
    expect(r.session?.token).toBeTruthy()

    const existing = await user()
    const second = await svc.create({ userId: o.id, name: 'Owner' }, c.id, { kind: 'member', email: existing.email, role: 'member' })
    await rejectsWith(svc.accept(decodeURIComponent(second.link.split('/invitations/')[1]!), null), 'unauthorized', 'login_required')
  })
})

describe('desativação da empresa', () => {
  it('pausa só as sessões da empresa, ignora as já pausadas e só o owner desativa', async () => {
    const gw = new FakeWaGateway({ sessions: [{ id: 'a' }, { id: 'b' }, { id: 'outra' }] })
    await gw.sessions.pause('b')
    const svc = new CompanyService({ db, waGateway: gw, sessionsSources: [() => ['a', 'b']] })
    const o = await user()
    const c = await company(o.id)
    const a = await user()
    await add(c.id, a.id, 'admin')
    await rejectsWith(svc.deactivate({ userId: a.id, systemRole: 'user' }, c.id), 'forbidden')
    const r = await svc.deactivate({ userId: o.id, systemRole: 'user' }, c.id)
    expect(r.company.active).toBe(false)
    expect(r.pausedSessionIds).toEqual(['a'])
    expect((await gw.sessions.get('outra')).status).toBe('STABLE')
    expect(await svc.isActive(c.id)).toBe(false)
    await svc.update({ userId: o.id, systemRole: 'user' }, c.id, { active: true })
    expect(await svc.isActive(c.id)).toBe(true)
    expect((await gw.sessions.get('a')).status).toBe('PAUSED')
  })
})
