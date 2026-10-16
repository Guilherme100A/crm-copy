// Fontes de venda contra Postgres real (AC-T73-01..05): HMAC, idempotência por external_id, falha com o caminho que
// faltou + replay, teste sem gravar, contato pelo telefone (consent_source 'sale') e atribuição first/last.
import { createHmac, randomBytes } from 'node:crypto'
import { companies, contactAttribution, contacts, createDb, inboundSaleEvents, sales, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, generateCredentialsKey } from '@crm/node-kit'
import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AttributionService } from '../attribution/service'
import { InboundSalesProcessor } from './processor'
import { SaleSourcesService } from './service'

let tmp: TempDatabase
let db: Database
const cipher = createCipher({ key: generateCredentialsKey() })
const published: { type: string; data: unknown }[] = []

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

const rnd = () => randomBytes(4).toString('hex')
const svc = () => new SaleSourcesService({ db, cipher, env: { API_PUBLIC_URL: 'https://api.crm.test' } })
const processor = () => new InboundSalesProcessor({ db, publisher: { publish: async (_c: string, type: string, data: unknown) => (published.push({ type, data }), '1-0') } as never })
const mapping = { external_id: '$.order.id', status: '$.order.status', amount: '$.order.total', phone: '$.customer.phone', name: '$.customer.name', email: '$.customer.email', utm_source: '$.utm.source', utm_campaign: '$.utm.campaign', ctwa_clid: '$.ctwa' }
const payload = (o: Record<string, unknown> = {}) => ({ order: { id: 'ORD-1', status: 'paid', total: '199,90', ...(o.order as object) }, customer: { name: 'Ana Lima', phone: '(11) 97777-6666', email: 'ana@x.com', ...(o.customer as object) }, ...o.extra as object })

async function company() {
  const [c] = await db.insert(companies).values({ name: `S${rnd()}`, slug: `s-t73-${rnd()}` }).returning({ id: companies.id })
  return c!.id
}
async function deliver(source: Awaited<ReturnType<SaleSourcesService['findByToken']>>, body: unknown, sig?: string) {
  const job = await svc().receive(source!, JSON.stringify(body), sig)
  return { job, result: await processor().process(job) }
}

