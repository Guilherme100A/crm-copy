// AC-T32-01 (aprovação só owner/admin, concessão de 12 h), AC-T32-02 (escopo flows.* / settings.mcp.*; expirada ou
// revogada → 403), AC-T32-03 (eventos support_access.* na empresa e no stream do suporte), AC-T32-04 (só `support` pede).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { envelopeOf } from '../helpers/sse'
import {
  companyStream,
  errorCode,
  grantAccess,
  HOUR,
  newMember,
  newOwner,
  newSupport,
  openEvents,
  requestAccess,
  startEnv,
  streamEvents,
  userStream,
  type Env,
} from './setup'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})
afterEach(() => {
  if (env) env.offsetMs = 0
})

const MINUTE = 60_000

describe('AC-T32-01 aprovação por owner/admin e concessão de 12 h', () => {
  it('AC-T32-01 member não aprova nem rejeita (403) e o pedido segue pendente', async () => {
    const owner = await newOwner(env)
    const member = await newMember(env, owner.companyId, 'member')
    const sp = await newSupport(env)
    const request = await requestAccess(sp, owner)
    expect(request.status).toBe('pending')

    const ap = await member.c.post(`/api/support-access/requests/${request.id}/approve`)
    expectApiError(ap, 'FORBIDDEN', 403)
    expectApiError(await member.c.post(`/api/support-access/requests/${request.id}/reject`), 'FORBIDDEN', 403)
    expectApiError(await member.c.get('/api/support-access/requests'), 'FORBIDDEN', 403)

    // member com todas as permissões de fluxo/config ainda não é owner/admin
    const powered = await newMember(env, owner.companyId, 'member', ['flows.view', 'flows.edit', 'settings.mcp.view', 'settings.mcp.edit'])
    expectApiError(await powered.c.post(`/api/support-access/requests/${request.id}/approve`), 'FORBIDDEN', 403)

    // o próprio suporte também não aprova o seu pedido
    sp.c.setCompany(owner.companyId)
    const self = await sp.c.post(`/api/support-access/requests/${request.id}/approve`)
    expect([403, 404], self.text).toContain(self.status)
    sp.c.setCompany(null)

    const [row] = await env.q(`SELECT status FROM crm.support_access_requests WHERE id = $1`, [request.id])
    expect(row.status).toBe('pending')
    const grants = await env.q(`SELECT id FROM crm.support_access_grants WHERE company_id = $1`, [owner.companyId])
    expect(grants).toHaveLength(0)
    const pending = await owner.c.get('/api/support-access/requests')
    expect(pending.status, pending.text).toBe(200)
    expect(pending.body.requests.map((r: any) => r.id)).toContain(request.id)
  })

  it('AC-T32-01 owner aprova: concessão expira em 12 h (fio, banco e listagens)', async () => {
    const owner = await newOwner(env)
    const sp = await newSupport(env)
    const request = await requestAccess(sp, owner)
    const before = Date.now()
    const res = await owner.c.post(`/api/support-access/requests/${request.id}/approve`)
    const after = Date.now()
    expect(res.status, res.text).toBe(200)
    expect(res.body.request.status).toBe('approved')
    const grant = res.body.grant
    expect(grant.support_user_id).toBe(sp.userId)
    expect(grant.company_id).toBe(owner.companyId)
    expect(grant.email).toBe(sp.email)
    const exp = Date.parse(grant.expires_at)
    expect(exp).toBeGreaterThanOrEqual(before + 12 * HOUR - 1000)
    expect(exp).toBeLessThanOrEqual(after + 12 * HOUR + 1000)

    const [row] = await env.q(`SELECT expires_at, revoked_at FROM crm.support_access_grants WHERE id = $1`, [grant.id])
    expect(new Date(row.expires_at).getTime()).toBe(exp)
    expect(row.revoked_at).toBeNull()

    const companyGrants = await owner.c.get('/api/support-access/grants')
    expect(companyGrants.status, companyGrants.text).toBe(200)
    expect(companyGrants.body.grants.map((g: any) => g.support_user_id)).toEqual([sp.userId])
    const mine = await sp.c.get('/api/support/access-grants')
    expect(mine.status, mine.text).toBe(200)
    expect(mine.body.grants.map((g: any) => g.company_id)).toEqual([owner.companyId])
  })

  it('AC-T32-01 admin também aprova', async () => {
    const owner = await newOwner(env)
    const admin = await newMember(env, owner.companyId, 'admin')
    const sp = await newSupport(env)
    const request = await requestAccess(sp, owner)
    const res = await admin.c.post(`/api/support-access/requests/${request.id}/approve`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.grant.support_user_id).toBe(sp.userId)
  })

  it('AC-T32-01 a concessão vale até 12 h e deixa de valer depois (relógio injetado)', async () => {
    const owner = await newOwner(env)
    const sp = await newSupport(env)
    await grantAccess(sp, owner)
    sp.c.setCompany(owner.companyId)

    env.offsetMs = 12 * HOUR - 2 * MINUTE
    const still = await sp.c.get('/api/flows')
    expect(still.status, still.text).toBe(200)

    env.offsetMs = 12 * HOUR + 2 * MINUTE
    const gone = await sp.c.get('/api/flows')
    expectApiError(gone, 'FORBIDDEN', 403)
    expect(errorCode(gone)).toBe('support_access_expired')
    // rotas do lado suporte não dependem de empresa ativa (sem X-Company-Id)
    sp.c.setCompany(null)
    const mine = await sp.c.get('/api/support/access-grants')
    expect(mine.status, mine.text).toBe(200)
    expect(mine.body.grants).toHaveLength(0)
  })

  it('AC-T32-01 rejeitar fecha o pedido sem criar concessão', async () => {
    const owner = await newOwner(env)
    const sp = await newSupport(env)
    const request = await requestAccess(sp, owner)
    const rj = await owner.c.post(`/api/support-access/requests/${request.id}/reject`)
    expect(rj.status, rj.text).toBe(200)
    expect(rj.body.request.status).toBe('rejected')
    // decisão tomada não volta a ser aprovada
    const ap = await owner.c.post(`/api/support-access/requests/${request.id}/approve`)
    expect(ap.status, ap.text).toBeGreaterThanOrEqual(400)
    expect(await env.q(`SELECT id FROM crm.support_access_grants WHERE company_id = $1`, [owner.companyId])).toHaveLength(0)
    sp.c.setCompany(owner.companyId)
    expect((await sp.c.get('/api/flows')).status).toBe(404)
  })
})

