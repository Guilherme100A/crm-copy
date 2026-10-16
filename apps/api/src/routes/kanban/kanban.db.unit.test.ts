// Kanban por HTTP + integração com a lista de chats (T48/T50), Postgres real.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chats, companyMembers, contacts, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
interface Who {
  cookie: string
  companyId: string
  userId: string
}

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { ...H, cookie: who.cookie, 'x-company-id': who.companyId }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: (await res.json()) as Json }
}

async function owner(): Promise<Who> {
  const email = `kb${rnd()}@x.com`
  await app.request('/api/auth/register', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Ana', email, password: 's3nha-forte', password_confirmation: 's3nha-forte' }) })
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, 'x-forwarded-for': `10.6.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email, password: 's3nha-forte' }),
  })
  const body = (await res.json()) as Json
  return { cookie: `crm_session=${/crm_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`, companyId: body.companies[0].id, userId: body.user.id }
}

async function chat(companyId: string) {
  const [ct] = await db.insert(contacts).values({ companyId, name: 'Lead', phoneE164: `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}` }).returning()
  const [ch] = await db.insert(chats).values({ companyId, connectionId: crypto.randomUUID(), contactId: ct!.id }).returning()
  return ch!.id
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer({ from: 'no-reply@example.com' }), trustProxy: true, logger: createLogger({ level: 'silent' }) })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('kanban por HTTP', () => {
  it('quadro, card, 409, mover com totais e erros de validação', async () => {
    const a = await owner()
    const crm = (await call(a, 'POST', '/api/crms', { name: 'Vendas' })).body.crm
    expect(crm.columns).toHaveLength(3)
    expect((await call(a, 'POST', `/api/crms/${crm.id}/columns`, { name: 'X', accent_color: 'azul' })).status).toBe(422)
    const ch = await chat(a.companyId)
    const card = (await call(a, 'POST', `/api/crms/${crm.id}/cards`, { chat_id: ch, value_cents: 5000 })).body.card
    expect(card).toMatchObject({ column_id: crm.columns[0].id, value_cents: 5000, value: 50 })
    const dup = await call(a, 'POST', `/api/crms/${crm.id}/cards`, { chat_id: ch })
    expect([dup.status, dup.body.error.details.error_code]).toEqual([409, 'card_exists'])
    const moved = await call(a, 'PATCH', `/api/crms/${crm.id}/cards/${card.id}/move`, { column_id: crm.columns[2].id })
    expect(moved.body.card.column_id).toBe(crm.columns[2].id)
    expect(moved.body.columns.find((t: Json) => t.column_id === crm.columns[2].id)).toMatchObject({ total_count: 1, total_value_cents: 5000 })
    const stats = (await call(a, 'GET', `/api/crms/${crm.id}/stats`)).body
    expect([stats.total_cards, stats.conversion_count, stats.conversion_rate]).toEqual([1, 1, 100])
  })

  it('lista de chats filtra por quadro/coluna; PATCH do chat cria, move e remove o card; exige kanban.edit', async () => {
    const a = await owner()
    const crm = (await call(a, 'POST', '/api/crms', { name: 'Funil' })).body.crm
    const [c1, c2] = [await chat(a.companyId), await chat(a.companyId)]
    const put = await call(a, 'PATCH', `/api/chats/${c1}`, { crm_id: crm.id })
    expect(put.body.card.column_id).toBe(crm.columns[0].id)
    expect((await call(a, 'GET', `/api/chats?crm_id=${crm.id}`)).body.items.map((x: Json) => x.id)).toEqual([c1])
    const mv = await call(a, 'PATCH', `/api/chats/${c1}`, { crm_id: crm.id, crm_column_id: crm.columns[1].id })
    expect(mv.body.card.column_id).toBe(crm.columns[1].id)
    expect((await call(a, 'GET', `/api/chats?crm_column_id=${crm.columns[0].id}`)).body.items).toEqual([])
    const counts = (await call(a, 'GET', `/api/chats/counts?crm_id=${crm.id}`)).body.counts
    expect(Object.values(counts).reduce((s: number, v) => s + (v as number), 0)).toBe(1)
    expect((await call(a, 'PATCH', `/api/chats/${c1}`, { crm_id: crm.id, crm_column_id: null })).body.card).toBeNull()
    expect((await call(a, 'PATCH', `/api/chats/${c2}`, { crm_column_id: crm.columns[0].id })).status).toBe(422)

    const viewer = await owner()
    await db.insert(companyMembers).values({ companyId: a.companyId, userId: viewer.userId, role: 'member', permissionKeys: ['chat.view', 'kanban.view'] })
    const v = { ...viewer, companyId: a.companyId }
    expect((await call(v, 'PATCH', `/api/chats/${c2}`, { crm_id: crm.id })).status).toBe(403)
    expect((await call(v, 'POST', `/api/crms/${crm.id}/cards`, { chat_id: c2 })).status).toBe(403)
    expect((await call(v, 'GET', `/api/crms/${crm.id}/cards`)).status).toBe(200)
  })
})
