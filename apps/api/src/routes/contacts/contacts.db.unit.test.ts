// Rotas de contatos, etiquetas e campos por HTTP (app.request), com Postgres real e FakeWaGateway.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companyMembers, createDb, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq, sql } from 'drizzle-orm'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const gw = new FakeWaGateway()

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const JSON_H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Who {
  cookie: string
  companyId: string
}

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { ...JSON_H, cookie: who.cookie, 'x-company-id': who.companyId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (res.status === 204 ? {} : await res.json()) as Json }
}

async function owner(): Promise<Who & { email: string }> {
  const email = `u${rnd()}@x.com`
  const pw = { password: 's3nha-forte', password_confirmation: 's3nha-forte' }
  await app.request('/api/auth/register', { method: 'POST', headers: JSON_H, body: JSON.stringify({ name: 'Ana', email, ...pw }) })
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...JSON_H, 'x-forwarded-for': `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email, password: pw.password }),
  })
  const cookie = `crm_session=${/crm_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`
  const body = (await res.json()) as Json
  return { email, cookie, companyId: body.companies[0].id }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer({ from: 'no-reply@example.com' }),
    waGateway: gw,
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
})

describe('rotas de contatos', () => {
  it('CRUD, 409 com id, 422 e auditoria', async () => {
    const a = await owner()
    const created = await call(a, 'POST', '/api/contacts', { full_name: 'Ana', phone_number: '(11) 98888-1111', custom_fields: { plano: 'ouro' } })
    expect(created.status).toBe(201)
    expect(created.body.contact).toMatchObject({ name: 'Ana', phone_e164: '+5511988881111', consent: true, consent_source: 'manual' })
    const id = created.body.contact.id
    const dup = await call(a, 'POST', '/api/contacts', { name: 'B', phone: '+55 11 98888-1111' })
    expect(dup).toMatchObject({ status: 409, body: { error: { code: 'CONFLICT', details: { id, field: 'phone_e164' } } } })
    const bad = await call(a, 'POST', '/api/contacts', { name: 'C', phone: '123' })
    expect(bad.status).toBe(422)
    expect(bad.body.error.details.fields[0].path).toBe('phone')
    expect((await call(a, 'POST', '/api/contacts', { name: 'D', phone: '+5511900000001', extra: 1 })).status).toBe(422)
    expect((await call(a, 'PATCH', `/api/contacts/${id}`, { city: 'Santos' })).body.contact.city).toBe('Santos')
    const list = await call(a, 'GET', '/api/contacts?label_ids[]=&search=ana')
    expect(list.status).toBe(200)
    expect(list.body.page).toMatchObject({ page: 1, limit: 20 })
    const audit = await db.execute(sql`select action from crm.audit_logs where target_id = ${id} order by created_at`)
    expect(audit.rows.map((r) => r.action)).toEqual(['contacts.create', 'contacts.update'])
    expect((await call(a, 'DELETE', `/api/contacts/${id}`)).status).toBe(204)
    expect((await call(a, 'GET', `/api/contacts/${id}`)).status).toBe(404)
  })

  it('outra empresa → 404; sem contacts.view → 403', async () => {
    const [a, b] = [await owner(), await owner()]
    const id = (await call(a, 'POST', '/api/contacts', { name: 'X', phone: '+5511977770000' })).body.contact.id
    for (const m of ['GET', 'PATCH', 'DELETE']) expect((await call(b, m, `/api/contacts/${id}`, m === 'PATCH' ? { city: 'x' } : undefined)).status).toBe(404)
    // b vira membro de a só com chat.view
    const [user] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${b.email}`)
    await db.insert(companyMembers).values({ companyId: a.companyId, userId: user!.id, role: 'member', permissionKeys: ['chat.view'] })
    expect((await call({ cookie: b.cookie, companyId: a.companyId }, 'GET', '/api/contacts')).status).toBe(403)
    await db.delete(companyMembers).where(eq(companyMembers.userId, user!.id))
  })

  it('merge-identity, opt-out e catálogo de campos', async () => {
    const a = await owner()
    const lidOnly = (await call(a, 'POST', '/api/contacts', { name: 'L', wa_lid: '112233445566778@lid' })).body.contact
    await call(a, 'POST', '/api/contacts', { name: 'P', phone: '+5511966660000', custom_fields: { nivel: '2' } })
    const merged = await call(a, 'POST', '/api/contacts/merge-identity', { lid: '112233445566778@lid', pn: '+5511966660000' })
    expect(merged.body.contact).toMatchObject({ id: lidOnly.id, phone_e164: '+5511966660000', custom_fields: { nivel: '2' } })
    expect((await call(a, 'POST', '/api/contacts/merge-identity', { lid: '998877665544332@lid', pn: '+5511900000002' })).status).toBe(404)

    await call(a, 'PATCH', `/api/contacts/${lidOnly.id}`, { opt_out: true })
    expect(gw.isOptedOut('+5511966660000')).toBe(true)

    const fields = await call(a, 'GET', '/api/custom-fields')
    expect(fields.body.items.find((f: Json) => f.key === 'nivel')).toMatchObject({ system: false })
    expect((await call(a, 'PATCH', '/api/custom-fields/nivel', { description: 'Nível' })).body.custom_field.description).toBe('Nível')
    expect((await call(a, 'PATCH', '/api/custom-fields/nivel', { description: 'x', key: 'outro' })).status).toBe(422)
    // T58 (AC-T58-04): a descrição de campo de sistema é editável, como na referência
    expect((await call(a, 'PATCH', '/api/custom-fields/full_name', { description: 'x' })).body.custom_field.description).toBe('x')
    expect((await call(a, 'POST', '/api/custom-fields', { key: 'a' })).status).toBe(422)
    expect((await call(a, 'POST', '/api/labels', { name: 'Ok', color: 'red' })).status).toBe(422)
    const label = await call(a, 'POST', '/api/labels', { name: 'Ok', color: '#00AA00' })
    expect(label.status).toBe(201)
    expect((await call(a, 'GET', '/api/labels')).body.items[0]).toMatchObject({ name: 'Ok', contacts_count: 0 })
  })
})
