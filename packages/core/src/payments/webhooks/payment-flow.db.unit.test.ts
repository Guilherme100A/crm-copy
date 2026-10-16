// Bloco Pagamento de ponta a ponta (AC-T111-01..05): motor real (T25/T30) + FakeXPag + PaymentWebhookService,
// com relógio injetado. Nada sai para a rede.
import { randomBytes } from 'node:crypto'
import { companies, createDb, flowRuns, paymentCharges, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, generateCredentialsKey } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FlowControl } from '../../flows/engine/control'
import { createNodeRegistry } from '../../flows/engine/registry'
import { FlowEngine, type FlowStepJobData } from '../../flows/engine/runner'
import { registerPaymentNodes } from '../../flows/nodes/payment/index'
import { FlowStore } from '../../flows/store/store'
import { PaymentIntegrationsService } from '../keys/service'
import { FakeXPag } from '../xpag/fake'
import { PaymentWebhookService } from './service'

let temp: TempDatabase
let db: Database
const CLIENT_ID = 'cli-t111'
const SECRET = 'sk_xpag_T111SECRET_abcd'
const fake = new FakeXPag({ clientId: CLIENT_ID, clientSecret: SECRET })
const cipher = createCipher({ key: generateCredentialsKey() })
let clock = new Date('2026-10-16T12:00:00Z').getTime()
const now = () => new Date(clock)
const queued: FlowStepJobData[] = []
const visits: { node: string; gateway: Record<string, unknown> }[] = []

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  await fake.start()
}, 60_000)

afterAll(async () => {
  await fake.stop()
  await db?.$client.end()
  await temp?.drop()
})

const integrations = () => new PaymentIntegrationsService({ db, cipher, env: { XPAG_API_URL: fake.url, API_PUBLIC_URL: 'https://api.crm.test' } })
const control = () => new FlowControl({ db, now, enqueueStep: async (j) => void queued.push(j) })
const webhooks = () => new PaymentWebhookService({ db, control: control(), integrations: integrations(), now })
function engine() {
  const registry = registerPaymentNodes(createNodeRegistry(), { paymentIntegrations: integrations(), now }).register('tags', {
    execute: (ctx) => (visits.push({ node: ctx.node.id, gateway: { ...((ctx.vars.gateway as Record<string, unknown>) ?? {}) } }), { next: 'source' }),
  })
  const c = control()
  return new FlowEngine({ db, wa: new FakeWaGateway(), registry, hooks: c.engineHooks(), now })
}

