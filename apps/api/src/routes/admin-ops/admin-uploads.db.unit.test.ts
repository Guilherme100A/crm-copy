/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Upload global de imagem do admin (T100, AC-T100-03): `POST /api/admin/uploads` (platform_admin, multipart, só imagem,
// ≤ 2 MB) devolve uma URL http(s) pública, servida sem sessão por `GET /api/public/admin-media/:id`.
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditLogs, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
let storageDir: string
let blobStore: FsBlobStore
const H = { 'x-requested-with': 'crm' }
const rnd = () => randomBytes(4).toString('hex')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)])

interface Session {
  cookie: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `t100-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.100.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const json = { ...H, ...ip, 'content-type': 'application/json' }
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }),
  })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], userId: user.id }
}
async function platformAdmin(): Promise<Session> {
  const s = await signUp()
  await db.update(users).set({ systemRole: 'platform_admin' }).where(eq(users.id, s.userId))
  return s
}
async function upload(s: Session | null, data: Uint8Array | null, type = 'image/png', name = 'banner.png') {
  const form = new FormData()
  if (data) form.set('file', new File([data], name, { type }))
  const res = await app.request('http://api.test/api/admin/uploads', {
    method: 'POST',
    headers: { ...H, ...(s ? { cookie: s.cookie } : {}) },
    body: form,
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  storageDir = await mkdtemp(join(tmpdir(), 't100-blobs-'))
  blobStore = new FsBlobStore({ dir: storageDir })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    realtimePublisher: { publish: async () => undefined } as never,
    blobStore,
    adminOps: { env: {}, mediaSigningKey: randomBytes(32), mediaMaxBytes: 4096 },
  })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
  if (storageDir) await rm(storageDir, { recursive: true, force: true })
})

describe('POST /api/admin/uploads (AC-T100-03)', () => {
  it('sem platform_admin → 403; sem sessão → 401', async () => {
    const owner = await signUp()
    expect((await upload(owner, PNG)).status).toBe(403)
    expect((await upload(null, PNG)).status).toBe(401)
  })

  it('platform_admin envia PNG → 201 com URL http(s) pública e auditoria global', async () => {
    const admin = await platformAdmin()
    const r = await upload(admin, PNG)
    expect(r.status).toBe(201)
    expect(r.body.url).toMatch(/^http:\/\/api\.test\/api\/public\/admin-media\/[a-f0-9]{64}\.[A-Za-z0-9_-]{22}$/)
    expect(r.body).toMatchObject({ mime: 'image/png', size: PNG.length })
    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'admin.upload.create')).orderBy(desc(auditLogs.createdAt)).limit(1)
    expect(row?.companyId).toBeNull()
    expect(row?.detail).toMatchObject({ admin: true, global: true, mime: 'image/png' })
  })

  it('tipo inválido, bytes que não são imagem e acima do teto → 422 em `file`', async () => {
    const admin = await platformAdmin()
    const pdf = await upload(admin, Buffer.from('%PDF-1.4 ...'), 'application/pdf', 'x.pdf')
    expect(pdf.status).toBe(422)
    expect(pdf.body.error.details.fields[0].path).toBe('file')
    // declarado como PNG, mas não é
    expect((await upload(admin, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png')).status).toBe(422)
    // SVG nunca (documento ativo servido sem sessão)
    expect((await upload(admin, Buffer.from('<svg/>'), 'image/svg+xml', 'x.svg')).status).toBe(422)
    const big = Buffer.concat([PNG, Buffer.alloc(5000)])
    const tooBig = await upload(admin, big)
    expect(tooBig.status).toBe(422)
    expect(tooBig.body.error.details.fields[0].path).toBe('file')
    expect((await upload(admin, null)).status).toBe(422)
  })

  it('usa API_PUBLIC_URL como base quando definida', async () => {
    const a2 = createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      logger: createLogger({ level: 'silent' }),
      realtimePublisher: { publish: async () => undefined } as never,
      blobStore,
      adminOps: { env: { API_PUBLIC_URL: 'https://api.exemplo.com/' }, mediaSigningKey: randomBytes(32) },
    })
    const admin = await platformAdmin()
    const form = new FormData()
    form.set('file', new File([PNG], 'b.png', { type: 'image/png' }))
    const res = await a2.request('/api/admin/uploads', { method: 'POST', headers: { ...H, cookie: admin.cookie }, body: form })
    expect(res.status).toBe(201)
    expect(((await res.json()) as any).url).toMatch(/^https:\/\/api\.exemplo\.com\/api\/public\/admin-media\//)
  })
})

describe('GET /api/public/admin-media/:id (AC-T100-03)', () => {
  it('serve a imagem sem sessão, com tipo real e cache imutável', async () => {
    const admin = await platformAdmin()
    const { body } = await upload(admin, PNG)
    const res = await app.request(new URL(body.url).pathname)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('id sem assinatura válida → 404 (blobs de chat/avatar no mesmo store não vazam)', async () => {
    const other = await blobStore.put(Buffer.concat([PNG, Buffer.from('chat')]), 'image/png')
    expect((await app.request(`/api/public/admin-media/${other.key}.${'A'.repeat(22)}`)).status).toBe(404)
    expect((await app.request(`/api/public/admin-media/${other.key}`)).status).toBe(404)
    expect((await app.request('/api/public/admin-media/..%2F..%2Fetc')).status).toBe(404)
  })
})
