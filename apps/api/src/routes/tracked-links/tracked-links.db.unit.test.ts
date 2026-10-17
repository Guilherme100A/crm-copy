/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON lidas como dados soltos */
// Revisão 3 pela API: campos novos do pixel, "Eventos enviados" (diagnóstico), CRUD dos links rastreáveis e o link
// público `/api/w/:slug` (302 direto, sem sessão, sem vazar dados, rate limit por IP).
import { randomBytes } from 'node:crypto'
import { CapiService } from '@crm/core'
import { FakeMetaGraph } from '@crm/core/meta-testing'
import { connections, createDb, trackedLinkClicks, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, generateCredentialsKey, initCredentialsCrypto, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const fake = new FakeMetaGraph()
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const rnd = () => randomBytes(4).toString('hex')
const TOKEN = 'EAABsbCS1iHgBAexampletokenxyz9'

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `rev3-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.33.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
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
  await fake.start()
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }), trackedLinkRateLimit: { limit: 3, windowMs: 60_000 } })
}, 120_000)

afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('pixel (revisão 3)', () => {
  it('page_id, WABA id, test_event_code, país e Lead automático; validação; diagnóstico de eventos com filtros', async () => {
    const s = await signUp()
    const created = await call(s, 'POST', '/api/meta/pixels', {
      name: 'Loja',
      pixel_id: '123456789012345',
      access_token: TOKEN,
      page_id: '105222333444555',
      whatsapp_business_account_id: '',
      test_event_code: 'TEST4242',
      default_country: 'PT',
      auto_lead_on_ad: true,
    })
    expect(created.status).toBe(201)
    expect(created.body.pixel).toMatchObject({ page_id: '105222333444555', whatsapp_business_account_id: null, test_event_code: 'TEST4242', default_country: 'pt', auto_lead_on_ad: true, business_messaging: null })
    const id = created.body.pixel.id
    expect((await call(s, 'PUT', `/api/meta/pixels/${id}`, { page_id: 'abc' })).status).toBe(422)
    expect((await call(s, 'PUT', `/api/meta/pixels/${id}`, { default_country: 'brasil' })).status).toBe(422)
    expect((await call(s, 'PUT', `/api/meta/pixels/${id}`, { test_event_code: 'tem espaço' })).status).toBe(422)
    expect((await call(s, 'PUT', `/api/meta/pixels/${id}`, { test_event_code: null })).body.pixel.test_event_code).toBeNull()

    fake.addPixel('123456789012345', TOKEN)
    const capi = new CapiService({ db, graphUrl: fake.url, testEventCode: null })
    await capi.send({ companyId: s.companyId, pixelConfigId: id, eventName: 'Lead', eventId: 'api-1', user: { phone: '+5511999998888' }, source: 'manual' })
    await capi.send({ companyId: s.companyId, pixelConfigId: id, eventName: 'Purchase', eventId: 'api-2', value: 10, eventTime: new Date(Date.now() - 8 * 86400_000), source: 'sale' })
    const ev = await call(s, 'GET', `/api/meta/pixels/${id}/events?limit=10`)
    expect(ev.status).toBe(200)
    expect(ev.body.page).toMatchObject({ total_count: 2 })
    expect(ev.body.summary).toMatchObject({ sent: 1, discarded: 1 })
    expect(ev.body.items.find((i: any) => i.event_id === 'api-1')).toMatchObject({ status: 'sent', mode: 'chat', identifiers: ['country', 'ph'], match_score: 1, match_level: 'low' })
    expect(ev.text).not.toContain('5511999998888')
    expect((await call(s, 'GET', `/api/meta/pixels/${id}/events?status=discarded`)).body.items.map((i: any) => i.event_id)).toEqual(['api-2'])
    expect((await call(s, 'GET', `/api/meta/pixels/${id}/events?status=xyz`)).status).toBe(422)
    const other = await signUp()
    expect((await call(other, 'GET', `/api/meta/pixels/${id}/events`)).status).toBe(404)
  })
})

describe('links rastreáveis', () => {
  it('CRUD, 302 direto com fbc/UTM gravados, 404 genérico, inativo, sem sessão e rate limit por IP', async () => {
    const s = await signUp()
    const [conn] = await db.insert(connections).values({ companyId: s.companyId, sessionId: `s-${rnd()}`, name: 'Loja', phoneNumber: '5511988887777' }).returning()
    const slug = `promo-${rnd()}`
    const created = await call(s, 'POST', '/api/meta/tracked-links', { name: 'Promo', slug, connection_id: conn!.id, message: 'Quero a promo', utm_source: 'facebook' })
    expect(created.status).toBe(201)
    expect(created.body.link).toMatchObject({ slug, path: `/api/w/${slug}`, code_mode: 'visible', probable_match: false, stats: { clicks: 0 } })
    expect((await call(s, 'POST', '/api/meta/tracked-links', { name: 'Dup', slug, connection_id: conn!.id })).status).toBe(409)
    expect((await call(s, 'POST', '/api/meta/tracked-links', { name: 'Sem destino' })).status).toBe(422)

    const ip = { 'x-forwarded-for': `10.77.${Math.floor(Math.random() * 250)}.1` }
    const res = await app.request(`/api/w/${slug}?fbclid=IwAR-api-test-123&utm_campaign=bf&ad_id=120200001`, { headers: { ...ip, 'user-agent': 'Mozilla/5.0 Test' } })
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location')!)
    expect(loc.host).toBe('wa.me')
    expect(loc.pathname).toBe('/5511988887777')
    expect(loc.searchParams.get('text')).toMatch(/^Quero a promo \(ref [A-Z2-9]{6}\)$/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const [click] = await db.select().from(trackedLinkClicks).where(eq(trackedLinkClicks.linkId, created.body.link.id))
    expect(click).toMatchObject({ utmSource: 'facebook', utmCampaign: 'bf', adId: '120200001', userAgent: 'Mozilla/5.0 Test', clientIp: ip['x-forwarded-for'] })
    expect(click!.fbc).toMatch(/^fb\.1\.\d{13}\.IwAR-api-test-123$/)

    const missing = await app.request('/api/w/nao-existe-xyz', { headers: { 'x-forwarded-for': '10.78.0.1' } })
    expect(missing.status).toBe(404)
    const missingText = await missing.text()
    expect(missingText).not.toContain(s.companyId)
    expect(missingText).not.toContain('5511')

    expect((await call(s, 'PUT', `/api/meta/tracked-links/${created.body.link.id}`, { active: false })).body.link.active).toBe(false)
    expect((await app.request(`/api/w/${slug}`, { headers: { 'x-forwarded-for': '10.78.0.2' } })).status).toBe(404)
    await call(s, 'PUT', `/api/meta/tracked-links/${created.body.link.id}`, { active: true, code_mode: 'off' })
    const noCode = await app.request(`/api/w/${slug}`, { headers: { 'x-forwarded-for': '10.78.0.3' } })
    expect(new URL(noCode.headers.get('location')!).searchParams.get('text')).toBe('Quero a promo')

    // Rate limit por IP (3/min no teste).
    const rl = { 'x-forwarded-for': '10.79.0.9' }
    for (let i = 0; i < 3; i++) expect((await app.request(`/api/w/${slug}`, { headers: rl })).status).toBe(302)
    const limited = await app.request(`/api/w/${slug}`, { headers: rl })
    expect(limited.status).toBe(429)

    const listed = await call(s, 'GET', '/api/meta/tracked-links')
    expect(listed.body.items[0].stats.clicks).toBeGreaterThanOrEqual(5)
    const other = await signUp()
    expect((await call(other, 'GET', '/api/meta/tracked-links')).body.items).toEqual([])
    expect((await call(other, 'DELETE', `/api/meta/tracked-links/${created.body.link.id}`)).status).toBe(404)
    expect((await call(s, 'DELETE', `/api/meta/tracked-links/${created.body.link.id}`)).status).toBe(204)
  })
})
