// T91: /api/auth/profile e /api/auth/login trazem companies[].effective_permissions, o mesmo cálculo que o servidor
// aplica (lista explícita do membro; sem ela, a matriz do papel).
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companyMembers, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { DEFAULT_ROLE_PERMISSIONS } from '@crm/shared'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const rnd = () => randomBytes(4).toString('hex')

async function signUp() {
  const email = `ep-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.91.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'E', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { user, cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], login: (await login.json()) as Json }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }) })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('effective_permissions no perfil', () => {
  it('owner: a matriz do owner; membro com lista explícita: só a lista (+ sempre concedidas)', async () => {
    const owner = await signUp()
    const ownerCompany = owner.login.companies[0]
    expect(new Set(ownerCompany.effective_permissions)).toEqual(new Set(DEFAULT_ROLE_PERMISSIONS.owner))

    const member = await signUp()
    await db.insert(companyMembers).values({ companyId: ownerCompany.id, userId: member.user.id, role: 'member', permissionKeys: ['chat.view', 'flows.view'] })
    await db.update(users).set({ lastCompanyId: ownerCompany.id }).where(eq(users.id, member.user.id))
    const profile = (await (await app.request('/api/auth/profile', { headers: { ...H, cookie: member.cookie } })).json()) as Json
    const there = profile.companies.find((c: Json) => c.id === ownerCompany.id)
    expect(there.role).toBe('member')
    expect(there.effective_permissions).toContain('chat.view')
    expect(there.effective_permissions).toContain('flows.view')
    expect(there.effective_permissions).not.toContain('flows.run')
    // a própria empresa do membro continua com a matriz de owner
    expect(profile.companies.find((c: Json) => c.id !== ownerCompany.id).effective_permissions).toContain('flows.run')
  })
})
