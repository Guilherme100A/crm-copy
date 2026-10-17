// Emissores de NF e emissão (T112) com Postgres real e FakeNotasy local (nada sai para a rede).
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  companies,
  contacts,
  createDb,
  flowNodeActions,
  flowNodes,
  flows,
  invoiceIntegrations,
  products,
  saleInvoices,
  type Database,
} from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, generateCredentialsKey } from '@crm/node-kit'
import { SalesService } from '../sales/service'
import { isSaleNotVisibleError } from '../meta-capi/sales'
import {
  INVOICE_MAX_ATTEMPTS,
  INVOICE_NOT_CONFIGURED,
  InvoiceEmissionService,
  invoiceJobId,
  InvoiceRetryError,
  type InvoiceJobData,
} from './emission'
import { InvoiceIntegrationsService, InvoicingError, USAGE_WARNING } from './integrations'
import { FakeNotasy } from './notasy/fake'

let temp: TempDatabase
let db: Database
const cipher = createCipher({ key: generateCredentialsKey() })
const rnd = () => randomBytes(4).toString('hex')
const TOKEN = 'ntsy_DBTOKEN_SECRETO_a1b2'
const fake = new FakeNotasy([TOKEN])

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

async function company() {
  const [co] = await db
    .insert(companies)
    .values({ name: 'C', slug: `c-${rnd()}` })
    .returning({ id: companies.id })
  return co!.id
}

const integrations = () => new InvoiceIntegrationsService({ db, cipher, env: { NOTASY_API_URL: fake.url } })
const caught = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as Error,
  )

interface Harness {
  emission: InvoiceEmissionService
  events: { type: string; data: Record<string, unknown> }[]
  jobs: { data: InvoiceJobData; jobId: string }[]
}

function harness(): Harness {
  const events: Harness['events'] = []
  const jobs: Harness['jobs'] = []
  const emission = new InvoiceEmissionService({
    db,
    integrations: integrations(),
    publisher: {
      publish: async (_co: string, type: string, data: unknown) => (
        events.push({ type, data: data as Record<string, unknown> }),
        'id'
      ),
    } as never,
    enqueue: async (data, opts) => void jobs.push({ data, jobId: opts.jobId }),
  })
  return { emission, events, jobs }
}

async function saleOf(co: string, noteIssuerId: string | null, extra: { status?: 'approved' | 'pending' } = {}) {
  const [ct] = await db
    .insert(contacts)
    .values({
      companyId: co,
      name: 'Ana Lima',
      email: 'ana@x.com',
      phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      city: 'Recife',
    })
    .returning()
  const [p] = await db
    .insert(products)
    .values({ companyId: co, name: 'Mentoria', priceMinCents: 100, priceMaxCents: 100_000, priceFallbackCents: 9_700 })
    .returning()
  const { sale } = await new SalesService({ db }).record({
    companyId: co,
    source: 'flow',
    externalId: `run-${rnd()}`,
    amountCents: 9_700,
    contactId: ct!.id,
    productId: p!.id,
    noteIssuerId,
    ...extra,
  })
  return sale
}

const statuses = (h: Harness) =>
  h.events.filter((e) => e.type === 'sale.updated').map((e) => e.data.invoice_emit_status)

