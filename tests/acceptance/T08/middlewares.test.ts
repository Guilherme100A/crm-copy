// AC-T08-02..06 — auth por sessão, empresa ativa, permissões, erros/validação, auditoria e CSRF.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uuid } from '../helpers/factories'
import { addMember, clientFor, createSession, type Env, PROBE, seedCompany, seedMember, seedUser, startEnv } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

describe('T08 — sessionAuth', () => {
  it('AC-T08-02 /api/* sem sessão → 401 UNAUTHORIZED', async () => {
    expectApiError(await clientFor(env).get(`${PROBE}/whoami`), 'UNAUTHORIZED', 401)
    expectApiError(await clientFor(env).post(`${PROBE}/items`, { name: 'x' }), 'UNAUTHORIZED', 401)
  })

  it('AC-T08-02 /api/* inexistente sem sessão também → 401 (auth antes do 404)', async () => {
    expectApiError(await clientFor(env).get('/api/nao-existe-t08'), 'UNAUTHORIZED', 401)
  })

  it('AC-T08-02 cookie com token desconhecido → 401', async () => {
    expectApiError(await clientFor(env, 'token-que-nao-existe').get(`${PROBE}/whoami`), 'UNAUTHORIZED', 401)
  })

  it('AC-T08-02 sessão válida → 200 (sanidade)', async () => {
    const { token, userId } = await seedMember(env)
    const res = await clientFor(env, token).get(`${PROBE}/whoami`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.user_id).toBe(userId)
  })

  it('AC-T08-02 cookie de sessão revogada → 401', async () => {
    const { companyId } = await seedMember(env)
    const userId = await seedUser(env, companyId)
    await addMember(env, companyId, userId, 'admin')
    const token = await createSession(env, userId, 'revoked')
    expectApiError(await clientFor(env, token).get(`${PROBE}/whoami`), 'UNAUTHORIZED', 401)
  })

  it('AC-T08-02 cookie de sessão expirada → 401', async () => {
    const { companyId } = await seedMember(env)
    const userId = await seedUser(env, companyId)
    await addMember(env, companyId, userId, 'admin')
    const token = await createSession(env, userId, 'expired')
    expectApiError(await clientFor(env, token).get(`${PROBE}/whoami`), 'UNAUTHORIZED', 401)
  })

  it('AC-T08-02 sessão revogada depois de usada passa a dar 401', async () => {
    const { token, userId } = await seedMember(env)
    expect((await clientFor(env, token).get(`${PROBE}/whoami`)).status).toBe(200)
    await env.q(`UPDATE crm.auth_sessions SET revoked_at = now() WHERE user_id = $1`, [userId])
    expectApiError(await clientFor(env, token).get(`${PROBE}/whoami`), 'UNAUTHORIZED', 401)
  })
})

describe('T08 — companyContext', () => {
  it('AC-T08-03 X-Company-Id de empresa da qual o usuário não é membro → 404 NOT_FOUND', async () => {
    const { token } = await seedMember(env)
    const other = await seedCompany(env)
    expectApiError(await clientFor(env, token, other).get(`${PROBE}/whoami`), 'NOT_FOUND', 404)
  })

  it('AC-T08-03 X-Company-Id inexistente → 404 NOT_FOUND', async () => {
    const { token } = await seedMember(env)
    expectApiError(await clientFor(env, token, uuid()).get(`${PROBE}/whoami`), 'NOT_FOUND', 404)
  })

  it('AC-T08-03 sem header, vale last_company_id', async () => {
    const companyA = await seedCompany(env)
    const companyB = await seedCompany(env)
    const userId = await seedUser(env, companyB)
    await addMember(env, companyA, userId, 'owner')
    await addMember(env, companyB, userId, 'member')
    const token = await createSession(env, userId)
    const res = await clientFor(env, token).get(`${PROBE}/whoami`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.company_id).toBe(companyB)
    expect(res.body.role).toBe('member')
  })

  it('AC-T08-03 X-Company-Id de empresa da qual é membro prevalece sobre last_company_id', async () => {
    const companyA = await seedCompany(env)
    const companyB = await seedCompany(env)
    const userId = await seedUser(env, companyB)
    await addMember(env, companyA, userId, 'owner')
    await addMember(env, companyB, userId, 'member')
    const token = await createSession(env, userId)
    const res = await clientFor(env, token, companyA).get(`${PROBE}/whoami`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.company_id).toBe(companyA)
    expect(res.body.role).toBe('owner')
  })
})

describe('T08 — requirePerm', () => {
  it("AC-T08-04 requirePerm('contacts.edit') → 403 FORBIDDEN para membro sem a chave", async () => {
    const { token } = await seedMember(env, 'member', ['chat.view'])
    expectApiError(await clientFor(env, token).get(`${PROBE}/contacts`), 'FORBIDDEN', 403)
    expectApiError(await clientFor(env, token).post(`${PROBE}/contacts`, {}), 'FORBIDDEN', 403)
  })

  it("AC-T08-04 requirePerm('contacts.edit') → 2xx para owner", async () => {
    const { token } = await seedMember(env, 'owner')
    const get = await clientFor(env, token).get(`${PROBE}/contacts`)
    expect(get.status, get.text).toBeGreaterThanOrEqual(200)
    expect(get.status).toBeLessThan(300)
    const post = await clientFor(env, token).post(`${PROBE}/contacts`, {})
    expect(post.status, post.text).toBe(201)
  })

  it("AC-T08-04 membro com a chave explícita 'contacts.edit' → 2xx", async () => {
    const { token } = await seedMember(env, 'member', ['contacts.edit'])
    const res = await clientFor(env, token).get(`${PROBE}/contacts`)
    expect(res.status, res.text).toBe(200)
  })
})

