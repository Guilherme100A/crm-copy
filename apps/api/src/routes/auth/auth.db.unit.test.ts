import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companies, companyMembers, createDb, passwordResets, userProfiles, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let storage: string
let app: ReturnType<typeof createApp>
const mailer = new MemoryMailer({ from: 'no-reply@example.com' })

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => (await r.json()) as Json
const rnd = () => randomBytes(4).toString('hex')
const ipHeader = () => ({ 'x-forwarded-for': `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` })
const JSON_H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

function post(path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  return app.request(path, { method, headers: { ...JSON_H, ...headers }, body: JSON.stringify(body) })
}

function sessionCookie(res: Response): string {
  const m = /crm_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('sem cookie')
  return `crm_session=${m[1]}`
}

async function register(email: string, extra: Record<string, unknown> = {}) {
  return post('/api/auth/register', { name: 'Ana', email, password: 's3nha-forte', password_confirmation: 's3nha-forte', ...extra })
}

async function login(email: string, password = 's3nha-forte', headers: Record<string, string> = ipHeader()) {
  return post('/api/auth/login', { email, password }, headers)
}

async function signedIn(email = `u${rnd()}@x.com`) {
  expect((await register(email)).status).toBe(201)
  const res = await login(email)
  return { email, cookie: sessionCookie(res), body: await json(res) }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  storage = await mkdtemp(join(tmpdir(), 't15-avatars-'))
  app = createApp({
    db,
    redis,
    mailer,
    blobStore: new FsBlobStore(storage),
    trustProxy: true,
    appName: 'CRM Teste',
    webPublicUrl: 'http://web.test',
    logger: createLogger({ level: 'silent' }),
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
  await rm(storage, { recursive: true, force: true })
})

describe('AC-T15-01 login', () => {
  it('correto → 200, cookie httpOnly e { user, companies }', async () => {
    const email = `l${rnd()}@x.com`
    await register(email)
    const res = await login(email.toUpperCase())
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/crm_session=.+HttpOnly.*SameSite=Lax/i)
    const body = await json(res)
    expect(body.user).toMatchObject({ email, system_role: 'user', locale: 'pt-BR', avatar_url: null })
    expect(body.user).not.toHaveProperty('password_hash')
    expect(body.companies).toEqual([expect.objectContaining({ name: 'Minha empresa', role: 'owner' })])
  })

  it('senha errada e e-mail inexistente → 401 com a mesma mensagem', async () => {
    const email = `w${rnd()}@x.com`
    await register(email)
    const a = await login(email, 'errada-123')
    const b = await login(`nao-existe-${rnd()}@x.com`, 'errada-123')
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    const [ea, eb] = [(await json(a)).error, (await json(b)).error]
    expect(ea).toEqual(eb)
    expect(ea.code).toBe('UNAUTHORIZED')
  })

  it('10 falhas em 15 min → a 11ª é 429 mesmo com a senha certa; outro IP não é afetado', async () => {
    const email = `r${rnd()}@x.com`
    await register(email)
    const ip = ipHeader()
    for (let i = 0; i < 10; i++) expect((await login(email, 'errada-123', ip)).status).toBe(401)
    const blocked = await login(email, 's3nha-forte', ip)
    expect(blocked.status).toBe(429)
    expect((await json(blocked)).error.code).toBe('RATE_LIMIT')
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await login(email, 's3nha-forte', ipHeader())).status).toBe(200)
  })
})

