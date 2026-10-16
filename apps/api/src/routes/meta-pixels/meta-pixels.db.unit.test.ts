/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Pixels pela API (AC-T104-04): CRUD com pixel_id e token mascarados, token em claro só com include_access_token,
// validação 422, outra empresa → 404 e permissão facebook.pixel.
import { randomBytes } from 'node:crypto'
import { companyMembers, createDb, pixelConfigs, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, generateCredentialsKey, initCredentialsCrypto, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const rnd = () => randomBytes(4).toString('hex')
const TOKEN = 'EAABsbCS1iHgBAexampletokenxyz9'

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `t104-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.104.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
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

beforeAll(async () => {
  initCredentialsCrypto({ key: generateCredentialsKey() })
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }) })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('pixels', () => {
  it('CRUD mascarado; token só com include_access_token; cifrado no banco (AC-T104-04)', async () => {
    const s = await signUp()
    const created = await call(s, 'POST', '/api/meta/pixels', { pixel_config: { name: 'Loja', pixel_id: '123456789012345', access_token: TOKEN, platform: 'facebook' } })
    expect(created.status).toBe(201)
    expect(created.body.pixel).toMatchObject({ name: 'Loja', platform: 'facebook', masked_pixel_id: '***********2345', masked_access_token: 'EAAB***xyz9', auto_send_sales: false })
    const id = created.body.pixel.id

    const list = await call(s, 'GET', '/api/meta/pixels')
    expect(list.status).toBe(200)
    expect(list.body.items).toHaveLength(1)
    expect(list.text).not.toContain(TOKEN)
    expect(list.text).not.toContain('123456789012345')

    const plain = await call(s, 'GET', `/api/meta/pixels/${id}`)
    expect(plain.text).not.toContain(TOKEN)
    const full = await call(s, 'GET', `/api/meta/pixels/${id}?include_access_token=true`)
    expect(full.body.pixel).toMatchObject({ pixel_id: '123456789012345', access_token: TOKEN })

    const [row] = await db.select().from(pixelConfigs).where(eq(pixelConfigs.id, id))
    expect(row!.accessTokenEnc).not.toContain(TOKEN)

    // Edição sem token mantém o atual.
    const upd = await call(s, 'PUT', `/api/meta/pixels/${id}`, { name: 'Loja 2', pixel_id: 987654321, access_token: '', auto_send_sales: true })
    expect(upd.status).toBe(200)
    expect(upd.body.pixel).toMatchObject({ name: 'Loja 2', masked_pixel_id: '*****4321', masked_access_token: 'EAAB***xyz9', auto_send_sales: true })
    expect((await call(s, 'GET', `/api/meta/pixels/${id}?include_access_token=true`)).body.pixel.access_token).toBe(TOKEN)

    expect((await call(s, 'DELETE', `/api/meta/pixels/${id}`)).status).toBe(204)
    expect((await call(s, 'GET', `/api/meta/pixels/${id}`)).status).toBe(404)
  })

  it('validação 422: pixel_id não numérico, nome curto, sem token', async () => {
    const s = await signUp()
    expect((await call(s, 'POST', '/api/meta/pixels', { name: 'Loja', pixel_id: '12ab', access_token: TOKEN })).status).toBe(422)
    expect((await call(s, 'POST', '/api/meta/pixels', { name: 'L', pixel_id: '123', access_token: TOKEN })).status).toBe(422)
    expect((await call(s, 'POST', '/api/meta/pixels', { name: 'Loja', pixel_id: '123', access_token: '' })).status).toBe(422)
    expect((await call(s, 'POST', '/api/meta/pixels', { name: 'Loja', pixel_id: '123', access_token: TOKEN, platform: 'tiktok' })).status).toBe(422)
  })

  it('outra empresa → 404; sem facebook.pixel → 403', async () => {
    const a = await signUp()
    const b = await signUp()
    const id = (await call(a, 'POST', '/api/meta/pixels', { name: 'Loja', pixel_id: '111', access_token: TOKEN })).body.pixel.id
    expect((await call(b, 'GET', `/api/meta/pixels/${id}?include_access_token=true`)).status).toBe(404)
    expect((await call(b, 'PUT', `/api/meta/pixels/${id}`, { name: 'X1' })).status).toBe(404)
    expect((await call(b, 'DELETE', `/api/meta/pixels/${id}`)).status).toBe(404)
    expect((await call(b, 'GET', '/api/meta/pixels')).body.items).toEqual([])

    const u = await signUp()
    await db.insert(companyMembers).values({ companyId: a.companyId, userId: u.userId, role: 'member', permissionKeys: ['chat.view'] })
    await db.update(users).set({ lastCompanyId: a.companyId }).where(eq(users.id, u.userId))
    const noPerm = { ...u, companyId: a.companyId }
    expect((await call(noPerm, 'GET', '/api/meta/pixels')).status).toBe(403)
    expect((await call(noPerm, 'GET', `/api/meta/pixels/${id}?include_access_token=true`)).status).toBe(403)
    expect((await call(noPerm, 'POST', '/api/meta/pixels', { name: 'Loja', pixel_id: '1', access_token: TOKEN })).status).toBe(403)
  })
})
