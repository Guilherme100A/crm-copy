// AC-T22-01 (não-membro, leave do owner), AC-T22-02 (transferência), AC-T22-03 (papéis e permissões),
// AC-T22-06 (member.permissions_changed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { envelopeOf, sleep, summary } from '../helpers/sse'
import { errorCode, memberOf, newUser, openEvents, rolesOf, startEnv, type Env } from './setup'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const owners = (roles: Record<string, string>) => Object.entries(roles).filter(([, r]) => r === 'owner').map(([u]) => u)

describe('AC-T22-01 acesso a empresa alheia e saída do owner', () => {
  it('AC-T22-01 não-membro recebe 404 ao trocar para a empresa e ao lê-la', async () => {
    const a = await newUser(env)
    const b = await newUser(env)
    expectApiError(await b.c.post(`/api/companies/${a.companyId}/switch`), 'NOT_FOUND', 404)
    expectApiError(await b.c.get(`/api/companies/${a.companyId}`), 'NOT_FOUND', 404)
    // nem como empresa ativa via header
    b.c.setCompany(a.companyId)
    expectApiError(await b.c.get('/api/team'), 'NOT_FOUND', 404)
    // a empresa alheia não aparece na lista
    b.c.setCompany(b.companyId)
    const list = await b.c.get('/api/companies')
    expect(list.status, list.text).toBe(200)
    const ids = list.body.items.map((x: any) => x.id)
    expect(ids).toContain(b.companyId)
    expect(ids).not.toContain(a.companyId)
  })

  it('AC-T22-01 membro consegue ler e trocar para a empresa (grava a empresa ativa)', async () => {
    const a = await newUser(env)
    const m = await memberOf(env, a.companyId, 'member')
    m.c.setCompany(null)
    const read = await m.c.get(`/api/companies/${a.companyId}`)
    expect(read.status, read.text).toBe(200)
    expect(read.body.company.id).toBe(a.companyId)
    const sw = await m.c.post(`/api/companies/${a.companyId}/switch`)
    expect(sw.status, sw.text).toBe(200)
    expect(sw.body.company.id).toBe(a.companyId)
    expect(sw.body.role).toBe('member')
    const [u] = await env.q(`SELECT last_company_id FROM crm.users WHERE id = $1`, [m.userId])
    expect(u.last_company_id).toBe(a.companyId)
  })

  it('AC-T22-01 leave do owner → 409 (owner_must_transfer) até transferir a propriedade', async () => {
    const a = await newUser(env)
    const admin = await memberOf(env, a.companyId, 'admin')
    const blocked = await a.c.post(`/api/companies/${a.companyId}/leave`)
    expectApiError(blocked, 'CONFLICT', 409)
    expect(errorCode(blocked)).toBe('owner_must_transfer')
    expect((await rolesOf(env, a.companyId))[a.userId]).toBe('owner')

    const tr = await a.c.post(`/api/team/${admin.userId}/transfer-ownership`)
    expect(tr.status, tr.text).toBe(200)
    const left = await a.c.post(`/api/companies/${a.companyId}/leave`)
    expect(left.status, left.text).toBe(200)
    const roles = await rolesOf(env, a.companyId)
    expect(roles[a.userId]).toBeUndefined()
    expect(owners(roles)).toEqual([admin.userId])
    expectApiError(await a.c.get(`/api/companies/${a.companyId}`), 'NOT_FOUND', 404)
  })

  it('AC-T22-01 membro comum sai da empresa e perde o acesso', async () => {
    const a = await newUser(env)
    const m = await memberOf(env, a.companyId, 'member')
    const left = await m.c.post(`/api/companies/${a.companyId}/leave`)
    expect(left.status, left.text).toBe(200)
    expectApiError(await m.c.post(`/api/companies/${a.companyId}/switch`), 'NOT_FOUND', 404)
  })
})

