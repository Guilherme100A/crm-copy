// Postgres real (SPEC 3.10): estados do pedido, concessão de 12 h com relógio injetado, contexto de empresa por
// concessão, reconferência do SSE e empresas concedidas no perfil (T32).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companies, companyMembers, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, type BlobStore } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { AuthService } from '../auth/auth-service'
import { resolutionPermissions, resolveCompanyContext } from '../platform/company-context'
import { SessionService } from '../platform/session-service'
import { checkConnectionAccess } from '../realtime/access'
import type { RealtimePublisher } from '../realtime/publisher'
import { SupportAccessError } from './errors'
import { setSupportAccessClock, SUPPORT_GRANT_PERMISSIONS, SUPPORT_GRANT_TTL_MS } from './grants'
import { SupportAccessService } from './service'

let tmp: TempDatabase
let db: Database
let seq = 0
let clock = new Date('2026-10-16T12:00:00Z')
const published: { companyId: string; type: string; data: unknown; userId?: string }[] = []
const publisher = {
  publish: async (companyId: string, type: string, data: unknown, opts: { userId?: string } = {}) => {
    published.push({ companyId, type, data, userId: opts.userId })
    return '1-0'
  },
} as unknown as RealtimePublisher
let svc: SupportAccessService

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 6 })
  setSupportAccessClock(db, () => clock)
  svc = new SupportAccessService({ db, publisher, now: () => clock })
}, 60_000)
afterAll(async () => {
  setSupportAccessClock(db, undefined)
  await db?.$client.end()
  await tmp?.drop()
})

async function user(systemRole: 'user' | 'support' = 'user') {
  seq += 1
  const [u] = await db.insert(users).values({ email: `u${seq}-${Date.now()}@ex.test`, passwordHash: 'x', name: `U${seq}`, systemRole }).returning()
  return u!
}

async function company(ownerId: string) {
  seq += 1
  const [c] = await db.insert(companies).values({ name: `Empresa ${seq}`, slug: `empresa-${seq}-${Date.now()}` }).returning()
  await db.insert(companyMembers).values({ companyId: c!.id, userId: ownerId, role: 'owner' })
  return c!
}

const rejectsWith = async (p: Promise<unknown>, kind: SupportAccessError['kind'], errorCode?: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(SupportAccessError)
  expect((err as SupportAccessError).kind).toBe(kind)
  if (errorCode) expect((err as SupportAccessError).errorCode).toBe(errorCode)
}

