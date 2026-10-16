/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Meta pela API contra o FakeMetaGraph (AC-T99-02..05): OAuth start/callback, state inválido ou de outra empresa,
// refresh preservando `included_in_dashboard`, nenhum token nas respostas e permissões de gestão.
import { randomBytes } from 'node:crypto'
import { FakeMetaGraph } from '@crm/core/meta-testing'
import { companyMembers, createDb, metaAdAccounts, metaProfiles, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, generateCredentialsKey, initCredentialsCrypto, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const fake = new FakeMetaGraph({ appId: 'app-t99', appSecret: 'secret-t99', pageSize: 2 })
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const WEB = 'http://web.test'
const REDIRECT = 'http://api.test/api/meta/oauth/callback'
const rnd = () => randomBytes(4).toString('hex')

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `t99-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.99.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id, userId: user.id }
}
const call = async (s: Session, method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, text, body: text ? (JSON.parse(text) as any) : {} }
}
/** Callback como o navegador volta da Meta (GET com o cookie). */
const callback = async (s: Session, query: Record<string, string>) => {
  const res = await app.request(`/api/meta/oauth/callback?${new URLSearchParams(query)}`, { headers: { cookie: s.cookie } })
  return { status: res.status, location: new URL(res.headers.get('location') ?? 'http://x/') }
}
const stateOf = (oauthUrl: string) => new URL(oauthUrl).searchParams.get('state')!

/** Conecta um perfil: start → code do fake → callback. */
async function connect(s: Session, fbUser: string): Promise<any> {
  const start = await call(s, 'POST', '/api/meta/oauth/start', {})
  expect(start.status).toBe(200)
  const cb = await callback(s, { code: fake.issueCode(fbUser, REDIRECT), state: stateOf(start.body.oauth_url) })
  expect(cb.location.searchParams.get('meta_oauth')).toBe('success')
  return ((await call(s, 'GET', '/api/meta/profiles')).body.items as any[]).find((p) => p.fb_user_id === fbUser)
}

beforeAll(async () => {
  initCredentialsCrypto({ key: generateCredentialsKey() })
  const { url } = await fake.start()
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    metaConfig: { appId: fake.appId, appSecret: fake.appSecret, graphUrl: url, version: 'v26.0', redirectUri: REDIRECT, webUrl: WEB, dialogUrl: 'https://www.facebook.com' },
  })
}, 120_000)

afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('OAuth', () => {
  it('start devolve a URL do diálogo com state; callback troca o code, grava o perfil e as contas e volta com success', async () => {
    const s = await signUp()
    fake.addUser({ id: 'fb-ana', name: 'Ana Meta', pictureUrl: 'https://p/ana.jpg', adAccounts: [{ id: 'act_11', name: 'Loja', currency: 'BRL', account_status: 1 }, { id: 'act_12' }, { id: 'act_13', name: 'Outra' }] })
    const start = await call(s, 'POST', '/api/meta/oauth/start', {})
    const dialog = new URL(start.body.oauth_url)
    expect(dialog.origin + dialog.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth')
    expect(dialog.searchParams.get('client_id')).toBe('app-t99')
    expect(dialog.searchParams.get('redirect_uri')).toBe(REDIRECT)
    const cb = await callback(s, { code: fake.issueCode('fb-ana', REDIRECT), state: stateOf(start.body.oauth_url) })
    expect(cb.status).toBe(302)
    expect(`${cb.location.origin}${cb.location.pathname}`).toBe(`${WEB}/facebook/profiles`)
    expect(cb.location.searchParams.get('meta_oauth')).toBe('success')
    const [profile] = (await call(s, 'GET', '/api/meta/profiles')).body.items
    expect(profile).toMatchObject({ fb_user_id: 'fb-ana', fb_user_name: 'Ana Meta', picture_url: 'https://p/ana.jpg', active: true, ad_accounts_count: 3, ad_accounts_included_count: 0 })
    expect(profile.token_expires_at).toEqual(expect.any(String))
    expect(profile.ad_accounts.map((a: any) => [a.fb_account_id, a.included_in_dashboard])).toEqual(
      expect.arrayContaining([
        ['act_11', false],
        ['act_12', false],
        ['act_13', false],
      ]),
    )
    // Token só cifrado no banco; a troca pediu o token longo e toda chamada com token levou appsecret_proof.
    const [row] = await db.select().from(metaProfiles).where(eq(metaProfiles.id, profile.id))
    expect(row!.accessTokenEnc).toMatch(/^v\d+\./)
    expect(fake.requestsTo('/oauth/access_token').map((r) => r.query.grant_type ?? 'code')).toEqual(['code', 'fb_exchange_token'])
    for (const r of fake.requests.filter((r) => r.query.access_token)) expect(r.query.appsecret_proof).toMatch(/^[0-9a-f]{64}$/)
  })

  it('AC-T99-02: state inválido, adulterado, de outro usuário/empresa ou ausente → meta_oauth=error e nenhum perfil criado', async () => {
    const a = await signUp()
    const b = await signUp()
    fake.addUser({ id: 'fb-bia', name: 'Bia', adAccounts: [{ id: 'act_21' }] })
    const startB = await call(b, 'POST', '/api/meta/oauth/start', {})
    const stateB = stateOf(startB.body.oauth_url)
    const queries: Record<string, string>[] = [
      { code: fake.issueCode('fb-bia', REDIRECT), state: 'lixo' },
      { code: fake.issueCode('fb-bia', REDIRECT), state: `${stateB.split('.')[0]}x.${stateB.split('.')[1]}` },
      { code: fake.issueCode('fb-bia', REDIRECT), state: stateB }, // state da empresa B no callback da empresa A
      { code: fake.issueCode('fb-bia', REDIRECT) },
      { error: 'access_denied', error_description: 'Usuário cancelou', state: stateB },
    ]
    for (const query of queries) {
      const cb = await callback(a, query)
      expect(cb.status).toBe(302)
      expect(cb.location.searchParams.get('meta_oauth')).toBe('error')
    }
    expect(await db.select().from(metaProfiles).where(eq(metaProfiles.companyId, a.companyId))).toEqual([])
    // O mesmo state na sessão certa funciona.
    expect((await callback(b, { code: fake.issueCode('fb-bia', REDIRECT), state: stateB })).location.searchParams.get('meta_oauth')).toBe('success')
  })
})

describe('perfis e contas', () => {
  it('AC-T99-03: refresh faz upsert das contas sem mudar included_in_dashboard das existentes', async () => {
    const s = await signUp()
    fake.addUser({ id: 'fb-caio', name: 'Caio', adAccounts: [{ id: 'act_31', name: 'A' }, { id: 'act_32', name: 'B' }] })
    const profile = await connect(s, 'fb-caio')
    const a31 = profile.ad_accounts.find((a: any) => a.fb_account_id === 'act_31')
    const put = await call(s, 'PUT', `/api/meta/ad-accounts/${a31.id}`, { meta_ad_account: { included_in_dashboard: true } })
    expect(put.body.ad_account).toMatchObject({ id: a31.id, included_in_dashboard: true })

    fake.setAdAccounts('fb-caio', [{ id: 'act_31', name: 'A renomeada' }, { id: 'act_32', name: 'B' }, { id: 'act_33', name: 'Nova' }])
    const refreshed = (await call(s, 'POST', `/api/meta/profiles/${profile.id}/refresh-ad-accounts`, {})).body.profile
    const byId = Object.fromEntries(refreshed.ad_accounts.map((a: any) => [a.fb_account_id, a]))
    expect(byId.act_31).toMatchObject({ id: a31.id, name: 'A renomeada', included_in_dashboard: true })
    expect(byId.act_32.included_in_dashboard).toBe(false)
    expect(byId.act_33).toMatchObject({ name: 'Nova', included_in_dashboard: false })
    expect(refreshed).toMatchObject({ ad_accounts_count: 3, ad_accounts_included_count: 1 })
  })

  it('AC-T99-04: nenhuma resposta de /api/meta/profiles contém o token', async () => {
    const s = await signUp()
    fake.addUser({ id: 'fb-dani', name: 'Dani', adAccounts: [{ id: 'act_41' }] })
    const profile = await connect(s, 'fb-dani')
    const tokens = fake.requests.map((r) => r.query.access_token).filter(Boolean)
    const responses = [
      await call(s, 'GET', '/api/meta/profiles'),
      await call(s, 'GET', `/api/meta/profiles/${profile.id}`),
      await call(s, 'POST', `/api/meta/profiles/${profile.id}/refresh-ad-accounts`, {}),
    ]
    for (const r of responses) {
      expect(r.status).toBe(200)
      for (const t of tokens) expect(r.text).not.toContain(t)
      expect(r.text).not.toMatch(/access_token|accessToken|token_enc/i)
    }
    // "Snapshot" das chaves do perfil.
    expect(Object.keys(responses[1]!.body.profile).sort()).toEqual(
      ['ad_accounts', 'ad_accounts_count', 'ad_accounts_included_count', 'active', 'connected_by_user_id', 'created_at', 'fb_user_id', 'fb_user_name', 'id', 'picture_url', 'token_expires_at', 'updated_at'].sort(),
    )
  })

  it('remover apaga o perfil e as contas; outra empresa → 404', async () => {
    const s = await signUp()
    const other = await signUp()
    fake.addUser({ id: 'fb-edu', name: 'Edu', adAccounts: [{ id: 'act_51' }] })
    const profile = await connect(s, 'fb-edu')
    expect((await call(other, 'GET', `/api/meta/profiles/${profile.id}`)).status).toBe(404)
    expect((await call(other, 'DELETE', `/api/meta/profiles/${profile.id}`)).status).toBe(404)
    expect((await call(other, 'PUT', `/api/meta/ad-accounts/${profile.ad_accounts[0].id}`, { included_in_dashboard: true })).status).toBe(404)
    expect((await call(s, 'DELETE', `/api/meta/profiles/${profile.id}`)).status).toBe(204)
    expect(await db.select().from(metaAdAccounts).where(eq(metaAdAccounts.profileId, profile.id))).toEqual([])
  })

  it('AC-T99-05: sem facebook.profiles → 403; com a permissão mas papel member → lê, porém 403 em PUT/DELETE/refresh/start', async () => {
    const owner = await signUp()
    fake.addUser({ id: 'fb-fabi', name: 'Fabi', adAccounts: [{ id: 'act_61' }] })
    const profile = await connect(owner, 'fb-fabi')
    const join = async (permissionKeys: string[] | null, role: 'member' | 'admin' = 'member') => {
      const u = await signUp()
      await db.insert(companyMembers).values({ companyId: owner.companyId, userId: u.userId, role, permissionKeys })
      await db.update(users).set({ lastCompanyId: owner.companyId }).where(eq(users.id, u.userId))
      return { ...u, companyId: owner.companyId }
    }
    const writes = (s: Session) => [
      call(s, 'PUT', `/api/meta/ad-accounts/${profile.ad_accounts[0].id}`, { included_in_dashboard: true }),
      call(s, 'POST', `/api/meta/profiles/${profile.id}/refresh-ad-accounts`, {}),
      call(s, 'DELETE', `/api/meta/profiles/${profile.id}`),
      call(s, 'POST', '/api/meta/oauth/start', {}),
    ]
    const noPerm = await join(['chat.view'])
    expect((await call(noPerm, 'GET', '/api/meta/profiles')).status).toBe(403)
    for (const r of await Promise.all(writes(noPerm))) expect(r.status).toBe(403)

    const memberWithPerm = await join(['facebook.profiles'])
    expect((await call(memberWithPerm, 'GET', '/api/meta/profiles')).status).toBe(200)
    for (const r of await Promise.all(writes(memberWithPerm))) expect(r.status).toBe(403)
    // Callback com membro sem papel de gestão: volta com erro.
    const start = await call(owner, 'POST', '/api/meta/oauth/start', {})
    expect((await callback(memberWithPerm, { code: fake.issueCode('fb-fabi', REDIRECT), state: stateOf(start.body.oauth_url) })).location.searchParams.get('meta_oauth')).toBe('error')

    const admin = await join(null, 'admin')
    expect((await call(admin, 'PUT', `/api/meta/ad-accounts/${profile.ad_accounts[0].id}`, { included_in_dashboard: true })).status).toBe(200)
  })

  it('token revogado na Meta: refresh responde 409 meta_token_invalid e o perfil fica inativo', async () => {
    const s = await signUp()
    fake.addUser({ id: 'fb-gil', name: 'Gil', adAccounts: [{ id: 'act_71' }] })
    const profile = await connect(s, 'fb-gil')
    for (const t of new Set(fake.requests.map((r) => r.query.access_token).filter(Boolean))) fake.revokeToken(t!)
    const r = await call(s, 'POST', `/api/meta/profiles/${profile.id}/refresh-ad-accounts`, {})
    expect([r.status, r.body.error.details.error_code]).toEqual([409, 'meta_token_invalid'])
    expect((await call(s, 'GET', `/api/meta/profiles/${profile.id}`)).body.profile.active).toBe(false)
  })
})
