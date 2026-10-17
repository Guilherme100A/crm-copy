// Integrações UTMify e envio de vendas (T113) com Postgres real e FakeUtmify local (nada sai para a rede).
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
  products,
  saleUtmifyEvents,
  utmifyIntegrations,
  type Database,
} from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, generateCredentialsKey } from '@crm/node-kit'
import { AttributionService } from '../attribution/service'
import { isSaleNotVisibleError } from '../meta-capi/sales'
import { SalesService } from '../sales/service'
import {
  UTMIFY_MAX_ATTEMPTS,
  UTMIFY_NOT_CONFIGURED,
  UtmifyRetryError,
  utmifyJobId,
  utmifySalePublisher,
  UtmifySendService,
  type UtmifyJobData,
} from './delivery'
import { FakeUtmify } from './fake'
import { UtmifyError, UtmifyIntegrationsService, UTMIFY_USAGE_WARNING } from './integrations'

let temp: TempDatabase
let db: Database
const cipher = createCipher({ key: generateCredentialsKey() })
const rnd = () => randomBytes(4).toString('hex')
const TOKEN = 'utm_DBTOKEN_SECRETO_c3d4'
const fake = new FakeUtmify([TOKEN])

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

const integrations = () =>
  new UtmifyIntegrationsService({ db, cipher, env: { UTMIFY_API_URL: fake.url, APP_NAME: 'Meu CRM' } })
const caught = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as Error,
  )

interface Harness {
  send: UtmifySendService
  events: { type: string; data: Record<string, unknown> }[]
  logs: string[]
}

function harness(): Harness {
  const events: Harness['events'] = []
  const logs: string[] = []
  const send = new UtmifySendService({
    db,
    integrations: integrations(),
    publisher: {
      publish: async (_co: string, type: string, data: unknown) => (
        events.push({ type, data: data as Record<string, unknown> }),
        'id'
      ),
    } as never,
    logger: { warn: (o: object, m?: string) => void logs.push(JSON.stringify(o) + (m ?? '')) },
  })
  return { send, events, logs }
}

/** Publisher espião com o `utmifySalePublisher` por cima (como o boot). */
function salesWithTracker() {
  const jobs: { data: UtmifyJobData; jobId: string }[] = []
  const published: { type: string; data: Record<string, unknown> }[] = []
  const inner = {
    publish: async (_co: string, type: string, data: unknown) => (
      published.push({ type, data: data as Record<string, unknown> }),
      'id'
    ),
  }
  const publisher = utmifySalePublisher(inner as never, {
    enqueue: async (data, opts) => void jobs.push({ data, jobId: opts.jobId }),
  })
  return { sales: new SalesService({ db, publisher }), jobs, published }
}

async function contactWithTouch(co: string) {
  const [ct] = await db
    .insert(contacts)
    .values({
      companyId: co,
      name: 'Ana Lima',
      email: 'ana@x.com',
      phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      sourceId: 'ad-contact',
    })
    .returning()
  const att = new AttributionService(db)
  await att.recordTouch(
    co,
    ct!.id,
    { utm_source: 'first-src', utm_campaign: 'first-camp' },
    { at: new Date('2026-10-01T00:00:00Z') },
  )
  await att.recordTouch(
    co,
    ct!.id,
    {
      utm_source: 'FB',
      utm_medium: 'cpc',
      utm_campaign: 'bf',
      utm_content: 'v1',
      utm_term: 'curso',
      ctwa_clid: 'ctwa-last',
    },
    { at: new Date('2026-10-10T00:00:00Z') },
  )
  return ct!
}

async function saleOf(
  co: string,
  integrationId: string | null,
  sales = new SalesService({ db }),
  opts: { contact?: boolean } = {},
) {
  const ct = opts.contact === false ? null : await contactWithTouch(co)
  const [p] = await db
    .insert(products)
    .values({ companyId: co, name: 'Mentoria', priceMinCents: 100, priceMaxCents: 100_000, priceFallbackCents: 9_700 })
    .returning()
  const { sale } = await sales.record({
    companyId: co,
    source: 'flow',
    externalId: `run-${rnd()}`,
    amountCents: 9_700,
    contactId: ct?.id ?? null,
    productId: p!.id,
    utmifyIntegrationId: integrationId,
  })
  return { sale, product: p!, contact: ct }
}

const job = (co: string, saleId: string, status: 'approved' | 'refunded' = 'approved'): UtmifyJobData => ({
  companyId: co,
  saleId,
  status,
})

