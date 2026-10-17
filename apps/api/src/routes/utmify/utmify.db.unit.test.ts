// API de integrações UTMify e status do envio por venda (T113) com Postgres real; o log do pino é capturado e varrido
// atrás do token. O publisher das vendas é o `utmifySalePublisher` sobre um espião (a fila não participa: o job é
// testado no worker).
import { randomBytes } from 'node:crypto'
import { auditLogs, createDb, saleUtmifyEvents, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { SalesService, utmifyJobId, utmifySalePublisher, type UtmifyJobData } from '@crm/core'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const logs: string[] = []
const jobs: { data: UtmifyJobData; jobId: string }[] = []
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const TOKEN = 'utm_APITOKEN_SECRETO_7g8h'

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `u-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.113.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ name: 'U', email, password: '12345678', password_confirmation: '12345678' }),
  })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ email, password: '12345678' }),
  })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id, userId: user.id }
}

const call = (s: Session, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...H, cookie: s.cookie, 'x-company-id': s.companyId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (r: Response) => (await r.json()) as Json

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'trace', destination: { write: (s: string) => void logs.push(s) } }),
    credentialsCipher: createCipher({ key: generateCredentialsKey() }),
    utmifyEnv: { UTMIFY_API_URL: 'http://127.0.0.1:9' },
    salesPublisher: utmifySalePublisher({ publish: async () => 'id' } as never, {
      enqueue: async (data, opts) => void jobs.push({ data, jobId: opts.jobId }),
    }),
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

async function create(s: Session, body: Json = {}) {
  const res = await call(s, 'POST', '/api/utmify-integrations', {
    utmify_integration: { company_name: 'Loja Ana', integration_token: TOKEN, ...body },
  })
  return { status: res.status, body: await json(res) }
}

describe('CRUD /api/utmify-integrations (AC-T113-04)', () => {
  it('cria com o envelope do legado, lista, edita (token vazio mantém) e nunca devolve o token', async () => {
    const s = await signUp()
    const c = await create(s)
    expect(c.status).toBe(201)
    expect(c.body.utmify_integration).toMatchObject({
      name: 'UTMify',
      company_name: 'Loja Ana',
      token_configured: true,
      token_hint: '…7g8h',
    })
    const id = c.body.utmify_integration.id
    const bare = await create(s, { company_name: 'Sem token', integration_token: '' })
    expect(bare.body.utmify_integration.token_configured).toBe(false)

    const list = await json(await call(s, 'GET', '/api/utmify-integrations'))
    expect(list.utmify_integrations.map((i: Json) => i.id)).toEqual([id, bare.body.utmify_integration.id])
    const configured = await json(await call(s, 'GET', '/api/utmify-integrations?configured=1'))
    expect(configured.utmify_integrations.map((i: Json) => i.id)).toEqual([id])

    const put = await call(s, 'PUT', `/api/utmify-integrations/${id}`, {
      utmify_integration: { company_name: 'Loja Nova', integration_token: '' },
    })
    expect(put.status).toBe(200)
    expect((await json(put)).utmify_integration).toMatchObject({
      company_name: 'Loja Nova',
      token_configured: true,
      token_hint: '…7g8h',
    })
    const patch = await call(s, 'PATCH', `/api/utmify-integrations/${id}`, { integration_token: 'utm_TROCADO_0000' })
    expect((await json(patch)).utmify_integration.token_hint).toBe('…0000')
    const one = await call(s, 'GET', `/api/utmify-integrations/${id}`)

    const bodies = [JSON.stringify(c.body), JSON.stringify(list), JSON.stringify(await json(one))]
    for (const b of bodies) {
      expect(b).not.toContain(TOKEN)
      expect(b).not.toContain('integration_token')
    }
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.companyId, s.companyId))
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['utmify_integrations.create', 'utmify_integrations.update']),
    )
    expect(JSON.stringify(audits)).not.toContain(TOKEN)
    expect(JSON.stringify(audits)).not.toContain('utm_TROCADO_0000')
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('nome < 2 → 422 sem ecoar o token; JSON inválido → 400; outra empresa → 404; DELETE', async () => {
    const s = await signUp()
    const bad = await create(s, { company_name: 'A' })
    expect(bad.status).toBe(422)
    expect(bad.body.error.code).toBe('VALIDATION_ERROR')
    expect(JSON.stringify(bad.body)).not.toContain(TOKEN)
    const malformed = await app.request('/api/utmify-integrations', {
      method: 'POST',
      headers: { ...H, cookie: s.cookie, 'x-company-id': s.companyId },
      body: `{"integration_token":"${TOKEN}"`,
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.text()).not.toContain(TOKEN)

    const c = await create(s)
    const id = c.body.utmify_integration.id
    const other = await signUp()
    expect((await call(other, 'GET', `/api/utmify-integrations/${id}`)).status).toBe(404)
    expect((await call(other, 'DELETE', `/api/utmify-integrations/${id}`)).status).toBe(404)
    expect(await json(await call(s, 'GET', `/api/utmify-integrations/${id}/usage`))).toEqual({
      flows: [],
      in_use: false,
    })
    const del = await call(s, 'DELETE', `/api/utmify-integrations/${id}`)
    expect(del.status).toBe(200)
    expect(await json(del)).toMatchObject({ ok: true, warning: null })
    expect((await call(s, 'GET', `/api/utmify-integrations/${id}`)).status).toBe(404)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })
})

describe('status do envio na venda (AC-T113-03) e gatilho do reembolso (AC-T113-02)', () => {
  it('GET /api/sales/:id/utmify mostra a falha; PATCH para refunded enfileira utmify-<id>-refunded', async () => {
    const s = await signUp()
    const c = await create(s)
    const integrationId = c.body.utmify_integration.id
    const { sale } = await new SalesService({ db }).record({
      companyId: s.companyId,
      source: 'flow',
      externalId: `run-${rnd()}`,
      amountCents: 4_700,
      utmifyIntegrationId: integrationId,
    })
    await db.insert(saleUtmifyEvents).values({
      companyId: s.companyId,
      saleId: sale.id,
      saleStatus: 'approved',
      utmifyIntegrationId: integrationId,
      status: 'failed',
      attempts: 3,
      lastError: 'Falha na UTMify: instável',
    })
    const res = await call(s, 'GET', `/api/sales/${sale.id}/utmify`)
    expect(res.status).toBe(200)
    expect((await json(res)).utmify).toMatchObject({
      sale_id: sale.id,
      utmify_integration_id: integrationId,
      utmify_status: 'failed',
      utmify_last_error: 'Falha na UTMify: instável',
      events: [{ sale_status: 'approved', status: 'failed', attempts: 3 }],
    })
    const many = await json(await call(s, 'GET', `/api/sale-utmify?sale_ids=${sale.id},nao-uuid`))
    expect(many.items.map((i: Json) => i.sale_id)).toEqual([sale.id])
    const other = await signUp()
    expect((await call(other, 'GET', `/api/sales/${sale.id}/utmify`)).status).toBe(404)

    const patched = await call(s, 'PATCH', `/api/sales/${sale.id}`, { status: 'refunded' })
    expect(patched.status).toBe(200)
    expect(jobs.at(-1)).toEqual({
      data: { companyId: s.companyId, saleId: sale.id, status: 'refunded' },
      jobId: utmifyJobId(sale.id, 'refunded'),
    })
  })

  it('venda criada pela API com status aprovado e sem integração não enfileira', async () => {
    const s = await signUp()
    const before = jobs.length
    const res = await call(s, 'POST', '/api/sales', { amount_cents: 1_000, currency: 'BRL', status: 'approved' })
    expect(res.status).toBe(201)
    expect(jobs.length).toBe(before)
  })
})
