// Rotas do dashboard (T55) com Postgres e Redis reais: permissões, query, cache e bootstrap.
import { randomBytes } from 'node:crypto'
import { companyMembers, createDb, sales, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
let spend = 0

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `d-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.55.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'D', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id, userId: user.id }
}

const get = (s: Session, path: string, companyId = s.companyId) => app.request(path, { headers: { ...H, cookie: s.cookie, 'x-company-id': companyId } })
const json = async (r: Response) => (await r.json()) as Json

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }), adSpendProvider: { getSpend: async () => spend } })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('GET /api/dashboard', () => {
  it('dono vê vendas; cache na 2ª chamada; force_refresh recalcula; 422 em datas inválidas', async () => {
    const s = await signUp()
    await db.insert(sales).values({ companyId: s.companyId, amountCents: 12_345, soldAt: new Date('2026-06-10T15:00:00Z') })
    spend = 12_345
    const q = '/api/dashboard?start_date=2026-06-01&end_date=2026-06-30'
    const a = await json(await get(s, q))
    expect(a.cached).toBe(false)
    expect(a.sales.kpis).toMatchObject({ revenue_cents: 12_345, sales_count: 1, roas: 1 })
    const b = await json(await get(s, q))
    expect(b.cached).toBe(true)
    expect(b.computed_at).toBe(a.computed_at)
    const c = await json(await get(s, `${q}&force_refresh=1`))
    expect(c.cached).toBe(false)
    expect((await get(s, '/api/dashboard?start_date=2026-06-10&end_date=2026-06-01')).status).toBe(422)
    expect((await get(s, `${q}&connection_ids[]=nao-uuid`)).status).toBe(422)
  })

  it('só dashboard.support → sem bloco de vendas nem lifetime_revenue; sem permissão → 403', async () => {
    const owner = await signUp()
    const support = await signUp()
    const nobody = await signUp()
    await db.insert(companyMembers).values([
      { companyId: owner.companyId, userId: support.userId, role: 'member', permissionKeys: ['dashboard.support'] },
      { companyId: owner.companyId, userId: nobody.userId, role: 'member', permissionKeys: [] },
    ])
    const r = await get(support, '/api/dashboard', owner.companyId)
    expect(r.status).toBe(200)
    const body = await json(r)
    expect(body.sales).toBeUndefined()
    expect(body.range.granularity).toBe('hour')
    const boot = await json(await get(support, '/api/dashboard/bootstrap', owner.companyId))
    expect(boot).toMatchObject({ announcements: [], banners: [], leads_count: 0 })
    expect('lifetime_revenue' in boot).toBe(false)
    expect((await get(nobody, '/api/dashboard', owner.companyId)).status).toBe(403)
    expect((await get(nobody, '/api/dashboard/bootstrap', owner.companyId)).status).toBe(403)
    const full = await json(await get(owner, '/api/dashboard/bootstrap'))
    expect(full.lifetime_revenue).toMatchObject({ revenue_cents: 0, milestone: { level: 0, next: { name: 'Primeira Marca' } } })
  })
})
