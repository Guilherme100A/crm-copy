// AC-T97-03 pela API: GET /api/app-config devolve a URL do portal de afiliados lida do ambiente a cada request
// (contrato do Prumo, spec/reports/T97-entrega.md: createApp({ appConfigEnv }), autenticada, só http/https).
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64')

let tmp: TempDatabase
let db: Any
let redis: Any
let api: Any
/** Ambiente mutável lido pela rota a cada request. */
const env: Record<string, string | undefined> = {}
let app: Any
let c: ReturnType<typeof createClient>

beforeAll(async () => {
  api = await import('@crm/api')
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  redis = redisConnection()
  redis.on?.('error', () => {})
  app = api.createApp({ db, redis, mailer: new MemoryMailer(), waGateway: new FakeWaGateway(), trustProxy: true, appConfigEnv: env })
  c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', '10.97.0.1')
      return app.request(path, { ...init, headers })
    },
  })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t97')
  const reg = await c.post('/api/auth/register', { name: `Empresa ${uniqueId('t97')}`, email, password, password_confirmation: password })
  expect(reg.status, reg.text).toBeLessThan(300)
  const login = await c.post('/api/auth/login', { email, password })
  expect(login.status, login.text).toBe(200)
  c.setCompany(login.body.companies[0].id)
}, 120_000)

afterAll(async () => {
  await Promise.resolve(api?.stopRealtimeHub?.(redis)).catch(() => {})
  await Promise.resolve(redis?.quit?.()).catch(() => redis?.disconnect?.())
  await db?.$client.end().catch(() => {})
  await tmp?.drop()
}, 60_000)

describe('T97 — GET /api/app-config (AC-T97-03)', () => {
  it('AC-T97-03 sem sessão → 401', async () => {
    env.AFFILIATE_PORTAL_URL = 'https://parceiros.example.test/r'
    expect((await app.request('/api/app-config')).status).toBe(401)
  })

  it('AC-T97-03 com AFFILIATE_PORTAL_URL definida devolve a URL; sem a variável devolve null (relido a cada request)', async () => {
    env.AFFILIATE_PORTAL_URL = 'https://parceiros.example.test/register?src=crm'
    const on = await c.get('/api/app-config')
    expect(on.status, on.text).toBe(200)
    expect(new URL(on.body.affiliate_portal_url).toString()).toBe('https://parceiros.example.test/register?src=crm')

    delete env.AFFILIATE_PORTAL_URL
    const off = await c.get('/api/app-config')
    expect(off.status).toBe(200)
    expect(off.body.affiliate_portal_url).toBeNull()

    env.AFFILIATE_PORTAL_URL = ''
    expect((await c.get('/api/app-config')).body.affiliate_portal_url).toBeNull()
  })

  it('AC-T97-03 URL que não é http/https conta como ausente', async () => {
    for (const bad of ['javascript:alert(1)', 'ftp://parceiros.example.test', 'nao-e-url', '/relativa']) {
      env.AFFILIATE_PORTAL_URL = bad
      const res = await c.get('/api/app-config')
      expect(res.status).toBe(200)
      expect(res.body.affiliate_portal_url, bad).toBeNull()
    }
    env.AFFILIATE_PORTAL_URL = 'http://parceiros.example.test'
    expect((await c.get('/api/app-config')).body.affiliate_portal_url).toMatch(/^http:\/\/parceiros\.example\.test\/?$/)
  })
})