describe('AC-T22-02 transferência de propriedade', () => {
  it('AC-T22-02 owner transfere para um admin: 1 owner (o novo) e o antigo vira admin', async () => {
    const a = await newUser(env)
    const admin = await memberOf(env, a.companyId, 'admin')
    const res = await a.c.post(`/api/team/${admin.userId}/transfer-ownership`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.owner.user_id).toBe(admin.userId)
    expect(res.body.owner.role).toBe('owner')
    expect(res.body.previous_owner.user_id).toBe(a.userId)
    expect(res.body.previous_owner.role).toBe('admin')
    const roles = await rolesOf(env, a.companyId)
    expect(owners(roles)).toEqual([admin.userId])
    expect(roles[a.userId]).toBe('admin')
    // a API reflete o mesmo estado
    const team = await admin.c.get('/api/team')
    expect(team.status, team.text).toBe(200)
    expect(team.body.items.filter((x: any) => x.role === 'owner').map((x: any) => x.user_id)).toEqual([admin.userId])
  })

  it('AC-T22-02 só o owner pode transferir (admin → 403)', async () => {
    const a = await newUser(env)
    const admin1 = await memberOf(env, a.companyId, 'admin')
    const admin2 = await memberOf(env, a.companyId, 'admin')
    expectApiError(await admin1.c.post(`/api/team/${admin2.userId}/transfer-ownership`), 'FORBIDDEN', 403)
    expectApiError(await admin1.c.post(`/api/team/${admin1.userId}/transfer-ownership`), 'FORBIDDEN', 403)
    expect(owners(await rolesOf(env, a.companyId))).toEqual([a.userId])
  })

  it('AC-T22-02 só para um admin existente: membro comum → 409 target_not_admin; não-membro → 404', async () => {
    const a = await newUser(env)
    const m = await memberOf(env, a.companyId, 'member')
    const outsider = await newUser(env)
    const notAdmin = await a.c.post(`/api/team/${m.userId}/transfer-ownership`)
    expectApiError(notAdmin, 'CONFLICT', 409)
    expect(errorCode(notAdmin)).toBe('target_not_admin')
    expectApiError(await a.c.post(`/api/team/${outsider.userId}/transfer-ownership`), 'NOT_FOUND', 404)
    const self = await a.c.post(`/api/team/${a.userId}/transfer-ownership`)
    expect(self.status).toBe(409)
    const roles = await rolesOf(env, a.companyId)
    expect(owners(roles)).toEqual([a.userId])
    expect(roles[m.userId]).toBe('member')
  })

  it('AC-T22-02 transferências concorrentes terminam com exatamente 1 owner (atômica)', async () => {
    const a = await newUser(env)
    const admins = await Promise.all([memberOf(env, a.companyId, 'admin'), memberOf(env, a.companyId, 'admin'), memberOf(env, a.companyId, 'admin')])
    const results = await Promise.all(admins.map((x) => a.c.post(`/api/team/${x.userId}/transfer-ownership`)))
    const ok = results.filter((r) => r.status === 200)
    expect(ok.length, results.map((r) => `${r.status} ${r.text.slice(0, 120)}`).join('\n')).toBe(1)
    for (const r of results) if (r.status !== 200) expect([403, 409]).toContain(r.status)
    const roles = await rolesOf(env, a.companyId)
    const own = owners(roles)
    expect(own).toHaveLength(1)
    expect(own[0]).toBe(ok[0]!.body.owner.user_id)
    expect(roles[a.userId]).toBe('admin')
  })
})

