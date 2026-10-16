// API de chaves de pagamento (T109) com Postgres real e FakeXPag local; o log do pino é capturado e varrido.
import { randomBytes } from 'node:crypto'
import { auditLogs, companyMembers, createDb, flowNodeActions, flowNodes, flows, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeXPag } from '@crm/core'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const logs: string[] = []
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const CLIENT_ID = 'cli-api'
const SECRET = 'sk_xpag_APISECRET_7c1d'
const fake = new FakeXPag({ clientId: CLIENT_ID, clientSecret: SECRET })

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `p-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.109.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'P', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id, userId: user.id }
}

const call = (s: Session, method: string, path: string, body?: unknown, companyId = s.companyId) =>
  app.request(path, { method, headers: { ...H, cookie: s.cookie, 'x-company-id': companyId }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  await fake.start()
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'trace', destination: { write: (s: string) => void logs.push(s) } }),
    credentialsCipher: createCipher({ key: generateCredentialsKey() }),
    paymentsEnv: { XPAG_API_URL: fake.url, API_PUBLIC_URL: 'https://api.crm.test' },
  })
}, 60_000)

afterAll(async () => {
  await fake.stop()
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

async function create(s: Session, body: Json = {}) {
  const res = await call(s, 'POST', '/api/payment-integrations', { payment_integration: { label: 'XPag Loja', gateway: 'xpag', client_id: CLIENT_ID, client_secret: SECRET, ...body } })
  expect(res.status).toBe(201)
  return (await json(res)).integration as Json
}

describe('CRUD e segredos', () => {
  it('nenhuma resposta, auditoria ou log traz o segredo; segredo vazio mantém; trocar gateway → 422', async () => {
    const s = await signUp()
    const dto = await create(s)
    expect(dto).toMatchObject({ gateway: 'xpag', client_id: CLIENT_ID, secret_configured: true, secret_hint: '…7c1d', webhook_url: `https://api.crm.test/api/hooks/payments/xpag/${dto.id}` })
    const responses = [
      await call(s, 'GET', '/api/payment-integrations'),
      await call(s, 'GET', '/api/payment-integrations?gateway=xpag'),
      await call(s, 'GET', `/api/payment-integrations/${dto.id}`),
      await call(s, 'PUT', `/api/payment-integrations/${dto.id}`, { label: 'Renomeada', client_secret: '' }),
      await call(s, 'PUT', `/api/payment-integrations/${dto.id}`, { gateway: 'zenith', client_secret: SECRET }),
      await call(s, 'POST', '/api/payment-integrations', { label: 'x', gateway: 'xpag', client_id: '', client_secret: SECRET }),
      await call(s, 'POST', `/api/payment-integrations/${dto.id}/test-connection`),
    ]
    const bodies = await Promise.all(responses.map((r) => r.text()))
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 422, 422, 200])
    expect(JSON.parse(bodies[0]!).items).toEqual([expect.objectContaining({ id: dto.id })])
    expect(JSON.parse(bodies[3]!).integration).toMatchObject({ label: 'Renomeada', secret_hint: '…7c1d' })
    expect(JSON.parse(bodies[6]!)).toEqual({ ok: true })
    for (const b of bodies) expect(b).not.toContain('APISECRET')
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.companyId, s.companyId))
    expect(audits.some((a) => a.action === 'payment_integrations.create')).toBe(true)
    expect(JSON.stringify(audits)).not.toContain('APISECRET')
    expect(logs.join('\n')).not.toContain('APISECRET')
  })

  it('test-connection recusada → { ok:false, error } sem a chave; 404 em outra empresa', async () => {
    const s = await signUp()
    const dto = await create(s, { client_secret: 'sk_xpag_WRONGKEY_0000' })
    const res = await call(s, 'POST', `/api/payment-integrations/${dto.id}/test-connection`)
    const body = await json(res)
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
    expect(JSON.stringify(body)).not.toContain('WRONGKEY')
    const other = await signUp()
    expect((await call(other, 'GET', `/api/payment-integrations/${dto.id}`)).status).toBe(404)
    expect((await call(other, 'DELETE', `/api/payment-integrations/${dto.id}`)).status).toBe(404)
  })
})

describe('permissões e exclusão', () => {
  it('membro sem settings.integrations.* → 403; com view lê mas não cria', async () => {
    const owner = await signUp()
    const member = await signUp()
    await db.insert(companyMembers).values({ companyId: owner.companyId, userId: member.userId, role: 'member', permissionKeys: ['settings.integrations.view'] })
    expect((await call(member, 'GET', '/api/payment-integrations', undefined, owner.companyId)).status).toBe(200)
    const denied = await call(member, 'POST', '/api/payment-integrations', { label: 'XP', gateway: 'xpag', client_id: 'a', client_secret: 'b' }, owner.companyId)
    expect(denied.status).toBe(403)
  })

  it('em uso por fluxo ativo → 409 com os fluxos; sem uso → 200', async () => {
    const s = await signUp()
    const dto = await create(s)
    const [f] = await db.insert(flows).values({ companyId: s.companyId, name: 'Funil', status: 'active' }).returning({ id: flows.id })
    const [n] = await db.insert(flowNodes).values({ companyId: s.companyId, flowId: f!.id, key: 'pay', type: 'action', name: 'Pagamento', positionX: 0, positionY: 0 }).returning({ id: flowNodes.id })
    await db.insert(flowNodeActions).values({ companyId: s.companyId, nodeId: n!.id, key: 'a1', type: 'create_payment_charge', config: { payment_integration_id: dto.id } })
    const res = await call(s, 'DELETE', `/api/payment-integrations/${dto.id}`)
    expect(res.status).toBe(409)
    expect((await json(res)).error.details.flows).toEqual([{ id: f!.id, name: 'Funil' }])
    await db.delete(flows).where(eq(flows.id, f!.id))
    expect((await call(s, 'DELETE', `/api/payment-integrations/${dto.id}`)).status).toBe(200)
    expect((await call(s, 'GET', `/api/payment-integrations/${dto.id}`)).status).toBe(404)
  })
})