describe('fontes de venda', () => {
  it('AC-T73-01/04: HMAC; mesmo external_id = 1 venda com status atualizado; contato novo com consent_source sale; atribuição first/last', async () => {
    const co = await company()
    const dto = await svc().create(co, { name: 'Loja', hmac_secret: 's3cret', mapping })
    expect(dto).toMatchObject({ hmac_configured: true, public_url: `https://api.crm.test/api/hooks/sales/${dto.token}` })
    const source = await svc().findByToken(dto.token)
    const raw = JSON.stringify(payload({ extra: { utm: { source: 'facebook', campaign: 'black' }, ctwa: 'CLID-1' } }))
    await expect(svc().receive(source!, raw, 'sha256=errado')).rejects.toMatchObject({ code: 'invalid_signature' })
    await expect(svc().receive(source!, raw, undefined)).rejects.toMatchObject({ code: 'invalid_signature' })
    expect((await db.select({ n: count() }).from(inboundSaleEvents).where(eq(inboundSaleEvents.saleSourceId, dto.id)))[0]!.n).toBe(0)

    const sig = createHmac('sha256', 's3cret').update(raw).digest('hex')
    published.length = 0
    const job = await svc().receive(source!, raw, `sha256=${sig}`)
    const first = await processor().process(job)
    expect(first).toMatchObject({ status: 'processed', saleId: expect.any(String), contactId: expect.any(String) })
    expect(published.map((p) => p.type)).toEqual(['sale.recorded'])
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, first.contactId!))
    expect(contact).toMatchObject({ phoneE164: '+5511977776666', name: 'Ana Lima', consent: true, consentSource: 'sale', origin: 'sale' })
    const [sale] = await db.select().from(sales).where(eq(sales.id, first.saleId!))
    expect(sale).toMatchObject({ source: 'webhook', externalId: 'ORD-1', status: 'approved', amountCents: 19990, contactId: contact!.id, ctwaClid: 'CLID-1' })

    // Mesmo external_id, agora reembolsado, com outra campanha: 1 venda, status atualizado; first touch preservado.
    const raw2 = JSON.stringify(payload({ order: { status: 'Reembolsado' }, extra: { utm: { source: 'google', campaign: 'natal' } } }))
    await processor().process(await svc().receive(source!, raw2, createHmac('sha256', 's3cret').update(raw2).digest('hex')))
    expect(await db.select().from(sales).where(eq(sales.companyId, co))).toEqual([expect.objectContaining({ id: sale!.id, status: 'refunded' })])
    const attr = await new AttributionService(db).get(co, contact!.id)
    expect(attr).toMatchObject({ first_touch: { utm_source: 'facebook', utm_campaign: 'black', ctwa_clid: 'CLID-1', sale_source_id: dto.id }, last_touch: { utm_source: 'google', utm_campaign: 'natal', ctwa_clid: null } })

    // Evento sem atribuição não mexe no toque; contato existente é achado pelo telefone.
    const before = (await db.select().from(contactAttribution).where(eq(contactAttribution.contactId, contact!.id)))[0]!
    const raw3 = JSON.stringify(payload({ order: { id: 'ORD-2' }, customer: { phone: '+55 11 97777-6666' } }))
    const r3 = await processor().process(await svc().receive(source!, raw3, createHmac('sha256', 's3cret').update(raw3).digest('hex')))
    expect(r3.contactId).toBe(contact!.id)
    expect((await db.select().from(contactAttribution).where(eq(contactAttribution.contactId, contact!.id)))[0]!.lastAt).toEqual(before.lastAt)
    // Reprocessar o mesmo evento não faz nada.
    expect((await processor().process(job)).status).toBe('noop')
  })

  it('venda que nasce pending e vira approved enfileira o Purchase uma vez; sem capiEnqueue, nada', async () => {
    const co = await company()
    const dto = await svc().create(co, { name: 'Pix', mapping })
    const source = await svc().findByToken(dto.token)
    const queued: { data: unknown; jobId: string }[] = []
    const p = new InboundSalesProcessor({ db, capiEnqueue: async (data, opts) => void queued.push({ data, jobId: opts.jobId }) })
    const send = async (status: string) => p.process(await svc().receive(source!, JSON.stringify(payload({ order: { id: 'PIX-1', status } })), undefined))
    const first = await send('pending')
    expect(queued).toEqual([])
    await send('approved')
    expect(queued).toEqual([{ data: { companyId: co, saleId: first.saleId }, jobId: `capi-sale-${first.saleId}-approved` }])
    await send('approved')
    expect(queued).toHaveLength(1)
    await processor().process(await svc().receive(source!, JSON.stringify(payload({ order: { id: 'PIX-2', status: 'pending' } })), undefined))
    const r = await processor().process(await svc().receive(source!, JSON.stringify(payload({ order: { id: 'PIX-2', status: 'approved' } })), undefined))
    expect(r.status).toBe('processed')
  })

  it('AC-T73-02: mapeamento que não resolve → failed com o caminho; replay depois de corrigir processa', async () => {
    const co = await company()
    const dto = await svc().create(co, { name: 'Checkout', mapping: { ...mapping, phone: '$.cliente.telefone' } })
    const { job, result } = await deliver(await svc().findByToken(dto.token), payload())
    expect(result).toMatchObject({ status: 'failed', error: 'missing_path:$.cliente.telefone' })
    const [ev] = await db.select().from(inboundSaleEvents).where(eq(inboundSaleEvents.id, job.eventId))
    expect(ev).toMatchObject({ status: 'failed', missing: [{ field: 'phone', path: '$.cliente.telefone' }], saleId: null })
    expect((await svc().events(co, dto.id, { status: 'failed' })).items.map((i) => i.id)).toEqual([job.eventId])

    await svc().update(co, dto.id, { mapping })
    const replay = await svc().replay(co, dto.id, job.eventId)
    expect(replay).toMatchObject({ event: { status: 'pending', error: null }, jobId: `ise-${job.eventId}-r2` })
    expect(await processor().process(replay.job)).toMatchObject({ status: 'processed' })
  })

  it('AC-T73-03/05: test devolve o SaleEvent sem gravar; rotacionar invalida o token antigo; inativa = 404', async () => {
    const co = await company()
    const dto = await svc().create(co, { name: 'Teste', mapping })
    const r = await svc().test(co, dto.id, { sample: payload() })
    expect(r).toMatchObject({ ok: true, event: { external_id: 'ORD-1', amount_cents: 19990, customer: { phone: '+5511977776666' } } })
    expect(await svc().test(co, null, { sample: JSON.stringify({ a: { id: 'X', s: 'paid', v: 1000, p: '+5511999990000' } }), mapping: { external_id: 'a.id', status: 'a.s', amount: 'a.v', phone: 'a.p' }, amount_unit: 'cents' })).toMatchObject({ ok: true, event: { amount_cents: 1000 } })
    expect((await db.select({ n: count() }).from(inboundSaleEvents).where(eq(inboundSaleEvents.saleSourceId, dto.id)))[0]!.n).toBe(0)
    expect(await db.select().from(sales).where(eq(sales.companyId, co))).toHaveLength(0)

    const rotated = await svc().rotateToken(co, dto.id)
    expect(rotated.token).not.toBe(dto.token)
    expect(await svc().findByToken(dto.token)).toBeNull()
    expect(await svc().findByToken(rotated.token)).not.toBeNull()
    await svc().update(co, dto.id, { active: false })
    expect(await svc().findByToken(rotated.token)).toBeNull()
  })
})