describe('AC-T22-03 papéis e permissões', () => {
  it('AC-T22-03 admin não remove nem rebaixa o owner (403)', async () => {
    const a = await newUser(env)
    const admin = await memberOf(env, a.companyId, 'admin')
    expectApiError(await admin.c.patch(`/api/team/${a.userId}`, { role: 'member' }), 'FORBIDDEN', 403)
    expectApiError(await admin.c.patch(`/api/team/${a.userId}`, { role: 'admin' }), 'FORBIDDEN', 403)
    expectApiError(await admin.c.delete(`/api/team/${a.userId}`), 'FORBIDDEN', 403)
    expect((await rolesOf(env, a.companyId))[a.userId]).toBe('owner')
  })

  it('AC-T22-03 admin consegue gerenciar membros comuns (sanidade do 403 acima)', async () => {
    const a = await newUser(env)
    const admin = await memberOf(env, a.companyId, 'admin')
    const m = await memberOf(env, a.companyId, 'member')
    const up = await admin.c.patch(`/api/team/${m.userId}`, { role: 'admin' })
    expect(up.status, up.text).toBe(200)
    expect(up.body.member.role).toBe('admin')
    const m2 = await memberOf(env, a.companyId, 'member')
    const del = await admin.c.delete(`/api/team/${m2.userId}`)
    expect(del.status, del.text).toBe(200)
    expect((await rolesOf(env, a.companyId))[m2.userId]).toBeUndefined()
  })

  it('AC-T22-03 chaves de permissão inválidas → 422 VALIDATION_ERROR', async () => {
    const a = await newUser(env)
    const m = await memberOf(env, a.companyId, 'member')
    for (const keys of [['contacts.view', 'nao.existe'], ['billing.view'], ['CONTACTS.VIEW'], 'contacts.view']) {
      const res = await a.c.patch(`/api/team/${m.userId}`, { permission_keys: keys })
      expectApiError(res, 'VALIDATION_ERROR', 422)
      expect(Array.isArray(res.body.error.details?.fields), res.text).toBe(true)
    }
    const [row] = await env.q(`SELECT permission_keys FROM crm.company_members WHERE company_id = $1 AND user_id = $2`, [a.companyId, m.userId])
    expect(row.permission_keys).toBeNull()
  })

  it('AC-T22-03 chaves salvas são normalizadas (edit/delete sem view recebem view; chat.block recebe chat.view)', async () => {
    const a = await newUser(env)
    const m = await memberOf(env, a.companyId, 'member')
    const res = await a.c.patch(`/api/team/${m.userId}`, { permission_keys: ['contacts.edit', 'flows.delete', 'chat.block'] })
    expect(res.status, res.text).toBe(200)
    const keys: string[] = res.body.member.permission_keys
    for (const k of ['contacts.edit', 'contacts.view', 'flows.delete', 'flows.view', 'chat.block', 'chat.view']) expect(keys, JSON.stringify(keys)).toContain(k)
    expect(new Set(keys).size).toBe(keys.length)
    const team = await a.c.get('/api/team')
    const saved = team.body.items.find((x: any) => x.user_id === m.userId)
    expect([...saved.permission_keys].sort()).toEqual([...keys].sort())
    const [row] = await env.q(`SELECT permission_keys FROM crm.company_members WHERE company_id = $1 AND user_id = $2`, [a.companyId, m.userId])
    expect([...row.permission_keys].sort()).toEqual([...keys].sort())
  })
})

describe('AC-T22-06 evento member.permissions_changed', () => {
  const isChange = (userId: string) => (m: { event: string; data: string }) =>
    m.event === 'member.permissions_changed' && envelopeOf(m as any).data?.user_id === userId

  it('AC-T22-06 mudar o papel publica member.permissions_changed para o usuário afetado (e só para ele)', async () => {
    const a = await newUser(env)
    const target = await memberOf(env, a.companyId, 'member')
    const bystander = await memberOf(env, a.companyId, 'member')
    const st = await openEvents(env, target, a.companyId)
    const sb = await openEvents(env, bystander, a.companyId)
    try {
      const res = await a.c.patch(`/api/team/${target.userId}`, { role: 'admin' })
      expect(res.status, res.text).toBe(200)
      const ev = await st.waitFor(isChange(target.userId), 10_000)
      const envl = envelopeOf(ev)
      expect(envl.company_id).toBe(a.companyId)
      expect(envl.data).toMatchObject({ user_id: target.userId, role: 'admin' })
      await sleep(500)
      expect(sb.events('member.permissions_changed'), summary(sb.messages)).toEqual([])
    } finally {
      await st.close()
      await sb.close()
    }
  })

  it('AC-T22-06 mudar as permissões publica member.permissions_changed com as chaves normalizadas', async () => {
    const a = await newUser(env)
    const target = await memberOf(env, a.companyId, 'member')
    const st = await openEvents(env, target, a.companyId)
    try {
      const res = await a.c.patch(`/api/team/${target.userId}`, { permission_keys: ['kanban.edit'] })
      expect(res.status, res.text).toBe(200)
      const ev = await st.waitFor(isChange(target.userId), 10_000)
      const keys: string[] = envelopeOf(ev).data.permission_keys
      expect(keys).toEqual(expect.arrayContaining(['kanban.edit', 'kanban.view']))
    } finally {
      await st.close()
    }
  })

  it('AC-T22-06 requisição recusada (403/422) não publica evento', async () => {
    const a = await newUser(env)
    const admin = await memberOf(env, a.companyId, 'admin')
    const target = await memberOf(env, a.companyId, 'member')
    const so = await openEvents(env, a, a.companyId)
    const st = await openEvents(env, target, a.companyId)
    try {
      expect((await admin.c.patch(`/api/team/${a.userId}`, { role: 'member' })).status).toBe(403)
      expect((await a.c.patch(`/api/team/${target.userId}`, { permission_keys: ['nao.existe'] })).status).toBe(422)
      await sleep(700)
      expect(so.events('member.permissions_changed'), summary(so.messages)).toEqual([])
      expect(st.events('member.permissions_changed'), summary(st.messages)).toEqual([])
    } finally {
      await so.close()
      await st.close()
    }
  })
})