describe('SupportAccessService', () => {
  it('pedido → aprovação cria concessão de 12 h no relógio injetado; eventos na empresa e para o suporte', async () => {
    const owner = await user()
    const c = await company(owner.id)
    const sup = await user('support')
    published.length = 0

    const request = await svc.createRequest(sup.id, { email: owner.email.toUpperCase() })
    expect(request).toMatchObject({ status: 'pending', company_id: c.id, company_name: c.name, support_user_id: sup.id, support_email: sup.email })
    await rejectsWith(svc.createRequest(sup.id, { email: owner.email }), 'conflict', 'request_pending')

    const { request: approved, grant } = await svc.approve(c.id, request.id, owner.id)
    expect(approved.status).toBe('approved')
    expect(new Date(grant.expires_at).getTime() - clock.getTime()).toBe(SUPPORT_GRANT_TTL_MS)
    await rejectsWith(svc.reject(c.id, request.id, owner.id), 'invalid_transition', 'request_not_pending')
    await rejectsWith(svc.createRequest(sup.id, { email: owner.email }), 'conflict', 'grant_active')

    expect(published.map((p) => [p.type, p.userId ?? null])).toEqual([
      ['support_access.requested', null],
      ['support_access.requested', sup.id],
      ['support_access.granted', null],
      ['support_access.granted', sup.id],
    ])
    expect(published.every((p) => p.companyId === c.id)).toBe(true)

    // Expira com o relógio.
    clock = new Date(clock.getTime() + SUPPORT_GRANT_TTL_MS)
    expect(await svc.listCompanyGrants(c.id)).toEqual([])
    await rejectsWith(svc.revoke(c.id, sup.id, owner.id), 'not_found')
    clock = new Date('2026-10-16T12:00:00Z')
  })

  it('isolamento: outra empresa não decide nem revoga; pedido de outro suporte → 404', async () => {
    const owner = await user()
    const c = await company(owner.id)
    const other = await company((await user()).id)
    const sup = await user('support')
    const request = await svc.createRequest(sup.id, { email: owner.email })
    await rejectsWith(svc.approve(other.id, request.id, owner.id), 'not_found')
    await rejectsWith(svc.cancelRequest((await user('support')).id, request.id), 'not_found')
    await rejectsWith(svc.approve(c.id, 'nao-e-uuid', owner.id), 'not_found')
    expect(await svc.listCompanyRequests(other.id)).toEqual([])
    expect((await svc.listCompanyRequests(c.id)).map((r) => r.id)).toEqual([request.id])
  })

  it('lookup ignora empresas desativadas e e-mails que só são member', async () => {
    const owner = await user()
    const c = await company(owner.id)
    const m = await user()
    await db.insert(companyMembers).values({ companyId: c.id, userId: m.id, role: 'member' })
    expect(await svc.lookup(m.email)).toEqual([])
    expect(await svc.lookup(owner.email)).toEqual([{ id: c.id, name: c.name }])

    await db.update(companies).set({ active: false }).where(eq(companies.id, c.id))
    expect(await svc.lookup(owner.email)).toEqual([])
  })
})

