// AC-T95-01..04: guard platform_admin, usuários (e-mail imutável, senha opcional) + auditoria, limites da empresa, cota de disparos.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { fakeEmail } from '../helpers/factories'
import { adminLogs, client, fieldPaths, login, newAdmin, newOwner, startEnv, type Env } from './setup'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const ZERO = '00000000-0000-0000-0000-000000000000'
const companyLimits = async (id: string) => (await env.q(`SELECT settings FROM crm.companies WHERE id = $1`, [id]))[0].settings?.limits ?? {}

describe('AC-T95-01 guard', () => {
  const routes = (userId: string, companyId: string) =>
    [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users'],
      ['GET', `/api/admin/users/${userId}`],
      ['PUT', `/api/admin/users/${userId}`],
      ['GET', `/api/admin/users/${userId}/companies`],
      ['GET', '/api/admin/companies'],
      ['GET', `/api/admin/companies/${companyId}`],
      ['PATCH', `/api/admin/companies/${companyId}`],
      ['GET', '/api/admin/mass-dispatch-settings'],
      ['PATCH', '/api/admin/mass-dispatch-settings'],
      ['GET', `/api/admin/companies/${companyId}/mass-dispatch-quota`],
      ['PATCH', `/api/admin/companies/${companyId}/mass-dispatch-quota`],
      ['GET', '/api/admin/statistics'],
      ['GET', '/api/admin/qualquer-coisa'],
      ['DELETE', `/api/admin/users/${userId}`],
    ] as const

  it('AC-T95-01 owner de empresa, membro admin da empresa e support → 403 em todo /api/admin/* (inclusive rota inexistente)', async () => {
    const owner = await newOwner(env)
    const companyAdmin = await newOwner(env)
    await env.q(`INSERT INTO crm.company_members (company_id, user_id, role) VALUES ($1, $2, 'admin')`, [owner.companyId, companyAdmin.userId])
    companyAdmin.c.setCompany(owner.companyId)
    const support = await newOwner(env)
    await env.q(`UPDATE crm.users SET system_role = 'support' WHERE id = $1`, [support.userId])
    for (const u of [owner, companyAdmin, support]) {
      for (const [m, p] of routes(owner.userId, owner.companyId)) {
        const body = m === 'GET' || m === 'DELETE' ? undefined : { limits: { connections: 99 }, per_connection_limit: 1, bonus_delta: 9, name: 'X' }
        const r = await u.c.request(m, p, body)
        expect(r.status, `${m} ${p} (${u.email}): ${r.text.slice(0, 200)}`).toBe(403)
      }
    }
    // nada mudou: o owner não mexeu nos próprios limites nem na cota global
    expect(await companyLimits(owner.companyId)).not.toHaveProperty('connections', 99)
    const admin = await newAdmin(env)
    expect((await admin.c.get('/api/admin/mass-dispatch-settings')).body.settings.per_connection_limit).toBe(500)
    expect(await adminLogs(env)).toEqual(expect.not.arrayContaining([expect.objectContaining({ actor_user_id: owner.userId })]))
  })

  it('AC-T95-01 sem sessão → 401; platform_admin → 200 (e 404 em rota inexistente)', async () => {
    const anon = client(env)
    expect((await anon.get('/api/admin/users')).status).toBe(401)
    expect((await anon.get('/api/admin/companies')).status).toBe(401)
    const admin = await newAdmin(env)
    for (const p of ['/api/admin/users', '/api/admin/companies', '/api/admin/mass-dispatch-settings', '/api/admin/statistics'])
      expect((await admin.c.get(p)).status, p).toBe(200)
    expect((await admin.c.get('/api/admin/qualquer-coisa')).status).toBe(404)
  })

  it('AC-T95-01 platform_admin cuja empresa ativa foi desativada continua acessando /api/admin/*', async () => {
    const admin = await newAdmin(env)
    await env.q(`UPDATE crm.companies SET active = false, deactivated_at = now() WHERE id = $1`, [admin.companyId])
    expect((await admin.c.get('/api/admin/companies')).status).toBe(200)
  })
})