describe('AC-T32-02 escopo da concessão e perda de acesso', () => {
  it('AC-T32-02 com concessão ativa o suporte lê e edita fluxos da empresa', async () => {
    const owner = await newOwner(env)
    const created = await owner.c.post('/api/flows', { name: 'Fluxo do cliente' })
    expect(created.status, created.text).toBe(201)
    const flowId = created.body.flow.id
    const sp = await newSupport(env)
    const { grant } = await grantAccess(sp, owner)
    sp.c.setCompany(owner.companyId)

    const list = await sp.c.get('/api/flows')
    expect(list.status, list.text).toBe(200)
    expect(list.body.items.map((f: any) => f.id)).toContain(flowId)
    const one = await sp.c.get(`/api/flows/${flowId}`)
    expect(one.status, one.text).toBe(200)

    const patch = await sp.c.patch(`/api/flows/${flowId}`, { name: 'Fluxo ajustado pelo suporte' })
    expect(patch.status, patch.text).toBe(200)
    const mine = await sp.c.post('/api/flows', { name: 'Fluxo criado pelo suporte' })
    expect(mine.status, mine.text).toBe(201)

    // o owner vê a edição e o fluxo novo na própria empresa
    const seen = await owner.c.get(`/api/flows/${flowId}`)
    expect(seen.body.flow.name).toBe('Fluxo ajustado pelo suporte')
    const [row] = await env.q(`SELECT company_id FROM crm.flows WHERE id = $1`, [mine.body.flow.id])
    expect(row.company_id).toBe(owner.companyId)

    // área do suporte lista os fluxos da empresa concedida
    const area = await sp.c.get(`/api/support/access-grants/${owner.companyId}/flows`)
    expect(area.status, area.text).toBe(200)
    expect(area.body.flows.map((f: any) => f.id)).toEqual(expect.arrayContaining([flowId, mine.body.flow.id]))

    // ações do suporte na empresa ficam identificáveis na auditoria
    const audit = await env.q(
      `SELECT action, detail FROM crm.audit_logs WHERE company_id = $1 AND actor_user_id = $2 AND target_id = $3`,
      [owner.companyId, sp.userId, flowId],
    )
    expect(audit.length, JSON.stringify(audit)).toBeGreaterThan(0)
    expect(audit.every((a: any) => a.detail?.support_grant_id === grant.id), JSON.stringify(audit)).toBe(true)
  })

  it('AC-T32-02 settings.mcp.* está no escopo', async () => {
    const owner = await newOwner(env)
    const sp = await newSupport(env)
    await grantAccess(sp, owner)
    sp.c.setCompany(owner.companyId)
    const res = await sp.c.get('/api/mcp_credentials')
    expect(res.status, res.text).toBe(200)
  })

  it('AC-T32-02 fora do escopo (contatos, equipe, chats, variáveis globais) → 403', async () => {
    const owner = await newOwner(env)
    const sp = await newSupport(env)
    await grantAccess(sp, owner)
    sp.c.setCompany(owner.companyId)
    for (const path of ['/api/contacts', '/api/team', '/api/chats', '/api/global-variables']) {
      const res = await sp.c.get(path)
      expect(res.status, `${path}: ${res.text.slice(0, 200)}`).toBe(403)
    }
    expectApiError(await sp.c.post('/api/contacts', { name: 'Contato do suporte', phone: '+5511900000001' }), 'FORBIDDEN', 403)
    expect(await env.q(`SELECT id FROM crm.contacts WHERE company_id = $1`, [owner.companyId])).toHaveLength(0)
  })

  it('AC-T32-02 concessão revogada → 403 na requisição seguinte', async () => {
    const owner = await newOwner(env)
    const sp = await newSupport(env)
    await grantAccess(sp, owner)
    sp.c.setCompany(owner.companyId)
    expect((await sp.c.get('/api/flows')).status).toBe(200)

    const rv = await owner.c.delete(`/api/support-access/grants/${sp.userId}`)
    expect(rv.status, rv.text).toBe(200)
    const after = await sp.c.get('/api/flows')
    expectApiError(after, 'FORBIDDEN', 403)
    expect(errorCode(after)).toBe('support_access_expired')
    expectApiError(await sp.c.post('/api/flows', { name: 'Depois da revogação' }), 'FORBIDDEN', 403)
    expect((await owner.c.get('/api/support-access/grants')).body.grants).toHaveLength(0)
  })

  it('AC-T32-02 concessão expirada no banco → 403', async () => {
    const owner = await newOwner(env)
    const sp = await newSupport(env)
    const { grant } = await grantAccess(sp, owner)
    sp.c.setCompany(owner.companyId)
    expect((await sp.c.get('/api/flows')).status).toBe(200)
    await env.q(`UPDATE crm.support_access_grants SET expires_at = now() - interval '1 minute' WHERE id = $1`, [grant.id])
    const res = await sp.c.get('/api/mcp_credentials')
    expectApiError(res, 'FORBIDDEN', 403)
    expect(errorCode(res)).toBe('support_access_expired')
  })

  it('AC-T32-02 suporte sem concessão na empresa → 404 (isolamento), mesmo com concessão em outra', async () => {
    const a = await newOwner(env)
    const b = await newOwner(env)
    const sp = await newSupport(env)
    await grantAccess(sp, a)
    sp.c.setCompany(b.companyId)
    expectApiError(await sp.c.get('/api/flows'), 'NOT_FOUND', 404)
    // pedido pendente ainda não dá acesso
    sp.c.setCompany(null)
    await requestAccess(sp, b)
    sp.c.setCompany(b.companyId)
    expectApiError(await sp.c.get('/api/flows'), 'NOT_FOUND', 404)
    sp.c.setCompany(a.companyId)
    expect((await sp.c.get('/api/flows')).status).toBe(200)
  })
})

