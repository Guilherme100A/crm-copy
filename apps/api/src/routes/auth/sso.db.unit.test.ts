// SSO do painel do ai-manager (`POST /api/auth/sso`): token válido, expirado, aud errada, assinatura errada, jti
// repetido e rota desligada sem CRM_SSO_SECRET.
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signSsoToken } from '@crm/core'
import { auditLogs, companies, companyMembers, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createApp, type RedisClient } from '../../app'

const SECRET = randomBytes(32).toString('base64url')
let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
let appOff: ReturnType<typeof createApp>
const now = Math.floor(Date.now() / 1000)

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const JSON_H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const rnd = () => randomBytes(4).toString('hex')

function claims(over: Record<string, unknown> = {}) {
  const { username = `op${rnd()}`, ...rest } = over as { username?: string } & Record<string, unknown>
  return {
    iss: 'ai-manager',
    aud: 'crm',
    sub: `ai-manager:${username}`,
    name: username,
    email: `${username}@ai-manager.local`,
    iat: now,
    exp: now + 120,
    jti: randomUUID(),
    ...rest,
  }
}

const sso = (token: string, target = app) => target.request('/api/auth/sso', { method: 'POST', headers: JSON_H, body: JSON.stringify({ token }) })
const errorCode = async (res: Response) => ((await res.json()) as Json).error?.details?.error_code

function cookieOf(res: Response): string {
  const m = /crm_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('sem cookie')
  return `crm_session=${m[1]}`
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  const base = { db, redis, mailer: new MemoryMailer({ from: 'no-reply@example.com' }), trustProxy: true, logger: createLogger({ level: 'silent' }) }
  app = createApp({ ...base, ssoSecret: SECRET, ssoNowSec: () => now })
  appOff = createApp({ ...base, ssoSecret: '' })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('POST /api/auth/sso', () => {
  it('token válido → 200, cookie de sessão igual ao do login, usuário e empresa "ai-manager" (owner) criados', async () => {
    const c = claims({ username: `admin${rnd()}` })
    const res = await sso(signSsoToken(c, SECRET))
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/crm_session=.+HttpOnly.*SameSite=Lax/i)
    const body = (await res.json()) as Json
    expect(body.user.email).toBe(c.email)
    expect(body.user.name).toBe(c.name)
    expect(body.companies).toHaveLength(1)
    expect(body.companies[0]).toMatchObject({ name: 'ai-manager', slug: 'ai-manager', role: 'owner' })
    expect(body.user.last_company_id).toBe(body.companies[0].id)

    // A sessão vale nos mesmos guards do login normal.
    const profile = await app.request('/api/auth/profile', { headers: { cookie: cookieOf(res) } })
    expect(profile.status).toBe(200)
    expect(((await profile.json()) as Json).user.email).toBe(c.email)

    // Auditoria do login por SSO.
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'auth.sso'), eq(auditLogs.actorUserId, body.user.id)))
    expect(log).toBeDefined()
    expect(log!.detail).toMatchObject({ sub: c.sub, jti: c.jti, user_created: true, role: 'owner' })
  })

  it('mesmo usuário de novo reaproveita conta e empresa; outro usuário entra como admin com todas as permissões', async () => {
    const username = `ana${rnd()}`
    const first = (await (await sso(signSsoToken(claims({ username }), SECRET))).json()) as Json
    const again = await sso(signSsoToken(claims({ username }), SECRET))
    expect(again.status).toBe(200)
    const body = (await again.json()) as Json
    expect(body.user.id).toBe(first.user.id)
    const same = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${`${username}@ai-manager.local`}`)
    expect(same).toHaveLength(1)
    expect(await db.select().from(companies).where(eq(companies.slug, 'ai-manager'))).toHaveLength(1)
    const company = body.companies.find((x: Json) => x.slug === 'ai-manager')
    expect(company.role).toBe('admin')
    // admin com a lista explícita do owner: inclui permissões que o admin padrão não tem.
    expect(company.effective_permissions).toContain('settings.platform_invitations.delete')
    const owners = await db
      .select()
      .from(companyMembers)
      .where(and(eq(companyMembers.companyId, company.id), eq(companyMembers.role, 'owner')))
    expect(owners).toHaveLength(1)
  })

  it('jti repetido → 401 sso_replayed (uso único)', async () => {
    const token = signSsoToken(claims(), SECRET)
    expect((await sso(token)).status).toBe(200)
    const res = await sso(token)
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('sso_replayed')
  })

  it('expirado → 401 sso_expired; dentro da tolerância de relógio ainda entra', async () => {
    const res = await sso(signSsoToken(claims({ iat: now - 400, exp: now - 280 }), SECRET))
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('sso_expired')
    // 10 s depois do exp ainda passa (tolerância de 30 s).
    expect((await sso(signSsoToken(claims({ iat: now - 130, exp: now - 10 }), SECRET))).status).toBe(200)
  })

  it('aud errada → 401 sso_bad_audience; iss errado → 401 sso_bad_issuer', async () => {
    const a = await sso(signSsoToken(claims({ aud: 'outra-coisa' }), SECRET))
    expect(a.status).toBe(401)
    expect(await errorCode(a)).toBe('sso_bad_audience')
    const i = await sso(signSsoToken(claims({ iss: 'evil' }), SECRET))
    expect(i.status).toBe(401)
    expect(await errorCode(i)).toBe('sso_bad_issuer')
  })

  it('assinatura errada → 401 sso_bad_signature, sem cookie e sem criar usuário', async () => {
    const c = claims()
    const res = await sso(signSsoToken(c, 'outro-segredo'))
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('sso_bad_signature')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await db.select().from(users).where(sql`lower(${users.email}) = ${c.email}`)).toHaveLength(0)
  })

  it('alg none → 401 sso_bad_alg; lixo → 401 sso_malformed; corpo sem token → 422', async () => {
    const r1 = await sso(signSsoToken(claims(), SECRET, { alg: 'none', typ: 'JWT' }))
    expect(r1.status).toBe(401)
    expect(await errorCode(r1)).toBe('sso_bad_alg')
    const r2 = await sso('abc.def')
    expect(r2.status).toBe(401)
    expect(await errorCode(r2)).toBe('sso_malformed')
    const r3 = await app.request('/api/auth/sso', { method: 'POST', headers: JSON_H, body: '{}' })
    expect(r3.status).toBe(422)
  })

  it('token recusado não consome o jti (o mesmo jti num token válido ainda entra)', async () => {
    const c = claims()
    expect((await sso(signSsoToken({ ...c, aud: 'x' }, SECRET))).status).toBe(401)
    expect((await sso(signSsoToken(c, SECRET))).status).toBe(200)
  })

  it('sem CRM_SSO_SECRET → 404 (rota desligada), mesmo com token bem assinado', async () => {
    const res = await sso(signSsoToken(claims(), SECRET), appOff)
    expect(res.status).toBe(404)
  })

  it('sem o header CSRF → 403 (mesma regra das outras mutações do navegador)', async () => {
    const res = await app.request('/api/auth/sso', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: signSsoToken(claims(), SECRET) }),
    })
    expect(res.status).toBe(403)
  })
})