describe('AC-T95-02 usuários e auditoria', () => {
  it('AC-T95-02 POST cria usuário (fio legado {user:{…}}, papel support), sem hash na resposta, e grava admin.user.create', async () => {
    const admin = await newAdmin(env)
    const email = fakeEmail('sup')
    const r = await admin.c.post('/api/admin/users', {
      user: { name: 'Suporte Teste', email, role: 'support', password: 'abc123', password_confirmation: 'abc123' },
    })
    expect(r.status, r.text).toBe(201)
    expect(r.body.user).toMatchObject({ email, name: 'Suporte Teste', system_role: 'support' })
    expect(r.text).not.toMatch(/password_hash|abc123/)
    expect(await login(env, email, 'abc123')).not.toBeNull()
    const logs = await adminLogs(env, `target_id = $1`, [r.body.user.id])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ action: 'admin.user.create', actor_user_id: admin.userId, company_id: null })
    expect(logs[0].detail).toMatchObject({ admin: true })
    expect(JSON.stringify(logs[0])).not.toContain('abc123')
    // senha < 6 na criação → 422
    const short = await admin.c.post('/api/admin/users', { name: 'X', email: fakeEmail('x'), password: '12345', password_confirmation: '12345' })
    expectApiError(short, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(short)).toContain('password')
  })

  it('AC-T95-02 PUT ignora mudança de e-mail e mantém a senha quando ela não é informada (ausente ou vazia)', async () => {
    const admin = await newAdmin(env)
    const target = await newOwner(env)
    const novo = fakeEmail('novo')
    const r1 = await admin.c.put(`/api/admin/users/${target.userId}`, { name: 'Nome Novo', email: novo })
    expect(r1.status, r1.text).toBe(200)
    expect(r1.body.user).toMatchObject({ name: 'Nome Novo', email: target.email })
    expect(r1.body.password_changed).toBe(false)
    const r2 = await admin.c.put(`/api/admin/users/${target.userId}`, { user: { email: novo, password: '', password_confirmation: '' } })
    expect(r2.status, r2.text).toBe(200)
    expect(r2.body.password_changed).toBe(false)
    const [row] = await env.q(`SELECT email, name FROM crm.users WHERE id = $1`, [target.userId])
    expect(row).toEqual({ email: target.email, name: 'Nome Novo' })
    expect((await env.q(`SELECT 1 FROM crm.users WHERE lower(email) = lower($1)`, [novo])).length).toBe(0)
    expect(await login(env, target.email, target.password)).not.toBeNull()
    expect(await login(env, novo, target.password)).toBeNull()
    // sessão do alvo continua válida (nenhuma troca de senha)
    expect((await target.c.get('/api/auth/profile')).status).toBe(200)
    expect((await admin.c.get(`/api/admin/users/${target.userId}`)).body.user.email).toBe(target.email)
  })

  it('AC-T95-02 PUT troca a senha só quando informada com ≥ 6 (5 → 422 e nada muda; 6 → troca)', async () => {
    const admin = await newAdmin(env)
    const target = await newOwner(env)
    const short = await admin.c.put(`/api/admin/users/${target.userId}`, { password: '12345', password_confirmation: '12345' })
    expectApiError(short, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(short)).toContain('password')
    expect(await login(env, target.email, target.password)).not.toBeNull()
    expect(await login(env, target.email, '12345')).toBeNull()
    const ok = await admin.c.put(`/api/admin/users/${target.userId}`, { password: '654321', password_confirmation: '654321' })
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body.password_changed).toBe(true)
    expect(ok.text).not.toContain('654321')
    expect(await login(env, target.email, target.password)).toBeNull()
    expect(await login(env, target.email, '654321')).not.toBeNull()
    // 404 para usuário inexistente
    expect((await admin.c.put(`/api/admin/users/${ZERO}`, { name: 'X' })).status).toBe(404)
  })

  it('AC-T95-02 toda ação do admin grava admin_audit_log (usuário, empresa, configuração e bônus), sem senha no detalhe', async () => {
    const admin = await newAdmin(env)
    const target = await newOwner(env)
    expect((await admin.c.put(`/api/admin/users/${target.userId}`, { name: 'Auditado', password: 'segredo99', password_confirmation: 'segredo99' })).status).toBe(200)
    expect((await admin.c.patch(`/api/admin/companies/${target.companyId}`, { limits: { connections: 3 } })).status).toBe(200)
    expect((await admin.c.patch(`/api/admin/companies/${target.companyId}/mass-dispatch-quota`, { bonus_delta: 7 })).status).toBe(200)
    expect((await admin.c.patch('/api/admin/mass-dispatch-settings', { per_connection_limit: 500 })).status).toBe(200)
    const mine = await adminLogs(env, `actor_user_id = $1`, [admin.userId])
    const actions = mine.map((l) => l.action)
    expect(actions).toEqual(
      expect.arrayContaining(['admin.user.update', 'admin.company.update', 'admin.mass_dispatch_quota.bonus', 'admin.mass_dispatch_settings.update']),
    )
    expect(mine.every((l) => l.detail?.admin === true)).toBe(true)
    expect(mine.find((l) => l.action === 'admin.user.update')).toMatchObject({ target_id: target.userId, company_id: null })
    expect(mine.find((l) => l.action === 'admin.company.update')).toMatchObject({ target_id: target.companyId, company_id: target.companyId })
    expect(mine.find((l) => l.action === 'admin.mass_dispatch_quota.bonus')).toMatchObject({ company_id: target.companyId })
    expect(JSON.stringify(mine)).not.toContain('segredo99')
    // não duplica na empresa ativa do admin
    expect((await env.q(`SELECT action FROM crm.audit_logs WHERE company_id = $1 AND actor_user_id = $2 AND action NOT LIKE 'auth.%'`, [admin.companyId, admin.userId])).map((r) => r.action)).toEqual([])
    // consultável pela API
    const api = await admin.c.get(`/api/admin/audit-logs?company_id=${target.companyId}`)
    expect(api.status, api.text).toBe(200)
    expect(api.body.items.map((i: any) => i.action)).toEqual(expect.arrayContaining(['admin.company.update', 'admin.mass_dispatch_quota.bonus']))
  })
})