describe('AC-T32-03 eventos na empresa e para o suporte', () => {
  const ofRequest = (id: string) => (e: { data: any }) => e.data?.request?.id === id

  it('AC-T32-03 pedir, aprovar e revogar publicam support_access.* nos dois streams', async () => {
    const owner = await newOwner(env)
    const sp = await newSupport(env)
    const request = await requestAccess(sp, owner)
    const ap = await owner.c.post(`/api/support-access/requests/${request.id}/approve`)
    expect(ap.status, ap.text).toBe(200)
    const grant = ap.body.grant
    const rv = await owner.c.delete(`/api/support-access/grants/${sp.userId}`)
    expect(rv.status, rv.text).toBe(200)

    for (const key of [companyStream(env, owner.companyId), userStream(env, sp.userId)]) {
      const all = await streamEvents(env, key)
      const types = all.map((e) => e.type)
      expect(types, key).toEqual(['support_access.requested', 'support_access.granted', 'support_access.revoked'])
      for (const e of all) expect(e.company_id, key).toBe(owner.companyId)

      const [req] = all.filter((e) => e.type === 'support_access.requested')
      expect(req!.data.request).toMatchObject({
        id: request.id,
        status: 'pending',
        support_user_id: sp.userId,
        support_email: sp.email,
        support_name: sp.name,
        company_id: owner.companyId,
      })
      const [gr] = all.filter((e) => e.type === 'support_access.granted')
      expect(gr!.data.request).toMatchObject({ id: request.id, status: 'approved' })
      expect(gr!.data.grant).toMatchObject({ id: grant.id, support_user_id: sp.userId, company_id: owner.companyId, expires_at: grant.expires_at })
      const [rk] = all.filter((e) => e.type === 'support_access.revoked')
      expect(rk!.data.grant).toMatchObject({ id: grant.id, support_user_id: sp.userId, company_id: owner.companyId })
    }
    // o stream do suporte é endereçado a ele
    for (const e of await streamEvents(env, userStream(env, sp.userId))) expect(e.user_id).toBe(sp.userId)
  })

  it('AC-T32-03 owner conectado ao SSE recebe o pedido completo em tempo real', async () => {
    const owner = await newOwner(env)
    const sp = await newSupport(env)
    const sse = await openEvents(env, owner, owner.companyId)
    try {
      const request = await requestAccess(sp, owner)
      const msg = await sse.waitFor((m) => m.event === 'support_access.requested' && envelopeOf(m).data?.request?.id === request.id, 10_000)
      expect(envelopeOf(msg).data.request).toMatchObject({ id: request.id, status: 'pending', support_email: sp.email, company_id: owner.companyId })
      await owner.c.post(`/api/support-access/requests/${request.id}/approve`)
      await sse.waitFor((m) => m.event === 'support_access.granted' && envelopeOf(m).data?.request?.id === request.id, 10_000)
    } finally {
      await sse.close()
    }
  })

  it('AC-T32-03 reenviar, cancelar e rejeitar também publicam (empresa e suporte)', async () => {
    const owner = await newOwner(env)
    const sp = await newSupport(env)
    const r1 = await requestAccess(sp, owner)
    const resend = await sp.c.post(`/api/support/access-requests/${r1.id}/resend`)
    expect(resend.status, resend.text).toBe(200)
    const cancel = await sp.c.delete(`/api/support/access-requests/${r1.id}`)
    expect(cancel.status, cancel.text).toBe(200)
    expect(cancel.body.request.status).toBe('cancelled')
    const r2 = await requestAccess(sp, owner)
    expect((await owner.c.post(`/api/support-access/requests/${r2.id}/reject`)).status).toBe(200)

    for (const key of [companyStream(env, owner.companyId), userStream(env, sp.userId)]) {
      expect((await streamEvents(env, key, 'support_access.requested')).filter(ofRequest(r1.id)), key).toHaveLength(2)
      expect((await streamEvents(env, key, 'support_access.cancelled')).filter(ofRequest(r1.id)), key).toHaveLength(1)
      expect((await streamEvents(env, key, 'support_access.rejected')).filter(ofRequest(r2.id)), key).toHaveLength(1)
    }
  })

  it('AC-T32-03 eventos de uma empresa não vão para o stream de outra', async () => {
    const a = await newOwner(env)
    const b = await newOwner(env)
    const sp = await newSupport(env)
    await grantAccess(sp, a)
    expect(await streamEvents(env, companyStream(env, b.companyId))).toHaveLength(0)
  })
})