describe('AC-T15-02 cadastro', () => {
  it('cria usuário user, empresa "Minha empresa" e vínculo owner', async () => {
    const email = `c${rnd()}@x.com`
    const res = await register(email, { personal_whatsapp: '+55 (11) 99999-0000' })
    expect(res.status).toBe(201)
    const { user } = await json(res)
    expect(user).toMatchObject({ email, system_role: 'user', personal_whatsapp: '5511999990000' })
    const [member] = await db
      .select({ role: companyMembers.role, name: companies.name, id: companies.id })
      .from(companyMembers)
      .innerJoin(companies, eq(companies.id, companyMembers.companyId))
      .where(eq(companyMembers.userId, user.id))
    expect(member).toMatchObject({ role: 'owner', name: 'Minha empresa' })
    expect(user.last_company_id).toBe(member!.id)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('e-mail repetido em qualquer caixa → 409', async () => {
    const email = `d${rnd()}@x.com`
    await register(email)
    const res = await register(email.toUpperCase())
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('CONFLICT')
  })

  it('senha < 8 ou confirmação diferente → 422', async () => {
    const short = await post('/api/auth/register', { name: 'A', email: `s${rnd()}@x.com`, password: '1234567', password_confirmation: '1234567' })
    expect(short.status).toBe(422)
    expect((await json(short)).error.details.fields.map((f: Json) => f.path)).toContain('password')
    const diff = await post('/api/auth/register', { name: 'A', email: `s${rnd()}@x.com`, password: '12345678', password_confirmation: '12345679' })
    expect(diff.status).toBe(422)
    expect((await json(diff)).error.details.fields.map((f: Json) => f.path)).toContain('password_confirmation')
  })

  it('referral_code válido vai para user_profiles.referred_by_code (sem unique); inválido é ignorado', async () => {
    const a = await json(await register(`ra${rnd()}@x.com`, { referral_code: 'afiliado_1' }))
    const b = await json(await register(`rb${rnd()}@x.com`, { referral_code: 'afiliado_1' }))
    const bad = await register(`rc${rnd()}@x.com`, { referral_code: 'tem espaço!' })
    expect(bad.status).toBe(201)
    const c = await json(bad)
    const rows = await db.select().from(userProfiles)
    const code = (id: string) => rows.find((r) => r.userId === id)?.referredByCode
    expect(code(a.user.id)).toBe('afiliado_1')
    expect(code(b.user.id)).toBe('afiliado_1')
    expect(code(c.user.id)).toBeNull()
    const [u] = await db.select({ referralCode: users.referralCode }).from(users).where(eq(users.id, a.user.id))
    expect(u!.referralCode).toBeNull()
  })

  it('aceita o envelope { user: {…} } e rewardful_referral', async () => {
    const res = await post('/api/auth/register', {
      user: { name: 'E', email: `e${rnd()}@x.com`, password: '12345678', password_confirmation: '12345678' },
      rewardful_referral: 'rw-1',
    })
    expect(res.status).toBe(201)
    const { user } = await json(res)
    const [p] = await db.select().from(userProfiles).where(eq(userProfiles.userId, user.id))
    expect(p!.referredByCode).toBe('rw-1')
  })
})

describe('AC-T15-03 logout', () => {
  it('revoga a sessão: o mesmo cookie depois → 401', async () => {
    const { cookie } = await signedIn()
    expect((await app.request('/api/auth/profile', { headers: { cookie } })).status).toBe(200)
    const out = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie, 'x-requested-with': 'crm' } })
    expect(out.status).toBe(200)
    expect((await app.request('/api/auth/profile', { headers: { cookie } })).status).toBe(401)
  })
})

