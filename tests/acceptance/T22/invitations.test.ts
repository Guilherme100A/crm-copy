// AC-T22-04: limite de reenvio (3/dia), convite expirado → 410, aceite cria membership com o papel, token só como hash.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { fakeEmail } from '../helpers/factories'
import { client, errorCode, login, mailsTo, newPassword, newUser, rolesOf, sha256Hex, startEnv, tokenFromLink, type Env, type User } from './setup'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

async function invite(owner: User, email: string, role: 'member' | 'admin' = 'member') {
  const res = await owner.c.post('/api/team/invitations', { kind: 'member', email, role })
  expect(res.status, res.text).toBe(201)
  expect(typeof res.body.invitation_link).toBe('string')
  return { id: res.body.invitation.id as string, token: tokenFromLink(res.body.invitation_link), body: res.body }
}

describe('AC-T22-04 reenvio de convite', () => {
  it('AC-T22-04 até 3 reenvios no dia; o 4º → 429 com resends_remaining_today: 0', async () => {
    const owner = await newUser(env)
    const inv = await invite(owner, fakeEmail('t22inv'))
    const remaining: number[] = []
    for (let i = 1; i <= 3; i++) {
      const r = await owner.c.post(`/api/team/invitations/${inv.id}/resend`)
      expect(r.status, `reenvio ${i}: ${r.text}`).toBe(200)
      remaining.push(r.body.invitation.resends_remaining_today)
    }
    expect(remaining).toEqual([2, 1, 0])
    const fourth = await owner.c.post(`/api/team/invitations/${inv.id}/resend`)
    expectApiError(fourth, 'RATE_LIMIT', 429)
    expect(fourth.body.error.details.resends_remaining_today).toBe(0)
    expect(errorCode(fourth)).toBe('resend_limit')

    const list = await owner.c.get('/api/team/invitations?kind=member')
    expect(list.status, list.text).toBe(200)
    const item = list.body.items.find((x: any) => x.id === inv.id)
    expect(item.resends_remaining_today).toBe(0)
    expect(item.can_resend).toBe(false)
    expect(list.body.status_counts.pending).toBeGreaterThanOrEqual(1)
  })

  it('AC-T22-04 cada convite tem seu próprio limite diário', async () => {
    const owner = await newUser(env)
    const a = await invite(owner, fakeEmail('t22a'))
    const b = await invite(owner, fakeEmail('t22b'))
    for (let i = 0; i < 3; i++) expect((await owner.c.post(`/api/team/invitations/${a.id}/resend`)).status).toBe(200)
    expect((await owner.c.post(`/api/team/invitations/${a.id}/resend`)).status).toBe(429)
    const rb = await owner.c.post(`/api/team/invitations/${b.id}/resend`)
    expect(rb.status, rb.text).toBe(200)
    expect(rb.body.invitation.resends_remaining_today).toBe(2)
  })
})