describe('AC-T95-03 limites da empresa', () => {
  it('AC-T95-03 padrão é ilimitado (null) e a validação aceita só inteiros ≥ 0 (ou null), sem normalizar', async () => {
    const admin = await newAdmin(env)
    const o = await newOwner(env)
    const r = await admin.c.get(`/api/admin/companies/${o.companyId}`)
    expect(r.status, r.text).toBe(200)
    expect(r.body.company.limits).toEqual({ connections: null, ai_agents: null, members: null, flows: null, webhooks: null })
    for (const bad of [-1, 1.5, '2', true, 'ilimitado']) {
      for (const key of ['connections', 'ai_agents', 'members', 'flows', 'webhooks']) {
        const res = await admin.c.patch(`/api/admin/companies/${o.companyId}`, { limits: { [key]: bad } })
        expect(res.status, `${key}=${JSON.stringify(bad)}: ${res.text.slice(0, 200)}`).toBe(422)
      }
    }
    expect((await admin.c.patch(`/api/admin/companies/${o.companyId}`, { limits: { inexistente: 1 } })).status).toBe(422)
    expect(await companyLimits(o.companyId)).toEqual({})
    const zero = await admin.c.patch(`/api/admin/companies/${o.companyId}`, { limits: { flows: 0 } })
    expect(zero.status, zero.text).toBe(200)
    expect(zero.body.company.limits).toMatchObject({ flows: 0, connections: null })
    // PATCH parcial mescla: definir outro limite não apaga o anterior
    const more = await admin.c.patch(`/api/admin/companies/${o.companyId}`, { limits: { members: 4 } })
    expect(more.body.company.limits).toMatchObject({ flows: 0, members: 4, connections: null })
    expect(await companyLimits(o.companyId)).toMatchObject({ flows: 0, members: 4 })
    expect((await admin.c.patch(`/api/admin/companies/${ZERO}`, { limits: { flows: 1 } })).status).toBe(404)
  })

  it('AC-T95-03 sem limite a empresa cria conexões à vontade; limite abaixo do atual impede novas sem desconectar as existentes; remover volta a ilimitado', async () => {
    const admin = await newAdmin(env)
    const o = await newOwner(env)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const c = await o.c.post('/api/connections', { name: `Loja ${i}` })
      expect(c.status, c.text).toBe(201)
      ids.push(c.body.connection.id)
    }
    const conns = await env.q(`SELECT id, session_id FROM crm.connections WHERE company_id = $1`, [o.companyId])
    for (const c of conns) await env.wa.connect(c.session_id, 'STABLE')
    await env.q(`UPDATE crm.connections SET connection_state = 'open' WHERE company_id = $1`, [o.companyId])

    const set = await admin.c.patch(`/api/admin/companies/${o.companyId}`, { limits: { connections: 1 } })
    expect(set.status, set.text).toBe(200)
    expect(set.body.company.limits.connections).toBe(1)

    const blocked = await o.c.post('/api/connections', { name: 'Excedente' })
    expectApiError(blocked, 'LIMIT_REACHED', 409)
    expect(blocked.body.error.details).toMatchObject({ limit: 1, used: 3 })

    // as 3 existentes seguem lá e conectadas (nada foi pausado, desconectado ou removido)
    const list = await o.c.get('/api/connections')
    expect(list.status).toBe(200)
    const listed = (list.body.items ?? list.body.connections).map((c: any) => c.id)
    expect(listed).toEqual(expect.arrayContaining(ids))
    const after = await env.q(`SELECT session_id, connection_state, scheduled_for_deletion_at FROM crm.connections WHERE company_id = $1`, [o.companyId])
    expect(after).toHaveLength(3)
    for (const c of after) {
      expect(c).toMatchObject({ connection_state: 'open', scheduled_for_deletion_at: null })
      expect((await env.wa.sessions.get(c.session_id)).status).toBe('STABLE')
    }

    const cleared = await admin.c.patch(`/api/admin/companies/${o.companyId}`, { limits: { connections: null } })
    expect(cleared.status, cleared.text).toBe(200)
    expect(cleared.body.company.limits.connections).toBeNull()
    for (let i = 0; i < 2; i++) expect((await o.c.post('/api/connections', { name: `Nova ${i}` })).status).toBe(201)
  })

  it('AC-T95-03 limites de membros e fluxos (opcionais) bloqueiam com 409 LIMIT_REACHED e somem ao remover', async () => {
    const admin = await newAdmin(env)
    const o = await newOwner(env)
    expect((await o.c.post('/api/flows', { name: 'Livre' })).status).toBe(201)
    expect((await admin.c.patch(`/api/admin/companies/${o.companyId}`, { limits: { flows: 1, members: 1 } })).status).toBe(200)
    expectApiError(await o.c.post('/api/flows', { name: 'Segundo' }), 'LIMIT_REACHED', 409)
    expectApiError(await o.c.post('/api/team/invitations', { email: fakeEmail('conv'), role: 'member' }), 'LIMIT_REACHED', 409)
    expect((await admin.c.patch(`/api/admin/companies/${o.companyId}`, { limits: { flows: null, members: null } })).status).toBe(200)
    expect((await o.c.post('/api/flows', { name: 'Segundo' })).status).toBe(201)
    const inv = await o.c.post('/api/team/invitations', { email: fakeEmail('conv'), role: 'member' })
    expect(inv.status, inv.text).toBeLessThan(300)
  })
})

