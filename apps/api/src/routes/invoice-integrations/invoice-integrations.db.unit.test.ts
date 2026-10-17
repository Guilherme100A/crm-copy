// API de emissores de NF e reemissão (T112) com Postgres real; o log do pino é capturado e varrido atrás do token.
// A fila é trocada por um espião (`invoicesEnqueue`): o processamento do job é testado no worker.
import { randomBytes } from 'node:crypto'
import { auditLogs, contacts, createDb, flowNodeActions, flowNodes, flows, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { invoiceJobId, SalesService, type InvoiceJobData } from '@crm/core'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
const logs: string[] = []
const jobs: { data: InvoiceJobData; jobId: string }[] = []
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const TOKEN = 'ntsy_APITOKEN_SECRETO_5e6f'

interface Session {
  cookie: string
  companyId: string
  userId: string
}

async function signUp(): Promise<Session> {
  const email = `n-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.112.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { ...H, ...ip },
    body: JSON.stringify({ name: 'N', email, password: '12345678', password_confirmation: '12345678' }),
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
    invoicesEnv: { NOTASY_API_URL: 'http://127.0.0.1:9' },
    invoicesEnqueue: async (data, opts) => void jobs.push({ data, jobId: opts.jobId }),
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

async function create(s: Session, body: Json = {}) {
  const res = await call(s, 'POST', '/api/invoice-integrations', {
    invoice_integration: { provider: 'notasy', company_name: 'Loja Ana', integration_token: TOKEN, ...body },
  })
  expect(res.status).toBe(201)
  return (await json(res)).invoice_integration as Json
}

async function sale(s: Session, noteIssuerId: string | null) {
  const [ct] = await db
    .insert(contacts)
    .values({
      companyId: s.companyId,
      name: 'Rui',
      phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    })
    .returning()
  return (
    await new SalesService({ db }).record({
      companyId: s.companyId,
      source: 'flow',
      externalId: `run-${rnd()}`,
      amountCents: 1000,
      contactId: ct!.id,
      noteIssuerId,
    })
  ).sale
}

describe('CRUD /api/invoice-integrations', () => {
  it('AC-T112-04: o token nunca aparece em resposta, auditoria ou log; em branco mantém; provedor fixo', async () => {
    const s = await signUp()
    const dto = await create(s)
    expect(dto).toMatchObject({
      provider: 'notasy',
      name: 'Notasy',
      company_name: 'Loja Ana',
      token_configured: true,
      token_hint: '…5e6f',
    })
    const list = await json(await call(s, 'GET', '/api/invoice-integrations'))
    expect(list.invoice_integrations.map((i: Json) => i.id)).toEqual([dto.id])
    const responses = [
      list,
      await json(await call(s, 'GET', `/api/invoice-integrations/${dto.id}`)),
      await json(
        await call(s, 'PUT', `/api/invoice-integrations/${dto.id}`, {
          invoice_integration: { company_name: 'Loja Ana 2', integration_token: '' },
        }),
      ),
      await json(await call(s, 'PATCH', `/api/invoice-integrations/${dto.id}`, { integration_token: `${TOKEN}-novo` })),
    ]
    expect(responses[2]!.invoice_integration).toMatchObject({
      company_name: 'Loja Ana 2',
      token_configured: true,
      token_hint: '…5e6f',
    })
    expect(responses[3]!.invoice_integration.token_hint).toBe('…novo')
    const bad = await call(s, 'PUT', `/api/invoice-integrations/${dto.id}`, {
      provider: 'outro',
      integration_token: TOKEN,
    })
    expect(bad.status).toBe(422)
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.companyId, s.companyId))
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['invoice_integrations.create', 'invoice_integrations.update']),
    )
    const all = JSON.stringify([responses, await json(bad), audit]) + logs.join('\n')
    expect(all).not.toContain('APITOKEN')
    expect(all).not.toContain('integration_token":"ntsy')
  })

  it('validação: nome < 2 → 422 com fields; JSON quebrado → 400 sem ecoar o corpo; outra empresa → 404', async () => {
    const s = await signUp()
    const res = await call(s, 'POST', '/api/invoice-integrations', {
      invoice_integration: { provider: 'notasy', company_name: 'x', integration_token: TOKEN },
    })
    expect(res.status).toBe(422)
    const body = await json(res)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.fields.map((f: Json) => f.path)).toEqual(['company_name'])
    expect(JSON.stringify(body)).not.toContain('APITOKEN')
    const broken = await app.request('/api/invoice-integrations', {
      method: 'POST',
      headers: { ...H, cookie: s.cookie },
      body: `{"integration_token":"${TOKEN}"`,
    })
    expect(broken.status).toBe(400)
    expect(await broken.text()).not.toContain('APITOKEN')
    const dto = await create(s)
    const other = await signUp()
    for (const [m, p] of [
      ['GET', `/api/invoice-integrations/${dto.id}`],
      ['PUT', `/api/invoice-integrations/${dto.id}`],
      ['DELETE', `/api/invoice-integrations/${dto.id}`],
    ] as const)
      expect((await call(other, m, p, m === 'PUT' ? { company_name: 'Hack' } : undefined)).status).toBe(404)
  })

  it('AC-T112-04: excluir emissor usado por "Venda aprovada" de fluxo ativo → 409 com aviso; ?force=1 exclui e repete o aviso', async () => {
    const s = await signUp()
    const dto = await create(s)
    const [f] = await db
      .insert(flows)
      .values({ companyId: s.companyId, name: 'Fluxo NF', status: 'active' })
      .returning({ id: flows.id })
    const [n] = await db
      .insert(flowNodes)
      .values({
        companyId: s.companyId,
        flowId: f!.id,
        key: `n-${rnd()}`,
        type: 'approved_sale',
        name: 'Venda aprovada',
        positionX: 0,
        positionY: 0,
      })
      .returning({ id: flowNodes.id })
    await db
      .insert(flowNodeActions)
      .values({
        companyId: s.companyId,
        nodeId: n!.id,
        key: 'a1',
        type: 'register_approved_sale',
        config: { note_issuer_id: dto.id },
      })
    const usage = await json(await call(s, 'GET', `/api/invoice-integrations/${dto.id}/usage`))
    expect(usage).toEqual({ flows: [{ id: f!.id, name: 'Fluxo NF' }], in_use: true })
    const res = await call(s, 'DELETE', `/api/invoice-integrations/${dto.id}`)
    expect(res.status).toBe(409)
    const err = (await json(res)).error
    expect(err.code).toBe('CONFLICT')
    expect(err.message).toContain('deixará de emitir nota fiscal')
    expect(err.details.flows).toEqual([{ id: f!.id, name: 'Fluxo NF' }])
    const forced = await call(s, 'DELETE', `/api/invoice-integrations/${dto.id}?force=1`)
    expect(forced.status).toBe(200)
    expect(await json(forced)).toMatchObject({
      ok: true,
      warning: expect.stringContaining('deixará de emitir'),
      flows: [{ id: f!.id }],
    })
    expect((await call(s, 'GET', `/api/invoice-integrations/${dto.id}`)).status).toBe(404)
  })
})

describe('status da NF e reemissão', () => {
  it('GET /api/sales/:id/invoice: sem emissão → status nulo; outra empresa → 404; lista por sale_ids', async () => {
    const s = await signUp()
    const v = await sale(s, null)
    const res = await json(await call(s, 'GET', `/api/sales/${v.id}/invoice`))
    expect(res.invoice).toMatchObject({
      sale_id: v.id,
      invoice_emit_status: null,
      invoice_last_error: null,
      can_reemit: true,
    })
    expect((await call(await signUp(), 'GET', `/api/sales/${v.id}/invoice`)).status).toBe(404)
    const list = await json(await call(s, 'GET', `/api/sale-invoices?sale_ids=${v.id},nao-uuid`))
    expect(list.items).toEqual([expect.objectContaining({ sale_id: v.id, invoice_emit_status: null })])
  })

  it('AC-T112-03: reemit-invoice reenfileira escolhendo outro emissor; em andamento → 409; emissor de outra empresa → 404', async () => {
    const s = await signUp()
    const first = await create(s, { company_name: 'Primeiro' })
    const second = await create(s, { company_name: 'Segundo' })
    const v = await sale(s, first.id)
    const res = await call(s, 'POST', `/api/sales/${v.id}/reemit-invoice`, { invoice_integration_id: second.id })
    expect(res.status).toBe(202)
    const body = await json(res)
    expect(body.sale).toMatchObject({
      id: v.id,
      note_issuer_id: first.id,
      invoice_emit_status: 'pending',
      invoice_last_error: null,
    })
    expect(body.invoice).toMatchObject({ invoice_emit_status: 'pending', invoice_integration_id: second.id })
    expect(body.message).toBe('Emissão reenfileirada. Aguarde alguns segundos e atualize a lista.')
    expect(jobs.at(-1)).toEqual({
      data: { companyId: s.companyId, saleId: v.id, generation: 2 },
      jobId: invoiceJobId(v.id, 2),
    })
    const again = await call(s, 'POST', `/api/sales/${v.id}/reemit-invoice`, {})
    expect(again.status).toBe(409)
    expect((await json(again)).error.details).toEqual({ invoice_emit_status: 'pending' })

    const other = await signUp()
    const foreign = await create(other)
    const v2 = await sale(s, null)
    expect(
      (await call(s, 'POST', `/api/sales/${v2.id}/reemit-invoice`, { invoice_integration_id: foreign.id })).status,
    ).toBe(404)
    expect(
      (await call(other, 'POST', `/api/sales/${v2.id}/reemit-invoice`, { invoice_integration_id: foreign.id })).status,
    ).toBe(404)
    const none = await call(s, 'POST', `/api/sales/${v2.id}/reemit-invoice`)
    expect(none.status).toBe(422)
    expect((await json(none)).error.details.fields[0].path).toBe('invoice_integration_id')
  })
})
