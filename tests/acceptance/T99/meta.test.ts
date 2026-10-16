// AC-T99-01..05: GraphClient contra o FakeMetaGraph e rotas de OAuth/perfis/contas pela API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_SECRET, VERSION, callback, connectProfile, memberOf, metaUser, owner, proofOf, startEnv, startOauth, type Env } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
}, 120_000)

afterAll(async () => {
  await env?.close()
})

describe('T99 — GraphClient (AC-T99-01)', () => {
  it('AC-T99-01 getAll segue paging.next e junta 3 páginas numa lista', async () => {
    const { GraphClient }: any = await import('@crm/core')
    const mu = metaUser(5) // pageSize 2 → páginas de 2, 2 e 1
    env.fake.addUser(mu)
    const token = env.fake.issueToken(mu.id)
    const before = env.fake.requestsTo('/me/adaccounts').length
    const client = new GraphClient({ graphUrl: env.graphUrl, version: VERSION, appSecret: APP_SECRET, accessToken: token })
    const all = await client.getAll('/me/adaccounts')
    expect(all.map((a: any) => a.id)).toEqual(mu.adAccounts.map((a) => a.id))
    const reqs = env.fake.requestsTo('/me/adaccounts').slice(before)
    expect(reqs).toHaveLength(3)
  })

  it('AC-T99-01 toda requisição leva appsecret_proof = HMAC-SHA256(token, secret) e a versão configurada', async () => {
    const { GraphClient }: any = await import('@crm/core')
    const mu = metaUser(3)
    env.fake.addUser(mu)
    const token = env.fake.issueToken(mu.id)
    const start = env.fake.requests.length
    const client = new GraphClient({ graphUrl: env.graphUrl, version: VERSION, appSecret: APP_SECRET, accessToken: token })
    await client.get('/me')
    await client.getAll('/me/adaccounts')
    const reqs = env.fake.requests.slice(start)
    expect(reqs.length).toBeGreaterThanOrEqual(3)
    for (const r of reqs) {
      expect(r.version, r.path).toBe(VERSION)
      expect(r.path.startsWith(`/${VERSION}/`), r.path).toBe(true)
      expect(r.query.access_token).toBe(token)
      expect(r.query.appsecret_proof, r.path).toBe(proofOf(token))
    }
  })

  it('AC-T99-01 segredo errado → appsecret_proof inválido → MetaGraphError mapeado', async () => {
    const core: any = await import('@crm/core')
    const mu = metaUser(1)
    env.fake.addUser(mu)
    const token = env.fake.issueToken(mu.id)
    const client = new core.GraphClient({ graphUrl: env.graphUrl, version: VERSION, appSecret: 'segredo-errado', accessToken: token })
    const err: any = await client.get('/me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(core.MetaGraphError)
    expect(err.code).toBe(100)
    expect(typeof err.status).toBe('number')
  })
})

describe('T99 — callback OAuth (AC-T99-02)', () => {
  const profilesOf = async (companyId: string) => (await env.q(`SELECT count(*)::int AS n FROM crm.meta_profiles WHERE company_id = $1`, [companyId]))[0].n

  it('AC-T99-02 state adulterado → redirect meta_oauth=error e nenhum perfil criado', async () => {
    const o = await owner(env)
    const mu = metaUser(1)
    env.fake.addUser(mu)
    const state = await startOauth(o)
    const tampered = `${state.slice(0, -4)}${state.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`
    for (const bad of [tampered, 'nao-e-um-state', '']) {
      const cb = await callback(o, { code: env.fake.issueCode(mu.id), state: bad })
      expect(cb.status, bad).toBe(302)
      expect(cb.location).toContain('/facebook/profiles')
      expect(cb.result, bad).toBe('error')
    }
    expect(await profilesOf(o.companyId)).toBe(0)
  })

  it('AC-T99-02 state de outra empresa → meta_oauth=error e nenhum perfil em nenhuma das duas', async () => {
    const a = await owner(env)
    const b = await owner(env)
    const mu = metaUser(1)
    env.fake.addUser(mu)
    const stateOfB = await startOauth(b)
    const cb = await callback(a, { code: env.fake.issueCode(mu.id), state: stateOfB })
    expect(cb.status).toBe(302)
    expect(cb.result).toBe('error')
    expect(await profilesOf(a.companyId)).toBe(0)
    expect(await profilesOf(b.companyId)).toBe(0)
  })

  it('AC-T99-02 usuário negou (error=access_denied) → meta_oauth=error; fluxo válido → success e cria o perfil', async () => {
    const o = await owner(env)
    const state = await startOauth(o)
    const denied = await callback(o, { error: 'access_denied', state })
    expect(denied.result).toBe('error')
    expect(await profilesOf(o.companyId)).toBe(0)
    const profile = await connectProfile(env, o, metaUser(2))
    expect(profile.ad_accounts).toHaveLength(2)
    expect(await profilesOf(o.companyId)).toBe(1)
  })
})

describe('T99 — atualizar contas (AC-T99-03)', () => {
  it('AC-T99-03 refresh-ad-accounts faz upsert sem mudar included_in_dashboard das existentes', async () => {
    const o = await owner(env)
    const mu = metaUser(2)
    const profile = await connectProfile(env, o, mu)
    const [acc1, acc2] = [...profile.ad_accounts].sort((x: any, y: any) => x.fb_account_id.localeCompare(y.fb_account_id))
    // inverte a marcação da conta 1 em relação ao padrão
    const flipped = !acc1.included_in_dashboard
    const put = await o.c.put(`/api/meta/ad-accounts/${acc1.id}`, { included_in_dashboard: flipped })
    expect(put.status, put.text).toBe(200)
    expect(put.body.ad_account.included_in_dashboard).toBe(flipped)

    // na Meta: conta 1 renomeada, conta 2 igual, conta 3 nova
    env.fake.setAdAccounts(mu.id, [
      { id: mu.adAccounts[0]!.id, name: 'Conta 1 renomeada' },
      { id: mu.adAccounts[1]!.id, name: 'Conta 2' },
      { id: `${mu.id}_novo`.replace(/^fbu/, 'act_fbu'), name: 'Conta 3 nova' },
    ])
    const r = await o.c.post(`/api/meta/profiles/${profile.id}/refresh-ad-accounts`, {})
    expect(r.status, r.text).toBe(200)
    const accs = r.body.profile.ad_accounts
    expect(accs).toHaveLength(3)
    const byFb = Object.fromEntries(accs.map((a: any) => [a.fb_account_id, a]))
    expect(byFb[acc1.fb_account_id].included_in_dashboard).toBe(flipped)
    expect(byFb[acc1.fb_account_id].name).toBe('Conta 1 renomeada')
    expect(byFb[acc1.fb_account_id].id).toBe(acc1.id)
    expect(byFb[acc2.fb_account_id].included_in_dashboard).toBe(acc2.included_in_dashboard)
    expect(byFb[acc2.fb_account_id].id).toBe(acc2.id)
    // atualizar de novo é idempotente
    const again = await o.c.post(`/api/meta/profiles/${profile.id}/refresh-ad-accounts`, {})
    expect(again.body.profile.ad_accounts).toHaveLength(3)
    expect(Object.fromEntries(again.body.profile.ad_accounts.map((a: any) => [a.fb_account_id, a.included_in_dashboard]))[acc1.fb_account_id]).toBe(flipped)
  })
})

describe('T99 — sem token nas respostas (AC-T99-04)', () => {
  const PROFILE_KEYS = [
    'active',
    'ad_accounts',
    'ad_accounts_count',
    'ad_accounts_included_count',
    'connected_by_user_id',
    'created_at',
    'fb_user_id',
    'fb_user_name',
    'id',
    'picture_url',
    'token_expires_at',
    'updated_at',
  ]

  it('AC-T99-04 nenhuma resposta de /api/meta/profiles contém o token (snapshot das chaves e busca pelo valor)', async () => {
    const o = await owner(env)
    const start = env.fake.requests.length
    const profile = await connectProfile(env, o, metaUser(2))
    // tokens que de fato circularam até a Meta durante a conexão (curto e longo)
    const tokens = [...new Set(env.fake.requests.slice(start).map((r: any) => r.query?.access_token).filter(Boolean))] as string[]
    expect(tokens.length).toBeGreaterThan(0)

    const responses = [
      await o.c.get('/api/meta/profiles'),
      await o.c.get(`/api/meta/profiles/${profile.id}`),
      await o.c.post(`/api/meta/profiles/${profile.id}/refresh-ad-accounts`, {}),
    ]
    for (const r of responses) {
      expect(r.status, r.text).toBe(200)
      for (const t of tokens) expect(r.text.includes(t), 'token na resposta').toBe(false)
      expect(r.text).not.toMatch(/access_token|token_enc|"token"/)
    }
    const item = responses[0]!.body.items.find((p: any) => p.id === profile.id)
    expect(Object.keys(item).sort()).toEqual(PROFILE_KEYS)
    expect(Object.keys(responses[1]!.body.profile).sort()).toEqual(PROFILE_KEYS)

    // e no banco o token não fica em texto puro
    const [row] = await env.q(`SELECT t::text AS dump FROM crm.meta_profiles t WHERE id = $1`, [profile.id])
    for (const t of tokens) expect(row.dump.includes(t), 'token em texto puro no banco').toBe(false)
  })
})

describe('T99 — permissões de escrita (AC-T99-05)', () => {
  it('AC-T99-05 membro com facebook.profiles mas sem papel owner/admin → só lê; 403 em PUT, DELETE e refresh', async () => {
    const o = await owner(env)
    const profile = await connectProfile(env, o, metaUser(1))
    const acc = profile.ad_accounts[0]
    const reader = await memberOf(env, o.companyId, 'member', ['facebook.profiles'])
    expect((await reader.c.get('/api/meta/profiles')).status).toBe(200)
    for (const [label, r] of [
      ['PUT', await reader.c.put(`/api/meta/ad-accounts/${acc.id}`, { included_in_dashboard: false })],
      ['refresh', await reader.c.post(`/api/meta/profiles/${profile.id}/refresh-ad-accounts`, {})],
      ['DELETE', await reader.c.delete(`/api/meta/profiles/${profile.id}`)],
    ] as const) {
      expect(r.status, label).toBe(403)
      expect(r.body.error.code).toBe('FORBIDDEN')
    }
    // nada mudou
    const still = (await o.c.get(`/api/meta/profiles/${profile.id}`)).body.profile
    expect(still.ad_accounts[0].included_in_dashboard).toBe(acc.included_in_dashboard)
  })

  it('AC-T99-05 membro sem facebook.profiles → 403 também na leitura e nas escritas', async () => {
    const o = await owner(env)
    const profile = await connectProfile(env, o, metaUser(1))
    const nobody = await memberOf(env, o.companyId, 'member', ['contacts.view'])
    expect((await nobody.c.get('/api/meta/profiles')).status).toBe(403)
    expect((await nobody.c.put(`/api/meta/ad-accounts/${profile.ad_accounts[0].id}`, { included_in_dashboard: false })).status).toBe(403)
    expect((await nobody.c.post(`/api/meta/profiles/${profile.id}/refresh-ad-accounts`, {})).status).toBe(403)
    expect((await nobody.c.delete(`/api/meta/profiles/${profile.id}`)).status).toBe(403)
  })

  it('AC-T99-05 admin da empresa (matriz padrão) pode escrever; perfil de outra empresa → 404', async () => {
    const o = await owner(env)
    const profile = await connectProfile(env, o, metaUser(1))
    const adm = await memberOf(env, o.companyId, 'admin', null)
    const put = await adm.c.put(`/api/meta/ad-accounts/${profile.ad_accounts[0].id}`, { included_in_dashboard: !profile.ad_accounts[0].included_in_dashboard })
    expect(put.status, put.text).toBe(200)
    const stranger = await owner(env)
    expect((await stranger.c.get(`/api/meta/profiles/${profile.id}`)).status).toBe(404)
    expect((await stranger.c.delete(`/api/meta/profiles/${profile.id}`)).status).toBe(404)
    expect((await o.c.delete(`/api/meta/profiles/${profile.id}`)).status).toBe(204)
  })
})