describe('AC-T15-04 redefinição de senha', () => {
  const tokenFrom = (to: string) => {
    const m = mailer.last(to)
    expect(m?.subject).toContain('CRM Teste')
    const link = /http:\/\/web\.test\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(m!.text!)
    expect(m!.html).toContain(link![0])
    return link![1]!
  }

  it('resposta neutra para e-mail inexistente e existente; só o existente recebe e-mail', async () => {
    const { email } = await signedIn()
    const before = mailer.messages.length
    const a = await post('/api/auth/password-resets', { email: `x${rnd()}@x.com` })
    expect(mailer.messages.length).toBe(before)
    const b = await post('/api/auth/password-resets', { email: email.toUpperCase() })
    expect(a.status).toBe(200)
    expect(await json(a)).toEqual(await json(b))
    expect(mailer.messages.length).toBe(before + 1)
  })

  it('token vale uma vez; troca a senha e derruba as sessões', async () => {
    const { email, cookie } = await signedIn()
    await post('/api/auth/password-resets', { email })
    const token = tokenFrom(email)
    expect(await json(await app.request(`/api/auth/password-resets/${token}`))).toEqual({ valid: true })
    const body = { password: 'nova-senha-1', password_confirmation: 'nova-senha-1' }
    expect((await post(`/api/auth/password-resets/${token}`, body, {}, 'PATCH')).status).toBe(200)
    expect((await post(`/api/auth/password-resets/${token}`, body, {}, 'PATCH')).status).toBe(410)
    expect(await json(await app.request(`/api/auth/password-resets/${token}`))).toEqual({ valid: false, reason: 'used' })
    expect((await app.request('/api/auth/profile', { headers: { cookie } })).status).toBe(401)
    expect((await login(email, 'nova-senha-1')).status).toBe(200)
    expect((await login(email)).status).toBe(401)
  })

  it('expirado → GET { valid:false, reason:"expired" } e PATCH 410; desconhecido → invalid', async () => {
    const { email } = await signedIn()
    await post('/api/auth/password-resets', { email })
    const token = tokenFrom(email)
    await db.update(passwordResets).set({ expiresAt: sql`now() - interval '1 minute'` })
    expect(await json(await app.request(`/api/auth/password-resets/${token}`))).toEqual({ valid: false, reason: 'expired' })
    const res = await post(`/api/auth/password-resets/${token}`, { password: 'nova-senha-1', password_confirmation: 'nova-senha-1' }, {}, 'PATCH')
    expect(res.status).toBe(410)
    expect((await json(res)).error.code).toBe('GONE')
    expect(await json(await app.request('/api/auth/password-resets/nada'))).toEqual({ valid: false, reason: 'invalid' })
  })
})

describe('AC-T15-05 perfil', () => {
  const put = (cookie: string, body: unknown) => post('/api/auth/profile', body, { cookie }, 'PUT')

  it('trocar e-mail sem current_password correto → 422 current_password_invalid', async () => {
    const { cookie, email } = await signedIn()
    for (const body of [{ email: `n${rnd()}@x.com` }, { email: `n${rnd()}@x.com`, current_password: 'errada-123' }]) {
      const res = await put(cookie, body)
      expect(res.status).toBe(422)
      const { error } = await json(res)
      expect(error.code).toBe('VALIDATION_ERROR')
      expect(error.details.error_code).toBe('current_password_invalid')
    }
    // mesmo e-mail com outra caixa não conta como troca
    expect((await put(cookie, { email: email.toUpperCase(), name: 'Novo' })).status).toBe(200)
    const novo = `n${rnd()}@x.com`
    const ok = await put(cookie, { email: novo, current_password: 's3nha-forte' })
    expect(ok.status).toBe(200)
    expect((await json(ok)).user.email).toBe(novo)
  })

  it('locale: pt_BR é sinônimo, inválido vira pt-BR, en/es mantidos', async () => {
    const { cookie } = await signedIn()
    expect((await json(await put(cookie, { locale: 'en' }))).user.locale).toBe('en')
    expect((await json(await put(cookie, { locale: 'xx' }))).user.locale).toBe('pt-BR')
    await put(cookie, { locale: 'es' })
    expect((await json(await put(cookie, { user: { locale: 'pt_BR' } }))).user.locale).toBe('pt-BR')
    const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.email, (await json(await app.request('/api/auth/profile', { headers: { cookie } }))).user.email))
    expect(row!.locale).toBe('pt-BR')
  })

  it('troca de senha exige current_password', async () => {
    const { cookie, email } = await signedIn()
    expect((await put(cookie, { password: 'outra-senha', password_confirmation: 'outra-senha' })).status).toBe(422)
    expect((await put(cookie, { password: 'outra-senha', password_confirmation: 'outra-senha', current_password: 's3nha-forte' })).status).toBe(200)
    expect((await login(email, 'outra-senha')).status).toBe(200)
  })
})