const node = (id: string, type: string, actions: unknown[] = []) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions })
const marker = (id: string) => node(id, 'tags', [{ id: `t-${id}`, type: 'add_tags', order: 0, config: { tags: [id] } }])
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle}-${to}`, from, handle, to })

async function world(config: Record<string, unknown>, opts: { chargeBranch?: boolean; failureBranch?: boolean } = {}) {
  const tag = randomBytes(4).toString('hex')
  const [co] = await db.insert(companies).values({ name: `P${tag}`, slug: `p-t111-${tag}` }).returning({ id: companies.id })
  const companyId = co!.id
  const integration = await integrations().create(companyId, { label: 'XPag', gateway: 'xpag', client_id: CLIENT_ID, client_secret: SECRET })
  const contact = (await db.execute(sql`insert into crm.contacts (company_id, name, phone_e164) values (${companyId}, 'Lia Souza', ${`+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`}) returning id`)).rows[0] as { id: string }
  const store = new FlowStore(db)
  const flow = await store.createFlow({ companyId }, { name: `Pagamento ${tag}` })
  const pay = node('P', 'payment', [{ id: 'a', type: 'create_payment_charge', order: 0, config: { gateway: 'xpag', payment_integration_id: integration.id, currency: 'BRL', method: 'PIX', listener_ttl_value: 1, listener_ttl_unit: 'hours', ...config } }])
  const nodes = [node('start', 'start'), pay, marker('B')]
  const edges = [edge('start', 'source', 'P'), edge('P', 'output:payment_approved', 'B')]
  if (opts.chargeBranch !== false) {
    nodes.push(marker('A'))
    edges.push(edge('P', 'output:charge_created', 'A'))
  }
  if (opts.failureBranch !== false) {
    nodes.push(marker('E'))
    edges.push(edge('P', 'failure', 'E'))
  }
  await store.fromDefinition({ companyId }, flow.id, { schema: 'crm.flow/v1', entry: 'start', nodes, edges, variables: [], refs: {} })
  await store.publish({ companyId }, flow.id)
  const e = engine()
  const { runId } = await e.startRun({ companyId }, { flowId: flow.id, contactId: contact.id, vars: { preco: '19,90' } })
  visits.length = 0
  await e.step(runId, 0)
  const run = async () => (await db.select().from(flowRuns).where(eq(flowRuns.id, runId)))[0]!
  const charge = async () => (await db.select().from(paymentCharges).where(eq(paymentCharges.flowRunId, runId)))[0]
  return { companyId, integration, runId, run, charge, engine: e }
}

/** Entrega o webhook do fake pela mesma autenticação da rota (token da URL no header) e processa os eventos. */
async function deliver(transactionId: string, opts: { status?: 'confirmed' | 'failed'; amount?: number; token?: string } = {}) {
  const hook = fake.webhookFor(transactionId, opts)
  const url = new URL(hook.url!)
  const [, , , , gateway, integrationId] = url.pathname.split('/')
  const svc = webhooks()
  const received = await svc.receive({ gateway: gateway!, integrationId: integrationId!, rawBody: hook.rawBody, headers: { ...hook.headers, ...(opts.token !== undefined ? { 'x-webhook-token': opts.token } : {}) } })
  const out = []
  for (const event of received.events) out.push(await svc.process({ companyId: received.companyId, integrationId: received.integrationId, gateway: received.gateway, event }))
  return out
}

async function drain(e: FlowEngine) {
  while (queued.length) {
    const j = queued.shift()!
    await e.step(j.runId, j.expectedSeq)
  }
}

describe('bloco Pagamento', () => {
  it('AC-T111-01/02: cria a cobrança, segue charge_created com as variáveis; aprovado no TTL interrompe e segue payment_approved uma vez', async () => {
    const w = await world({ amount: '49,90' })
    expect(visits.map((v) => v.node)).toEqual(['A'])
    expect(visits[0]!.gateway).toMatchObject({ transaction_id: expect.any(String), payment_code: expect.any(String), value: '49.90', error: '' })
    const charge = (await w.charge())!
    expect(charge).toMatchObject({ status: 'created', amountCents: 4990, currency: 'BRL', method: 'PIX', contactId: expect.any(String) })
    expect(charge.listenerUntil!.toISOString()).toBe(new Date(clock + 3_600_000).toISOString())
    expect(fake.cashins.at(-1)!.body).toMatchObject({ amount: 49.9, currency: 'BRL', name: 'Lia Souza' })
    expect((await w.run()).status).toBe('completed')

    clock += 10 * 60_000
    const [first] = await deliver(charge.transactionId, { amount: 50 })
    expect(first).toMatchObject({ status: 'resumed', via: 'interruptForPayment', handle: 'output:payment_approved' })
    visits.length = 0
    await drain(w.engine)
    expect(visits.map((v) => v.node)).toEqual(['B'])
    expect(visits[0]!.gateway).toMatchObject({ value: '50.00', status: 'approved' })
    expect(await w.charge()).toMatchObject({ status: 'approved', paidAmountCents: 5000, paidAt: expect.any(Date) })

    // Mesmo webhook de novo: não retoma.
    const [again] = await deliver(charge.transactionId, { amount: 50 })
    expect(again).toMatchObject({ status: 'duplicate' })
    expect(queued).toHaveLength(0)
  })

  it('sem saída charge_created o run espera no nó (wait payment); a mensagem do lead não retoma; o webhook retoma por resolvePayment', async () => {
    const w = await world({ amount: 30 }, { chargeBranch: false })
    const run = await w.run()
    expect(run.status).toBe('waiting')
    expect(run.wait).toMatchObject({ kind: 'payment', charge_id: (await w.charge())!.id, handles: { reply: 'output:payment_approved' } })
    expect(await control().resolveReply(w.runId, { text: 'paguei' })).toMatchObject({ advanced: false })
    const [r] = await deliver((await w.charge())!.transactionId)
    expect(r).toMatchObject({ status: 'resumed', via: 'resolvePayment' })
    visits.length = 0
    await drain(w.engine)
    expect(visits.map((v) => v.node)).toEqual(['B'])
    expect(visits[0]!.gateway.value).toBe('30.00')
  })

  it('AC-T111-03: depois do TTL só atualiza a cobrança; erro do gateway segue failure com {gateway.error}', async () => {
    const w = await world({ amount: '10' })
    const tx = (await w.charge())!.transactionId
    clock += 61 * 60_000
    const [r] = await deliver(tx)
    expect(r).toMatchObject({ status: 'updated', charge_status: 'approved', reason: 'listener_expired' })
    expect(queued).toHaveLength(0)
    expect((await w.run()).status).toBe('completed')

    fake.failNext(500)
    const e = await world({ amount: '10' })
    expect(visits.map((v) => v.node)).toEqual(['E'])
    expect(visits[0]!.gateway).toMatchObject({ error: expect.stringMatching(/.+/), error_code: 'upstream', status: 'error' })
    expect(await e.charge()).toBeUndefined()
    const oxxo = await world({ currency: 'MXN', method: 'OXXO', amount: '5' })
    expect(visits[0]).toMatchObject({ node: 'E', gateway: { error_code: 'validation' } })
    expect((await oxxo.run()).wait).toBeNull()
    // Sem saída de erro: o run falha com a mensagem.
    fake.failNext(500)
    const noFailure = await world({ amount: '10' }, { failureBranch: false })
    expect((await noFailure.run()).status).toBe('failed')
  })

  it('AC-T111-05: valor com vírgula, ponto e variável; chave sem valor usa o valor pago do webhook', async () => {
    for (const [amount, cents] of [['49.90', 4990], ['{preco}', 1990], ['R$ 1.299,90', 129990]] as const) {
      const w = await world({ amount })
      expect((await w.charge())!.amountCents).toBe(cents)
      expect(fake.cashins.at(-1)!.body.amount).toBe(cents / 100)
    }
    const open = await world({ open_amount: true, amount: '' })
    const ch = (await open.charge())!
    expect(ch.amountCents).toBeNull()
    expect(fake.cashins.at(-1)!.body).not.toHaveProperty('amount')
    expect(visits[0]!.gateway.value).toBe('')
    await deliver(ch.transactionId, { amount: 77.7 })
    visits.length = 0
    await drain(open.engine)
    expect(visits[0]!.gateway.value).toBe('77.70')
    expect(await open.charge()).toMatchObject({ paidAmountCents: 7770 })
  })

  it('AC-T111-04: integração inexistente/de outro gateway → not_found; token errado ou ausente → invalid_signature (nada processado)', async () => {
    const w = await world({ amount: '10' })
    const tx = (await w.charge())!.transactionId
    const hook = fake.webhookFor(tx)
    const svc = webhooks()
    await expect(svc.receive({ gateway: 'xpag', integrationId: '00000000-0000-4000-8000-000000000000', rawBody: hook.rawBody, headers: hook.headers })).rejects.toMatchObject({ code: 'not_found' })
    await expect(svc.receive({ gateway: 'zenith', integrationId: w.integration.id, rawBody: hook.rawBody, headers: hook.headers })).rejects.toMatchObject({ code: 'not_found' })
    await expect(svc.receive({ gateway: 'xpag', integrationId: 'nao-uuid', rawBody: hook.rawBody, headers: hook.headers })).rejects.toMatchObject({ code: 'not_found' })
    await expect(svc.receive({ gateway: 'xpag', integrationId: w.integration.id, rawBody: hook.rawBody, headers: { 'x-webhook-token': 'errado' } })).rejects.toMatchObject({ code: 'invalid_signature' })
    await expect(svc.receive({ gateway: 'xpag', integrationId: w.integration.id, rawBody: hook.rawBody, headers: {} })).rejects.toMatchObject({ code: 'invalid_signature' })
    expect((await w.charge())!.status).toBe('created')
  })
})