describe('AC-T32-04 só o usuário support cria pedido', () => {
  it('AC-T32-04 usuário comum (owner de outra empresa) → 403 ao pedir, e nada é gravado', async () => {
    const target = await newOwner(env)
    const other = await newOwner(env)
    const res = await other.c.post('/api/support/access-requests', { email: target.email, company_id: target.companyId })
    expectApiError(res, 'FORBIDDEN', 403)
    expectApiError(await other.c.post('/api/support/access-requests', { email: target.email }), 'FORBIDDEN', 403)
    expect(await env.q(`SELECT id FROM crm.support_access_requests WHERE company_id = $1`, [target.companyId])).toHaveLength(0)
    expect(await streamEvents(env, companyStream(env, target.companyId))).toHaveLength(0)
  })

  it('AC-T32-04 membro (admin/member) da própria empresa também não pede', async () => {
    const target = await newOwner(env)
    for (const role of ['admin', 'member'] as const) {
      const m = await newMember(env, target.companyId, role)
      expectApiError(await m.c.post('/api/support/access-requests', { email: target.email, company_id: target.companyId }), 'FORBIDDEN', 403)
    }
    expect(await env.q(`SELECT id FROM crm.support_access_requests WHERE company_id = $1`, [target.companyId])).toHaveLength(0)
  })

  it('AC-T32-04 platform_admin não é support → 403', async () => {
    const target = await newOwner(env)
    const pa = await newOwner(env)
    await env.q(`UPDATE crm.users SET system_role = 'platform_admin' WHERE id = $1`, [pa.userId])
    expectApiError(await pa.c.post('/api/support/access-requests', { email: target.email, company_id: target.companyId }), 'FORBIDDEN', 403)
  })

  it('AC-T32-04 lookup e listagens do lado suporte também são só do support; o support consegue pedir', async () => {
    const target = await newOwner(env)
    const other = await newOwner(env)
    expectApiError(await other.c.post('/api/support/access-requests/lookup', { email: target.email }), 'FORBIDDEN', 403)
    expectApiError(await other.c.get('/api/support/access-requests'), 'FORBIDDEN', 403)
    expectApiError(await other.c.get('/api/support/access-grants'), 'FORBIDDEN', 403)

    const sp = await newSupport(env)
    const lk = await sp.c.post('/api/support/access-requests/lookup', { email: target.email })
    expect(lk.status, lk.text).toBe(200)
    expect(lk.body.accounts.map((a: any) => a.id)).toEqual([target.companyId])
    // e-mail de member comum não revela empresa
    const member = await newMember(env, target.companyId, 'member')
    const lkMember = await sp.c.post('/api/support/access-requests/lookup', { email: member.email })
    expect(lkMember.status, lkMember.text).toBe(200)
    expect(lkMember.body.accounts.map((a: any) => a.id)).not.toContain(target.companyId)

    const created = await sp.c.post('/api/support/access-requests', { email: target.email, company_id: target.companyId })
    expect(created.status, created.text).toBe(201)
    expect(created.body.request).toMatchObject({ status: 'pending', support_user_id: sp.userId, company_id: target.companyId })
    const mine = await sp.c.get('/api/support/access-requests')
    expect(mine.body.requests.map((r: any) => r.id)).toContain(created.body.request.id)
  })
})