describe('emissores: CRUD e token', () => {
  it('cria com token cifrado e dica; DTO nunca traz o token; nome < 2 → validação; provedor fixo', async () => {
    const co = await company()
    const s = integrations()
    const dto = await s.create(co, { provider: 'notasy', company_name: '  Loja Ana  ', integration_token: TOKEN })
    expect(dto).toMatchObject({
      provider: 'notasy',
      name: 'Notasy',
      company_name: 'Loja Ana',
      token_configured: true,
      token_hint: '…a1b2',
    })
    const [row] = await db.select().from(invoiceIntegrations).where(eq(invoiceIntegrations.id, dto.id))
    expect(row!.tokenEnc).not.toContain('DBTOKEN')
    expect(JSON.stringify([dto, await s.list(co), await s.get(co, dto.id)])).not.toContain('DBTOKEN')

    const bad = (await caught(s.create(co, { company_name: 'x', provider: 'outro' }))) as InvoicingError
    expect(bad.code).toBe('validation')
    expect((bad.details!.fields as { path: string }[]).map((f) => f.path).sort()).toEqual(['company_name', 'provider'])
    expect(await caught(s.update(co, dto.id, { provider: 'outro' }))).toMatchObject({ code: 'validation' })
  })

  it('token em branco na edição mantém; endpoint colado vira token; sem token → token_configured false', async () => {
    const co = await company()
    const s = integrations()
    const dto = await s.create(co, { company_name: 'Sem token' })
    expect(dto).toMatchObject({ provider: 'notasy', token_configured: false, token_hint: null })
    const kept = await s.update(co, dto.id, {
      company_name: 'Com token',
      integration_token: `https://api-notasy.com.br/integrations/endpoint/${TOKEN}`,
    })
    expect(kept).toMatchObject({ company_name: 'Com token', token_configured: true, token_hint: '…a1b2' })
    const again = await s.update(co, dto.id, { integration_token: '   ' })
    expect(again.token_configured).toBe(true)
    const [row] = await db.select().from(invoiceIntegrations).where(eq(invoiceIntegrations.id, dto.id))
    expect(s.tokenOf(row!)).toBe(TOKEN)
  })

  it('outra empresa → not_found; exclusão em uso por "Venda aprovada" de fluxo ativo avisa (AC-T112-04)', async () => {
    const co = await company()
    const s = integrations()
    const dto = await s.create(co, { company_name: 'Loja', integration_token: TOKEN })
    expect(await caught(s.get(await company(), dto.id))).toMatchObject({ code: 'not_found' })
    expect(await caught(s.get(co, 'nao-uuid'))).toMatchObject({ code: 'not_found' })

    const flowWith = async (status: 'active' | 'draft', name: string) => {
      const [f] = await db.insert(flows).values({ companyId: co, name, status }).returning({ id: flows.id })
      const [n] = await db
        .insert(flowNodes)
        .values({
          companyId: co,
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
          companyId: co,
          nodeId: n!.id,
          key: 'a1',
          type: 'register_approved_sale',
          config: { note_issuer_id: dto.id, amount_template: '{comprovante.valor}' },
        })
      return f!.id
    }
    const active = await flowWith('active', 'Fluxo vendas')
    await flowWith('draft', 'Rascunho')
    expect(await s.usage(co, dto.id)).toEqual({ flows: [{ id: active, name: 'Fluxo vendas' }] })

    const conflict = (await caught(s.remove(co, dto.id))) as InvoicingError
    expect(conflict.code).toBe('conflict')
    expect(conflict.message).toContain(USAGE_WARNING)
    expect(conflict.details).toEqual({ flows: [{ id: active, name: 'Fluxo vendas' }], warning: USAGE_WARNING })
    const forced = await s.remove(co, dto.id, { force: true })
    expect(forced).toMatchObject({ warning: USAGE_WARNING, flows: [{ id: active }] })
    expect(await s.list(co)).toEqual([])

    const free = await s.create(co, { company_name: 'Livre', integration_token: TOKEN })
    expect(await s.remove(co, free.id)).toMatchObject({ warning: null, flows: [] })
  })
})