describe('AC-T95-04 cota de disparos', () => {
  it('AC-T95-04 bônus soma no período atual sem mudar o limite global; mudar per_connection_limit recalcula a base', async () => {
    env.clock.t = new Date() // o cliente (/api/mass-dispatches/quota) usa o relógio real
    const admin = await newAdmin(env)
    const o = await newOwner(env)
    const other = await newOwner(env)
    for (let i = 0; i < 2; i++) expect((await o.c.post('/api/connections', { name: `L${i}` })).status).toBe(201)
    const settings0 = (await admin.c.get('/api/admin/mass-dispatch-settings')).body.settings
    expect(settings0.per_connection_limit).toBe(500)
    const path = `/api/admin/companies/${o.companyId}/mass-dispatch-quota`
    const q0 = (await admin.c.get(path)).body.quota
    expect(q0).toMatchObject({ limit: 1000, bonus: 0, billable_slots: 2, per_instance_limit: 500 })

    const b1 = await admin.c.patch(path, { bonus_delta: 100 })
    expect(b1.status, b1.text).toBe(200)
    expect(b1.body.quota).toMatchObject({ limit: 1100, bonus: 100, period: q0.period })
    const b2 = await admin.c.patch(path, { bonus_delta: 50 })
    expect(b2.body.quota).toMatchObject({ limit: 1150, bonus: 150 })
    const b3 = await admin.c.patch(path, { bonus_delta: -20 })
    expect(b3.body.quota).toMatchObject({ limit: 1130, bonus: 130 })
    // limite global intacto; outra empresa não recebe o bônus
    expect((await admin.c.get('/api/admin/mass-dispatch-settings')).body.settings.per_connection_limit).toBe(500)
    expect((await admin.c.get(`/api/admin/companies/${other.companyId}/mass-dispatch-quota`)).body.quota).toMatchObject({ bonus: 0 })
    // o cliente enxerga a mesma cota
    const mine = (await o.c.get('/api/mass-dispatches/quota')).body
    expect(mine.quota ?? mine.mass_dispatch_quota).toMatchObject({ limit: 1130, bonus: 130 })

    // bônus vale só no período atual: no mês seguinte zera
    const [y, m] = q0.period.split('-').map(Number)
    env.clock.t = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 15, 12))
    expect((await admin.c.get(path)).body.quota).toMatchObject({ limit: 1000, bonus: 0 })
    env.clock.t = new Date()

    const s = await admin.c.patch('/api/admin/mass-dispatch-settings', { per_connection_limit: 300 })
    expect(s.status, s.text).toBe(200)
    expect(s.body.settings.per_connection_limit).toBe(300)
    expect((await admin.c.get(path)).body.quota).toMatchObject({ limit: 2 * 300 + 130, bonus: 130, per_instance_limit: 300 })
    expect((await admin.c.get(`/api/admin/companies/${other.companyId}/mass-dispatch-quota`)).body.quota).toMatchObject({ limit: 0 })

    for (const bad of [{ bonus_delta: 0 }, { bonus_delta: 2.5 }, { bonus_delta: '10' }, {}]) expect((await admin.c.patch(path, bad)).status, JSON.stringify(bad)).toBe(422)
    for (const bad of [-1, 1.5, '300']) expect((await admin.c.patch('/api/admin/mass-dispatch-settings', { per_connection_limit: bad })).status).toBe(422)
    expect((await admin.c.patch(`/api/admin/companies/${ZERO}/mass-dispatch-quota`, { bonus_delta: 5 })).status).toBe(404)
    expect((await admin.c.get(path)).body.quota).toMatchObject({ bonus: 130 })
    await admin.c.patch('/api/admin/mass-dispatch-settings', { per_connection_limit: 500 })
  })
})

describe('estatísticas (entregável, sem AC)', () => {
  it('GET /api/admin/statistics responde sem campos de dinheiro', async () => {
    const admin = await newAdmin(env)
    const r = await admin.c.get('/api/admin/statistics')
    expect(r.status, r.text).toBe(200)
    expect(r.body.statistics).toHaveProperty('messages_per_day')
    expect(r.text).not.toMatch(/revenue|amount|cents|price|official/i)
  })
})