describe('AC-T22-04 aceite de convite', () => {
  it('AC-T22-04 aceitar convite expirado → 410 GONE e nenhuma membership é criada', async () => {
    const owner = await newUser(env)
    const guest = await newUser(env)
    const inv = await invite(owner, guest.email, 'admin')
    await env.q(`UPDATE crm.invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [inv.id])
    expectApiError(await guest.c.post(`/api/invitations/${inv.token}/accept`), 'GONE', 410)
    expect((await rolesOf(env, owner.companyId))[guest.userId]).toBeUndefined()
  })

  it('AC-T22-04 aceitar (logado com o e-mail do convite) cria a membership com o papel do convite', async () => {
    const owner = await newUser(env)
    const guest = await newUser(env)
    const inv = await invite(owner, guest.email, 'admin')
    const pub = await client(env).get(`/api/invitations/${inv.token}`)
    expect(pub.status, pub.text).toBe(200)
    expect(pub.body.invitation).toMatchObject({ role: 'admin', status: 'pending' })

    const acc = await guest.c.post(`/api/invitations/${inv.token}/accept`)
    expect(acc.status, acc.text).toBe(200)
    expect(acc.body.role).toBe('admin')
    expect(acc.body.company.id).toBe(owner.companyId)
    expect((await rolesOf(env, owner.companyId))[guest.userId]).toBe('admin')

    guest.c.setCompany(owner.companyId)
    const team = await guest.c.get('/api/team')
    expect(team.status, team.text).toBe(200)
    expect(team.body.items.find((x: any) => x.user_id === guest.userId)?.role).toBe('admin')

    // não dá para aceitar de novo
    expectApiError(await guest.c.post(`/api/invitations/${inv.token}/accept`), 'GONE', 410)
  })

  it('AC-T22-04 aceitar sem login com cadastro cria o usuário e a membership com o papel (member)', async () => {
    const owner = await newUser(env)
    const email = fakeEmail('t22novo')
    const inv = await invite(owner, email, 'member')
    const password = newPassword()
    const anon = client(env)
    const acc = await anon.post(`/api/invitations/${inv.token}/accept`, { name: 'Pessoa Convidada', password, password_confirmation: password })
    expect(acc.status, acc.text).toBe(200)
    expect(acc.body.role).toBe('member')
    const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
    expect(u, 'usuário não foi criado no aceite').toBeTruthy()
    expect((await rolesOf(env, owner.companyId))[u.id]).toBe('member')
    // já sai logado e pode também logar com a senha escolhida
    const companies = await anon.get('/api/companies')
    expect(companies.status, companies.text).toBe(200)
    expect(companies.body.items.map((x: any) => x.id)).toContain(owner.companyId)
    await login(env, email, password)
  })

  it('AC-T22-04 aceitar sem login e sem cadastro → 401', async () => {
    const owner = await newUser(env)
    const inv = await invite(owner, fakeEmail('t22anon'))
    expectApiError(await client(env).post(`/api/invitations/${inv.token}/accept`), 'UNAUTHORIZED', 401)
  })

  it('AC-T22-04 convite cancelado não pode ser aceito', async () => {
    const owner = await newUser(env)
    const guest = await newUser(env)
    const inv = await invite(owner, guest.email)
    expect((await owner.c.post(`/api/team/invitations/${inv.id}/cancel`)).status).toBe(200)
    const res = await guest.c.post(`/api/invitations/${inv.token}/accept`)
    expect([404, 410]).toContain(res.status)
    expect((await rolesOf(env, owner.companyId))[guest.userId]).toBeUndefined()
  })
})

describe('AC-T22-04 token só como hash', () => {
  it('AC-T22-04 o banco guarda só o sha256 do token; o token cru não aparece em nenhuma coluna', async () => {
    const owner = await newUser(env)
    const guest = await newUser(env)
    const email = guest.email
    const inv = await invite(owner, email)
    expect(inv.token.length).toBeGreaterThanOrEqual(16)
    // consultar e aceitar pelo token (rotas públicas auditadas) também não pode deixar o token no banco
    expect((await client(env).get(`/api/invitations/${inv.token}`)).status).toBe(200)
    expect((await guest.c.post(`/api/invitations/${inv.token}/accept`)).status).toBe(200)
    const [row] = await env.q(`SELECT token_hash, row_to_json(i)::text AS all_cols FROM crm.invitations i WHERE id = $1`, [inv.id])
    expect(row.token_hash).toBe(sha256Hex(inv.token))
    expect(row.all_cols.includes(inv.token)).toBe(false)
    // nenhuma linha de nenhuma tabela crm.* contém o token cru (auditoria inclusa)
    const tables = await env.q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'crm' AND table_type = 'BASE TABLE'`)
    for (const t of tables) {
      const [hit] = await env.q(`SELECT count(*)::int AS n FROM crm."${t.table_name}" x WHERE row_to_json(x)::text LIKE '%' || $1 || '%'`, [inv.token])
      expect(hit.n, `token cru encontrado em crm.${t.table_name}`).toBe(0)
    }
    // a listagem também não expõe o token
    const list = await owner.c.get('/api/team/invitations')
    expect(list.text.includes(inv.token)).toBe(false)
    // o e-mail do convite traz o link com o token
    const mail = mailsTo(env, email).at(-1)
    expect(`${mail?.text ?? ''}${mail?.html ?? ''}`).toContain(inv.token)
  })

  it('AC-T22-04 reenvio gera token novo: o anterior deixa de valer e o novo vale', async () => {
    const owner = await newUser(env)
    const guest = await newUser(env)
    const inv = await invite(owner, guest.email, 'member')
    const r = await owner.c.post(`/api/team/invitations/${inv.id}/resend`)
    expect(r.status, r.text).toBe(200)
    const fresh = tokenFromLink(r.body.invitation_link)
    expect(fresh).not.toBe(inv.token)
    const [row] = await env.q(`SELECT token_hash FROM crm.invitations WHERE id = $1`, [inv.id])
    expect(row.token_hash).toBe(sha256Hex(fresh))
    expectApiError(await client(env).get(`/api/invitations/${inv.token}`), 'NOT_FOUND', 404)
    expect((await guest.c.post(`/api/invitations/${fresh}/accept`)).status).toBe(200)
  })
})