describe('emissão (job invoices)', () => {
  it('AC-T112-01: venda aprovada com note_issuer_id → pending → succeeded com sale.updated e o fake recebe a venda', async () => {
    const co = await company()
    const iss = await integrations().create(co, { company_name: 'Loja', integration_token: TOKEN })
    const sale = await saleOf(co, iss.id)
    const h = harness()
    const before = fake.sales.length
    expect(await h.emission.process({ companyId: co, saleId: sale.id, generation: 1 })).toEqual({
      status: 'succeeded',
      attempts: 1,
    })
    expect(statuses(h)).toEqual(['pending', 'succeeded'])
    expect(fake.sales.length).toBe(before + 1)
    expect(fake.sales.at(-1)!.body).toMatchObject({
      id: sale.id,
      total: 9_700,
      currency: 'BRL',
      customer: { name: 'Ana Lima', email: 'ana@x.com' },
      products: [{ name: 'Mentoria' }],
    })
    const dto = await h.emission.forSale(co, sale.id)
    expect(dto).toMatchObject({
      invoice_emit_status: 'succeeded',
      invoice_last_error: null,
      invoice_integration_id: iss.id,
      attempts: 1,
      external_id: fake.sales.at(-1)!.id,
      can_reemit: false,
    })
    // Repetir o job não reenvia.
    expect(await h.emission.process({ companyId: co, saleId: sale.id, generation: 1 })).toEqual({
      status: 'skipped',
      reason: 'already_done',
    })
    expect(fake.sales.length).toBe(before + 1)
    expect(JSON.stringify(h.events)).not.toContain('DBTOKEN')
  })

  it('AC-T112-02: venda sem note_issuer_id não emite; emissor sem token → failed "Emissor não configurado"', async () => {
    const co = await company()
    const h = harness()
    const plain = await saleOf(co, null)
    expect(await h.emission.process({ companyId: co, saleId: plain.id, generation: 1 })).toEqual({
      status: 'skipped',
      reason: 'no_issuer',
    })
    expect(await h.emission.forSale(co, plain.id)).toMatchObject({ invoice_emit_status: null, can_reemit: true })

    const noToken = await integrations().create(co, { company_name: 'Sem token' })
    const sale = await saleOf(co, noToken.id)
    expect(await h.emission.process({ companyId: co, saleId: sale.id, generation: 1 })).toMatchObject({
      status: 'failed',
      error: INVOICE_NOT_CONFIGURED,
    })
    expect(await h.emission.forSale(co, sale.id)).toMatchObject({
      invoice_emit_status: 'failed',
      invoice_last_error: INVOICE_NOT_CONFIGURED,
      can_reemit: true,
    })
    expect(statuses(h)).toEqual(['pending', 'failed'])

    // Emissor inexistente (excluído ou de outra empresa) cai no mesmo erro.
    const ghost = await saleOf(co, '00000000-0000-4000-8000-000000000000')
    expect(await h.emission.process({ companyId: co, saleId: ghost.id, generation: 1 })).toMatchObject({
      status: 'failed',
      error: INVOICE_NOT_CONFIGURED,
    })
    const pending = await saleOf(co, noToken.id, { status: 'pending' })
    expect(await h.emission.process({ companyId: co, saleId: pending.id, generation: 1 })).toEqual({
      status: 'skipped',
      reason: 'not_approved',
    })
  })

  it('AC-T112-03: falha do emissor → retentável até 3 tentativas e depois failed com a mensagem', async () => {
    const co = await company()
    const iss = await integrations().create(co, { company_name: 'Loja', integration_token: TOKEN })
    const sale = await saleOf(co, iss.id)
    const h = harness()
    const job = { companyId: co, saleId: sale.id, generation: 1 }
    fake.failAlways(500, { success: false, error: { message: 'Notasy fora do ar' } })
    try {
      for (let i = 1; i < INVOICE_MAX_ATTEMPTS; i++) {
        const err = await caught(h.emission.process(job))
        expect(err).toBeInstanceOf(InvoiceRetryError)
        expect((err as InvoiceRetryError).attempts).toBe(i)
        expect(await h.emission.forSale(co, sale.id)).toMatchObject({
          invoice_emit_status: 'pending',
          attempts: i,
          invoice_last_error: 'Falha na Notasy: Notasy fora do ar',
        })
      }
      expect(await h.emission.process(job)).toEqual({
        status: 'failed',
        attempts: 3,
        error: 'Falha na Notasy: Notasy fora do ar',
      })
    } finally {
      fake.reset()
    }
    expect(await h.emission.forSale(co, sale.id)).toMatchObject({
      invoice_emit_status: 'failed',
      attempts: 3,
      invoice_last_error: 'Falha na Notasy: Notasy fora do ar',
      can_reemit: true,
    })
    expect(statuses(h).at(-1)).toBe('failed')
  })

  it('AC-T112-03: reemit reenfileira (inclusive com outro emissor); bloqueado em pending/succeeded; job antigo é ignorado', async () => {
    const co = await company()
    const noToken = await integrations().create(co, { company_name: 'Sem token' })
    const good = await integrations().create(co, { company_name: 'Com token', integration_token: TOKEN })
    const sale = await saleOf(co, noToken.id)
    const h = harness()
    await h.emission.process({ companyId: co, saleId: sale.id, generation: 1 })
    expect((await h.emission.forSale(co, sale.id)).invoice_emit_status).toBe('failed')

    const re = await h.emission.reemit(co, sale.id, { invoice_integration_id: good.id })
    expect(re).toMatchObject({
      invoice_emit_status: 'pending',
      invoice_integration_id: good.id,
      attempts: 0,
      invoice_last_error: null,
    })
    expect(h.jobs).toEqual([
      { data: { companyId: co, saleId: sale.id, generation: 2 }, jobId: invoiceJobId(sale.id, 2) },
    ])
    expect(await caught(h.emission.reemit(co, sale.id))).toMatchObject({
      code: 'conflict',
      details: { invoice_emit_status: 'pending' },
    })
    expect(await h.emission.process({ companyId: co, saleId: sale.id, generation: 1 })).toEqual({
      status: 'skipped',
      reason: 'stale',
    })
    expect(await h.emission.process(h.jobs[0]!.data)).toEqual({ status: 'succeeded', attempts: 1 })
    expect(await caught(h.emission.reemit(co, sale.id))).toMatchObject({
      code: 'conflict',
      details: { invoice_emit_status: 'succeeded' },
    })
  })

  it('reemit: venda/emissor de outra empresa → not_found; sem emissor algum → validação; venda sem nota usa note_issuer_id', async () => {
    const co = await company()
    const other = await company()
    const h = harness()
    const foreign = await integrations().create(other, { company_name: 'Outra', integration_token: TOKEN })
    const sale = await saleOf(co, null)
    expect(await caught(h.emission.reemit(other, sale.id))).toMatchObject({ code: 'not_found' })
    expect(await caught(h.emission.forSale(other, sale.id))).toMatchObject({ code: 'not_found' })
    expect(await caught(h.emission.reemit(co, sale.id, { invoice_integration_id: foreign.id }))).toMatchObject({
      code: 'not_found',
    })
    expect(await caught(h.emission.reemit(co, sale.id))).toMatchObject({ code: 'validation' })
    expect(await caught(h.emission.reemit(co, sale.id, { invoice_integration_id: 12 }))).toMatchObject({
      code: 'validation',
    })

    const own = await integrations().create(co, { company_name: 'Própria', integration_token: TOKEN })
    const withIssuer = await saleOf(co, own.id)
    expect(await h.emission.reemit(co, withIssuer.id)).toMatchObject({
      invoice_emit_status: 'pending',
      invoice_integration_id: own.id,
    })
    expect(h.jobs.at(-1)!.data.generation).toBe(2)
    expect(await h.emission.forSales(co, [sale.id, withIssuer.id, 'x'])).toMatchObject([
      { sale_id: sale.id, invoice_emit_status: null },
      { sale_id: withIssuer.id, invoice_emit_status: 'pending' },
    ])
    expect(await h.emission.forSales(other, [sale.id])).toEqual([])
  })

  it('venda ainda não visível (commit pendente) → SaleNotVisibleError, sem linha nem tentativa', async () => {
    const co = await company()
    const h = harness()
    const saleId = '11111111-1111-4111-8111-111111111111'
    const err = await caught(h.emission.process({ companyId: co, saleId, generation: 1 }))
    expect(isSaleNotVisibleError(err)).toBe(true)
    expect(await db.select().from(saleInvoices).where(eq(saleInvoices.saleId, saleId))).toEqual([])
  })
})