describe('integrações UTMify: CRUD e token (AC-T113-04)', () => {
  it('cria com token cifrado e dica; DTO nunca traz o token; nome < 2 → validação; vazio mantém', async () => {
    const co = await company()
    const s = integrations()
    const dto = await s.create(co, { company_name: '  Loja Ana  ', integration_token: TOKEN })
    expect(dto).toMatchObject({ name: 'UTMify', company_name: 'Loja Ana', token_configured: true, token_hint: '…c3d4' })
    expect(JSON.stringify(dto)).not.toContain(TOKEN)
    const [row] = await db.select().from(utmifyIntegrations).where(eq(utmifyIntegrations.id, dto.id))
    expect(row!.tokenEnc).toBeTruthy()
    expect(row!.tokenEnc).not.toContain(TOKEN)
    expect(s.tokenOf(row!)).toBe(TOKEN)

    const err = await caught(s.create(co, { company_name: 'A', integration_token: TOKEN }))
    expect(err).toBeInstanceOf(UtmifyError)
    expect((err as UtmifyError).code).toBe('validation')
    expect(JSON.stringify((err as UtmifyError).details)).not.toContain(TOKEN)

    const kept = await s.update(co, dto.id, { company_name: 'Loja Nova', integration_token: '   ' })
    expect(kept).toMatchObject({ company_name: 'Loja Nova', token_configured: true, token_hint: '…c3d4' })
    const changed = await s.update(co, dto.id, { integration_token: 'utm_NOVO_9999' })
    expect(changed.token_hint).toBe('…9999')

    const bare = await s.create(co, { company_name: 'Sem token' })
    expect(bare.token_configured).toBe(false)
    expect((await s.list(co)).map((i) => i.id)).toEqual([dto.id, bare.id])
    expect((await s.list(co, { configured: true })).map((i) => i.id)).toEqual([dto.id])
  })

  it('outra empresa → not_found; excluir em uso por fluxo ativo → conflict com aviso, force exclui', async () => {
    const co = await company()
    const s = integrations()
    const dto = await s.create(co, { company_name: 'Loja', integration_token: TOKEN })
    expect(((await caught(s.get(await company(), dto.id))) as UtmifyError).code).toBe('not_found')

    const [flow] = await db.insert(flows).values({ companyId: co, name: 'Funil', status: 'active' }).returning()
    const [node] = await db
      .insert(flowNodes)
      .values({
        companyId: co,
        flowId: flow!.id,
        key: 'V',
        type: 'approved_sale',
        name: 'V',
        positionX: 0,
        positionY: 0,
      })
      .returning()
    await db
      .insert(flowNodeActions)
      .values({
        companyId: co,
        nodeId: node!.id,
        key: 'a1',
        type: 'register_approved_sale',
        config: { utmify_integration_id: dto.id },
      })
    expect((await s.usage(co, dto.id)).flows).toEqual([{ id: flow!.id, name: 'Funil' }])
    const conflict = (await caught(s.remove(co, dto.id))) as UtmifyError
    expect(conflict.code).toBe('conflict')
    expect(conflict.details).toMatchObject({ warning: UTMIFY_USAGE_WARNING })
    expect(await s.remove(co, dto.id, { force: true })).toMatchObject({ warning: UTMIFY_USAGE_WARNING })
    expect(await s.find(co, dto.id)).toBeNull()
  })
})