describe('contexto de empresa, SSE e perfil do suporte', () => {
  it('resolveCompanyContext: suporte entra só com concessão ativa; quem não é suporte continua 404', async () => {
    const owner = await user()
    const c = await company(owner.id)
    const sup = await user('support')
    const plain = await user()
    expect(await resolveCompanyContext(db, { id: sup.id, lastCompanyId: null, systemRole: 'support' }, c.id)).toEqual({ ok: false, reason: 'not_found' })

    const request = await svc.createRequest(sup.id, { email: owner.email })
    const { grant } = await svc.approve(c.id, request.id, owner.id)
    const r = await resolveCompanyContext(db, { id: sup.id, lastCompanyId: null, systemRole: 'support' }, c.id)
    expect(r).toMatchObject({ ok: true, companyId: c.id, member: null, supportGrant: { id: grant.id, companyId: c.id } })
    // Sem header: a empresa concedida vira a ativa.
    expect(await resolveCompanyContext(db, { id: sup.id, lastCompanyId: null, systemRole: 'support' })).toMatchObject({ companyId: c.id })
    if (!r.ok) throw new Error('esperava empresa resolvida')
    expect([...resolutionPermissions(r, { systemRole: 'support' })]).toEqual(SUPPORT_GRANT_PERMISSIONS)
    // Mesmo com concessão no banco, sem o papel `support` nada muda.
    expect(await resolveCompanyContext(db, { id: sup.id, lastCompanyId: null }, c.id)).toEqual({ ok: false, reason: 'not_found' })
    expect(await resolveCompanyContext(db, { id: plain.id, lastCompanyId: null, systemRole: 'user' }, c.id)).toEqual({ ok: false, reason: 'not_found' })

    await svc.revoke(c.id, sup.id, owner.id)
    expect(await resolveCompanyContext(db, { id: sup.id, lastCompanyId: null, systemRole: 'support' }, c.id)).toEqual({ ok: false, reason: 'support_access_expired' })
  })

  it('AC-T32-02: support que já teve concessão (expirada/revogada) → support_access_expired; nunca teve → not_found; não-support → not_found', async () => {
    const owner = await user()
    const c = await company(owner.id)
    const other = await company((await user()).id)
    const sup = await user('support')
    const plain = await user()
    const asSupport = { id: sup.id, lastCompanyId: null, systemRole: 'support' as const }
    // Nunca teve concessão (só pedido pendente) → 404.
    await svc.createRequest(sup.id, { email: owner.email })
    expect(await resolveCompanyContext(db, asSupport, c.id)).toEqual({ ok: false, reason: 'not_found' })
    expect(await resolveCompanyContext(db, asSupport, other.id)).toEqual({ ok: false, reason: 'not_found' })

    // Expirada (relógio) → 403; a outra empresa continua 404.
    const [pending] = await svc.listCompanyRequests(c.id)
    await svc.approve(c.id, pending!.id, owner.id)
    clock = new Date(clock.getTime() + SUPPORT_GRANT_TTL_MS + 1)
    try {
      expect(await resolveCompanyContext(db, asSupport, c.id)).toEqual({ ok: false, reason: 'support_access_expired' })
      expect(await resolveCompanyContext(db, asSupport, other.id)).toEqual({ ok: false, reason: 'not_found' })
      // Não-support (mesmo id com outro papel, ou outro usuário): nada muda.
      expect(await resolveCompanyContext(db, { ...asSupport, systemRole: 'user' }, c.id)).toEqual({ ok: false, reason: 'not_found' })
      expect(await resolveCompanyContext(db, { id: plain.id, lastCompanyId: null, systemRole: 'user' }, c.id)).toEqual({ ok: false, reason: 'not_found' })
    } finally {
      clock = new Date('2026-10-16T12:00:00Z')
    }
  })

  it('checkConnectionAccess: pedido pendente mantém o stream sem permissões; concessão dá o escopo; nada → null', async () => {
    const owner = await user()
    const c = await company(owner.id)
    const sup = await user('support')
    const sessions = new SessionService({ db })
    const s = await sessions.create(sup.id)
    const input = { auth: { kind: 'session' as const, sessionId: s.sessionId }, user: { id: sup.id, systemRole: 'support' as const }, companyId: c.id, perms: new Set<string>() }
    expect(await checkConnectionAccess(db, input)).toBeNull()

    const request = await svc.createRequest(sup.id, { email: owner.email })
    expect(await checkConnectionAccess(db, input)).toEqual({ member: null, perms: new Set() })
    await svc.approve(c.id, request.id, owner.id)
    expect([...(await checkConnectionAccess(db, input))!.perms]).toEqual(SUPPORT_GRANT_PERMISSIONS)
    clock = new Date(clock.getTime() + SUPPORT_GRANT_TTL_MS + 1)
    try {
      expect(await checkConnectionAccess(db, input)).toBeNull()
    } finally {
      clock = new Date('2026-10-16T12:00:00Z')
    }
  })

  it('listCompanies inclui a empresa concedida com o escopo da concessão; para quem não é suporte, nada muda', async () => {
    const owner = await user()
    const c = await company(owner.id)
    const sup = await user('support')
    const auth = new AuthService({
      db,
      sessions: new SessionService({ db }),
      mailer: new MemoryMailer(),
      blobStore: {} as BlobStore,
      appName: 'CRM',
      webPublicUrl: 'http://localhost',
    })
    const ownerBefore = await auth.listCompanies(owner.id)
    expect(await auth.listCompanies(sup.id)).toEqual([])

    const request = await svc.createRequest(sup.id, { email: owner.email })
    const { grant } = await svc.approve(c.id, request.id, owner.id)
    const list = await auth.listCompanies(sup.id)
    expect(list).toEqual([
      {
        id: c.id,
        name: c.name,
        slug: c.slug,
        role: 'member',
        effective_permissions: [...SUPPORT_GRANT_PERMISSIONS].sort(),
        support_access: { grant_id: grant.id, expires_at: grant.expires_at },
      },
    ])
    expect(await auth.listCompanies(owner.id)).toEqual(ownerBefore)
    expect(ownerBefore[0]).not.toHaveProperty('support_access')
  })
})