describe('AC-T15-06 avatar', () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const JPEG = [0xff, 0xd8, 0xff, 0xe0]
  const WEBP = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]
  const GIF = [...Buffer.from('GIF89a')]
  const image = (sig: number[], size: number) => {
    const b = new Uint8Array(size)
    b.set(sig)
    return b
  }
  const upload = (cookie: string, bytes: Uint8Array, type: string) => {
    const form = new FormData()
    form.append('avatar', new File([bytes], 'a.bin', { type }))
    return app.request('/api/auth/profile/avatar', { method: 'POST', headers: { cookie, 'x-requested-with': 'crm' }, body: form })
  }

  it('jpeg/png/webp até 5 MB aceitos e servidos', async () => {
    const { cookie } = await signedIn()
    for (const [sig, type] of [
      [JPEG, 'image/jpeg'],
      [WEBP, 'image/webp'],
      [PNG, 'image/png'],
    ] as const) {
      const res = await upload(cookie, image([...sig], 1024), type)
      expect(res.status).toBe(200)
      expect((await json(res)).user.avatar_url).toMatch(/^\/api\/auth\/avatars\/[a-f0-9]{64}$/)
    }
    const max = await upload(cookie, image(PNG, 5 * 1024 * 1024), 'image/png')
    expect(max.status).toBe(200)
    const url = (await json(max)).user.avatar_url as string
    const served = await app.request(url, { headers: { cookie } })
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect((await served.arrayBuffer()).byteLength).toBe(5 * 1024 * 1024)
  })

  it('6 MB → 413; gif → 415 (mesmo declarando image/png)', async () => {
    const { cookie } = await signedIn()
    const big = await upload(cookie, image(PNG, 6 * 1024 * 1024), 'image/png')
    expect(big.status).toBe(413)
    expect((await json(big)).error.code).toBe('PAYLOAD_TOO_LARGE')
    const gif = await upload(cookie, image(GIF, 1024), 'image/png')
    expect(gif.status).toBe(415)
    expect((await json(gif)).error.code).toBe('UNSUPPORTED_MEDIA')
  })

  it('DELETE zera o avatar', async () => {
    const { cookie } = await signedIn()
    await upload(cookie, image(PNG, 100), 'image/png')
    const res = await app.request('/api/auth/profile/avatar', { method: 'DELETE', headers: { cookie, 'x-requested-with': 'crm' } })
    expect(res.status).toBe(200)
    expect((await json(res)).user.avatar_url).toBeNull()
  })
})

describe('tokens de API', () => {
  it('owner cria crm_pat_ que autentica; membro comum → 403', async () => {
    const { cookie } = await signedIn()
    const res = await post('/api/auth/api-tokens', { name: 'integração' }, { cookie })
    expect(res.status).toBe(201)
    const created = await json(res)
    expect(created.token).toMatch(/^crm_pat_/)
    const me = await app.request('/api/auth/api-tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(me.status).toBe(403) // token de API não cria outro token

    const other = await signedIn()
    const [co] = await db.select({ id: users.lastCompanyId }).from(users).where(eq(users.email, other.email))
    const memberEmail = `m${rnd()}@x.com`
    const m = await signedIn(memberEmail)
    const [mu] = await db.select({ id: users.id }).from(users).where(eq(users.email, memberEmail))
    await db.insert(companyMembers).values({ companyId: co!.id!, userId: mu!.id, role: 'member' })
    const denied = await post('/api/auth/api-tokens', { name: 'x' }, { cookie: m.cookie, 'x-company-id': co!.id! })
    expect(denied.status).toBe(403)
  })
})