describe('envio da venda aprovada (AC-T113-01)', () => {
  it('envia valor, moeda, produto, cliente e os utm_* do ÚLTIMO toque; sale.updated pending → succeeded', async () => {
    const co = await company()
    const integ = await integrations().create(co, { company_name: 'Loja', integration_token: TOKEN })
    const { sale, product } = await saleOf(co, integ.id)
    const h = harness()
    expect(await h.send.process(job(co, sale.id))).toEqual({ status: 'succeeded', attempts: 1 })
    const [order] = fake.ordersOf(sale.id)
    expect(order!.token).toBe(TOKEN)
    expect(order!.body).toMatchObject({
      orderId: sale.id,
      platform: 'MeuCrm',
      status: 'paid',
      customer: { name: 'Ana Lima', email: 'ana@x.com' },
      products: [{ id: product.publicId, name: 'Mentoria', priceInCents: 9_700, quantity: 1 }],
      trackingParameters: {
        utm_source: 'FB',
        utm_medium: 'cpc',
        utm_campaign: 'bf',
        utm_content: 'v1',
        utm_term: 'curso',
        src: 'ad-contact',
        sck: 'ctwa-last',
      },
      commission: { totalPriceInCents: 9_700, userCommissionInCents: 9_700 },
    })
    expect(h.events.filter((e) => e.type === 'sale.updated').map((e) => e.data.utmify_status)).toEqual([
      'pending',
      'succeeded',
    ])
    const dto = await h.send.forSale(co, sale.id)
    expect(dto).toMatchObject({ utmify_integration_id: integ.id, utmify_status: 'succeeded', utmify_last_error: null })
    expect(dto.events).toEqual([expect.objectContaining({ sale_status: 'approved', status: 'succeeded', attempts: 1 })])
  })

  it('venda sem contato: atribuição nula e o envio segue; sem integração: nada é enviado', async () => {
    const co = await company()
    const integ = await integrations().create(co, { company_name: 'Loja', integration_token: TOKEN })
    const { sale } = await saleOf(co, integ.id, undefined, { contact: false })
    const h = harness()
    expect((await h.send.process(job(co, sale.id))).status).toBe('succeeded')
    expect(fake.ordersOf(sale.id)[0]!.body.trackingParameters).toMatchObject({ utm_source: null, src: null, sck: null })

    const { sale: none } = await saleOf(co, null)
    expect(await h.send.process(job(co, none.id))).toEqual({ status: 'skipped', reason: 'no_integration' })
    expect(fake.ordersOf(none.id)).toHaveLength(0)
    expect(await h.send.forSale(co, none.id)).toMatchObject({ utmify_status: null, events: [] })
  })

  it('venda ainda não visível → SaleNotVisibleError; integração sem token → failed "não configurada"', async () => {
    const co = await company()
    const h = harness()
    expect(isSaleNotVisibleError(await caught(h.send.process(job(co, '7d4a0c1e-2f6b-4b6e-9a3c-000000000001'))))).toBe(
      true,
    )
    const bare = await integrations().create(co, { company_name: 'Sem token' })
    const { sale } = await saleOf(co, bare.id)
    expect(await h.send.process(job(co, sale.id))).toMatchObject({ status: 'failed', error: UTMIFY_NOT_CONFIGURED })
    expect((await h.send.forSale(co, sale.id)).utmify_last_error).toBe(UTMIFY_NOT_CONFIGURED)
    expect(((await caught(h.send.forSale(await company(), sale.id))) as UtmifyError).code).toBe('not_found')
  })
})

describe('reembolso e idempotência (AC-T113-02)', () => {
  it('SalesService.update para refunded publica sale.updated e o publisher enfileira utmify-<id>-refunded; o fake recebe paid e depois refunded, uma vez cada', async () => {
    const co = await company()
    const integ = await integrations().create(co, { company_name: 'Loja', integration_token: TOKEN })
    const t = salesWithTracker()
    const { sale } = await saleOf(co, integ.id, t.sales)
    expect(t.jobs).toEqual([{ data: job(co, sale.id), jobId: utmifyJobId(sale.id, 'approved') }])
    const h = harness()
    await h.send.process(job(co, sale.id))

    await t.sales.update(co, sale.id, { status: 'refunded' })
    const upd = t.published.find((p) => p.type === 'sale.updated')!
    expect(upd.data).toMatchObject({
      sale_id: sale.id,
      status: 'refunded',
      previous_status: 'approved',
      sale: { id: sale.id, status: 'refunded' },
    })
    expect(t.jobs.at(-1)).toEqual({ data: job(co, sale.id, 'refunded'), jobId: `utmify-${sale.id}-refunded` })
    expect(await h.send.process(job(co, sale.id, 'refunded'))).toEqual({ status: 'succeeded', attempts: 1 })

    // Mesmo evento de novo: nada sai.
    expect(await h.send.process(job(co, sale.id, 'refunded'))).toEqual({ status: 'skipped', reason: 'already_done' })
    expect(await h.send.process(job(co, sale.id, 'approved'))).toEqual({ status: 'skipped', reason: 'already_done' })
    expect(fake.ordersOf(sale.id).map((o) => o.status)).toEqual(['paid', 'refunded'])
    const refund = fake.ordersOf(sale.id)[1]!.body
    expect(refund.createdAt).toBe(fake.ordersOf(sale.id)[0]!.body.createdAt)
    expect(refund.refundedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/))
    const dto = await h.send.forSale(co, sale.id)
    expect(dto.utmify_status).toBe('succeeded')
    expect(dto.events.map((e) => [e.sale_status, e.status])).toEqual([
      ['approved', 'succeeded'],
      ['refunded', 'succeeded'],
    ])

    // Atualizar de novo (já reembolsada) não publica outra transição.
    const before = t.published.length
    await t.sales.update(co, sale.id, { status: 'refunded' })
    expect(t.published.length).toBe(before)
  })

  it('record repetido (webhook) que vira refunded também publica; outras transições não', async () => {
    const co = await company()
    const t = salesWithTracker()
    const base = {
      companyId: co,
      source: 'webhook' as const,
      externalId: `ext-${rnd()}`,
      amountCents: 500,
      utmifyIntegrationId: 'x',
    }
    const { sale } = await t.sales.record({ ...base, status: 'pending' })
    await t.sales.record({ ...base, status: 'approved' })
    expect(t.published.filter((p) => p.type === 'sale.updated')).toHaveLength(0)
    await t.sales.record({ ...base, status: 'refunded' })
    const ups = t.published.filter((p) => p.type === 'sale.updated')
    expect(ups).toHaveLength(1)
    expect(ups[0]!.data).toMatchObject({ sale_id: sale.id, status: 'refunded', previous_status: 'approved' })
    await t.sales.record({ ...base, status: 'refunded' })
    expect(t.published.filter((p) => p.type === 'sale.updated')).toHaveLength(1)
    expect(t.jobs.map((j) => j.jobId)).toEqual([`utmify-${sale.id}-refunded`])
  })

  it('sem publisher, nada muda; sale.updated sem `sale` (ex.: NF) não enfileira', async () => {
    const co = await company()
    const { sale } = await saleOf(co, null)
    await expect(new SalesService({ db }).update(co, sale.id, { status: 'refunded' })).resolves.toMatchObject({
      status: 'refunded',
    })
    const jobs: string[] = []
    const p = utmifySalePublisher({ publish: async () => 'id' } as { publish(...a: never[]): Promise<unknown> }, {
      enqueue: async (_d, o) => void jobs.push(o.jobId),
    })
    await (p.publish as unknown as (...a: unknown[]) => Promise<unknown>)(co, 'sale.updated', {
      sale_id: sale.id,
      invoice_emit_status: 'pending',
    })
    await (p.publish as unknown as (...a: unknown[]) => Promise<unknown>)(co, 'sale.recorded', {
      sale_id: sale.id,
      sale: { status: 'approved', utmify_integration_id: null },
    })
    await (p.publish as unknown as (...a: unknown[]) => Promise<unknown>)(co, 'sale.recorded', { sale_id: sale.id })
    expect(jobs).toEqual([utmifyJobId(sale.id, 'approved')])
  })

  it('aprovação atrasada depois do reembolso enviado é descartada (não regride o pedido)', async () => {
    const co = await company()
    const integ = await integrations().create(co, { company_name: 'Loja', integration_token: TOKEN })
    const { sale } = await saleOf(co, integ.id)
    await new SalesService({ db }).update(co, sale.id, { status: 'refunded' })
    const h = harness()
    expect((await h.send.process(job(co, sale.id, 'refunded'))).status).toBe('succeeded')
    expect(await h.send.process(job(co, sale.id, 'approved'))).toEqual({ status: 'skipped', reason: 'superseded' })
    expect(fake.ordersOf(sale.id).map((o) => o.status)).toEqual(['refunded'])
  })
})

