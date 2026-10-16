// AC-T22-05: desativar a empresa bloqueia os membros (403 company_inactive) e pausa as conexões
// via WaGateway.sessions.pause (FakeWaGateway); reativar libera.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uniqueId } from '../helpers/factories'
import { errorCode, memberOf, newUser, startEnv, type Env } from './setup'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

/** Cria sessões STABLE no FakeWaGateway e as associa à empresa. */
function sessionsFor(companyId: string, n = 2): string[] {
  const ids = Array.from({ length: n }, () => env.gateway.addSession({ id: uniqueId('s'), state: 'STABLE' }).id as string)
  env.companySessions.set(companyId, ids)
  return ids
}

/** Rota que todo membro acessa (sem permissão extra) e que não fica liberada com a empresa inativa. */
const PROBE = '/api/permissions/definitions'

const stateOf = async (id: string) => (await env.gateway.sessions.list()).find((s: any) => s.id === id)?.status

describe('AC-T22-05 desativar e reativar a empresa', () => {
  it('AC-T22-05 desativar bloqueia /api/* dos membros com 403 company_inactive e pausa as conexões da empresa', async () => {
    const owner = await newUser(env)
    const member = await memberOf(env, owner.companyId, 'member')
    const other = await newUser(env) // outra empresa, com sessão própria
    const mine = sessionsFor(owner.companyId)
    const theirs = sessionsFor(other.companyId, 1)
    expect((await member.c.get(PROBE)).status).toBe(200)

    const del = await owner.c.delete(`/api/companies/${owner.companyId}`)
    expect(del.status, del.text).toBe(200)
    expect(del.body.company.active).toBe(false)
    expect([...del.body.paused_session_ids].sort()).toEqual([...mine].sort())

    for (const id of mine) expect(await stateOf(id)).toBe('PAUSED')
    expect(await stateOf(theirs[0]!)).toBe('STABLE')

    for (const u of [member, owner]) {
      const res = await u.c.get(PROBE)
      expectApiError(res, 'FORBIDDEN', 403)
      expect(errorCode(res)).toBe('company_inactive')
    }
    const mutate = await member.c.post('/api/team/invitations', { email: 'x@example.test', role: 'member' })
    expect(mutate.status).toBe(403)
    expect(errorCode(mutate)).toBe('company_inactive')
    // a outra empresa segue normal
    expect((await other.c.get('/api/team')).status).toBe(200)
    // a empresa continua listada (inativa) e legível para o owner reativar
    const read = await owner.c.get(`/api/companies/${owner.companyId}`)
    expect(read.status, read.text).toBe(200)
    expect(read.body.company.active).toBe(false)
  })

  it('AC-T22-05 reativar libera o acesso (sem retomar as conexões automaticamente)', async () => {
    const owner = await newUser(env)
    const member = await memberOf(env, owner.companyId, 'member')
    const [sid] = sessionsFor(owner.companyId, 1)
    expect((await owner.c.delete(`/api/companies/${owner.companyId}`)).status).toBe(200)
    expect((await member.c.get(PROBE)).status).toBe(403)

    const on = await owner.c.put(`/api/companies/${owner.companyId}`, { active: true })
    expect(on.status, on.text).toBe(200)
    expect(on.body.company.active).toBe(true)
    const team = await member.c.get(PROBE)
    expect(team.status, team.text).toBe(200)
    expect((await owner.c.get('/api/team')).status).toBe(200)
    expect(await stateOf(sid!)).toBe('PAUSED')
  })

  it('AC-T22-05 só o owner desativa/reativa; sessões já pausadas não quebram a desativação', async () => {
    const owner = await newUser(env)
    const admin = await memberOf(env, owner.companyId, 'admin')
    const ids = sessionsFor(owner.companyId, 2)
    await env.gateway.sessions.pause(ids[0])
    expectApiError(await admin.c.delete(`/api/companies/${owner.companyId}`), 'FORBIDDEN', 403)
    expect(await stateOf(ids[1]!)).toBe('STABLE')

    const del = await owner.c.delete(`/api/companies/${owner.companyId}`)
    expect(del.status, del.text).toBe(200)
    expect(await stateOf(ids[1]!)).toBe('PAUSED')
    const re = await admin.c.put(`/api/companies/${owner.companyId}`, { active: true })
    expect(re.status).toBe(403)
  })
})