describe('T08 — erros e validação', () => {
  it('AC-T08-05 corpo inválido → 422 VALIDATION_ERROR com details.fields[].path', async () => {
    const { token } = await seedMember(env)
    const res = await clientFor(env, token).post(`${PROBE}/validate`, { name: 'x', items: [{ qty: 0 }] })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    const fields = res.body.error.details?.fields
    expect(Array.isArray(fields), res.text).toBe(true)
    const paths = fields.map((f: { path: unknown }) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))
    expect(paths).toContain('name')
    expect(paths.some((p: string) => /^items\.0\.qty$|^items\[0\]\.qty$/.test(p)), `paths: ${paths.join(', ')}`).toBe(true)
    for (const f of fields) expect(typeof f.message).toBe('string')
  })

  it('AC-T08-05 corpo válido passa pelo validate → 200 (sanidade)', async () => {
    const { token } = await seedMember(env)
    const res = await clientFor(env, token).post(`${PROBE}/validate`, { name: 'ok', items: [{ qty: 2 }] })
    expect(res.status, res.text).toBe(200)
  })

  it('AC-T08-05 JSON malformado → 400 MALFORMED_REQUEST', async () => {
    const { token } = await seedMember(env)
    // corpo enviado à mão: o helper só serializa objetos válidos
    const raw = await env.app.request(`${PROBE}/validate`, {
      method: 'POST',
      headers: { cookie: `crm_session=${token}`, 'x-requested-with': 'crm', 'content-type': 'application/json' },
      body: '{"name": "abc", "items": [',
    })
    const text = await raw.text()
    expect(raw.status, text).toBe(400)
    expect(JSON.parse(text).error.code).toBe('MALFORMED_REQUEST')
  })

  it('AC-T08-05 erro não tratado → 500 INTERNAL sem stack na resposta', async () => {
    const { token } = await seedMember(env)
    const res = await clientFor(env, token).get(`${PROBE}/boom`)
    expectApiError(res, 'INTERNAL', 500)
    expect(res.text).not.toMatch(/\n\s+at |\bat .+\.(ts|js):\d+|stack/i)
    expect(res.text).not.toContain('T08-BOOM-INTERNAL-DETAIL')
  })

  it('AC-T08-05 rota /api inexistente autenticada → 404 NOT_FOUND no formato padrão', async () => {
    const { token } = await seedMember(env)
    expectApiError(await clientFor(env, token).get('/api/nao-existe-t08'), 'NOT_FOUND', 404)
  })
})

describe('T08 — auditoria e CSRF', () => {
  const SECRETS = ['SENHA-T08-BODY', 'TOKEN-T08-BODY', 'APIKEY-T08-DETAIL']

  it('AC-T08-06 mutação bem-sucedida grava audit_logs com company_id, actor_user_id e action, sem segredos', async () => {
    const { token, userId, companyId } = await seedMember(env)
    const res = await clientFor(env, token).post(`${PROBE}/items`, {
      name: 'Item visível',
      password: 'SENHA-T08-BODY',
      token: 'TOKEN-T08-BODY',
    })
    expect(res.status, res.text).toBe(201)
    const rows = await env.q(`SELECT * FROM crm.audit_logs WHERE actor_user_id = $1`, [userId])
    expect(rows.length, 'nenhuma linha em audit_logs').toBeGreaterThanOrEqual(1)
    const row = rows[0]
    expect(row.company_id).toBe(companyId)
    expect(row.actor_user_id).toBe(userId)
    expect(typeof row.action).toBe('string')
    expect(row.action.length).toBeGreaterThan(0)
    const dump = JSON.stringify(rows)
    for (const s of SECRETS) expect(dump, `audit_logs contém ${s}`).not.toContain(s)
    expect(dump).not.toContain(token)
  })

  it('AC-T08-06 GET e mutação que falha não gravam auditoria', async () => {
    const { token, userId } = await seedMember(env, 'member', ['chat.view'])
    await clientFor(env, token).get(`${PROBE}/whoami`)
    expect((await clientFor(env, token).post(`${PROBE}/contacts`, {})).status).toBe(403)
    const rows = await env.q(`SELECT id FROM crm.audit_logs WHERE actor_user_id = $1`, [userId])
    expect(rows).toHaveLength(0)
  })

  it('AC-T08-06 POST de navegador (cookie) sem X-Requested-With: crm → 403 e nada é gravado', async () => {
    const { token, userId } = await seedMember(env)
    const res = await env.app.request(`${PROBE}/items`, {
      method: 'POST',
      headers: { cookie: `crm_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sem csrf' }),
    })
    const text = await res.text()
    expect(res.status, text).toBe(403)
    expect(JSON.parse(text).error.code).toBe('FORBIDDEN')
    const rows = await env.q(`SELECT id FROM crm.audit_logs WHERE actor_user_id = $1`, [userId])
    expect(rows).toHaveLength(0)
  })

  it('AC-T08-06 X-Requested-With com valor diferente de "crm" → 403', async () => {
    const { token } = await seedMember(env)
    const res = await env.app.request(`${PROBE}/items`, {
      method: 'POST',
      headers: { cookie: `crm_session=${token}`, 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(403)
  })

  it('AC-T08-06 mesmo POST com X-Requested-With: crm → 2xx', async () => {
    const { token } = await seedMember(env)
    const res = await env.app.request(`${PROBE}/items`, {
      method: 'POST',
      headers: { cookie: `crm_session=${token}`, 'content-type': 'application/json', 'x-requested-with': 'crm' },
      body: JSON.stringify({ name: 'com csrf' }),
    })
    expect(res.status, await res.text()).toBe(201)
  })
})