describe('falha da UTMify (AC-T113-03)', () => {
  it('erro → UtmifyRetryError com a tentativa; esgotadas as 3 → failed com a mensagem, sem o token', async () => {
    const co = await company()
    const integ = await integrations().create(co, { company_name: 'Loja', integration_token: TOKEN })
    const { sale } = await saleOf(co, integ.id)
    const h = harness()
    fake.failAlways(500, { message: `fora do ar ${TOKEN}` })
    try {
      for (let i = 1; i < UTMIFY_MAX_ATTEMPTS; i++) {
        const err = await caught(h.send.process(job(co, sale.id)))
        expect(err).toBeInstanceOf(UtmifyRetryError)
        expect((err as UtmifyRetryError).attempts).toBe(i)
      }
      const out = await h.send.process(job(co, sale.id))
      expect(out).toMatchObject({ status: 'failed', attempts: UTMIFY_MAX_ATTEMPTS })
    } finally {
      fake.reset()
    }
    const [row] = await db.select().from(saleUtmifyEvents).where(eq(saleUtmifyEvents.saleId, sale.id))
    expect(row).toMatchObject({ status: 'failed', attempts: 3 })
    expect(row!.lastError).toContain('Falha na UTMify')
    expect(row!.lastError).not.toContain(TOKEN)
    const dto = await h.send.forSale(co, sale.id)
    expect(dto).toMatchObject({ utmify_status: 'failed', utmify_last_error: row!.lastError })
    expect(JSON.stringify(h.events)).not.toContain(TOKEN)
    expect(h.logs.join('\n')).not.toContain(TOKEN)
    // Falhou de vez: o mesmo job não chama de novo.
    const calls = fake.requests.length
    expect(await h.send.process(job(co, sale.id))).toEqual({ status: 'skipped', reason: 'already_done' })
    expect(fake.requests.length).toBe(calls)
    expect((await h.send.forSales(co, [sale.id, 'lixo'])).map((d) => d.sale_id)).toEqual([sale.id])
  })
})
