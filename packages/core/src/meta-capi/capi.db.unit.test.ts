// CapiService contra o FakeMetaGraph e Postgres real (AC-T104-01, 02, 05) + envio automático de vendas.
import { createHash, randomBytes } from 'node:crypto'
import { capiEventLog, companies, contacts, createDb, sales, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { generateCredentialsKey, initCredentialsCrypto } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeMetaGraph } from '../meta-ads/client/testing'
import { PixelConfigService } from './pixels'
import { capiSalePublisher, saleEventId, sendSaleToPixels, type MetaCapiSaleJobData } from './sales'
import { CapiService, type CapiServiceOptions } from './service'

let tmp: TempDatabase
let db: Database
const fake = new FakeMetaGraph()
const h = (v: string) => createHash('sha256').update(v).digest('hex')

beforeAll(async () => {
  initCredentialsCrypto({ key: generateCredentialsKey() })
  await fake.start()
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  await tmp?.drop()
})

async function world(opts: { autoSendSales?: boolean } = {}) {
  const tag = randomBytes(4).toString('hex')
  const [c] = await db.insert(companies).values({ name: `P${tag}`, slug: `p-t104-${tag}` }).returning()
  const pixelId = String(100000000000000 + Math.floor(Math.random() * 1e9))
  const token = `EAAB${randomBytes(12).toString('hex')}`
  fake.addPixel(pixelId, token)
  const pixel = await new PixelConfigService({ db }).create(c!.id, { name: 'Pixel loja', pixel_id: pixelId, access_token: token, auto_send_sales: opts.autoSendSales ?? false })
  const [contact] = await db
    .insert(contacts)
    .values({ companyId: c!.id, name: 'José da Silva', phoneE164: `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, email: '  Jose@Example.COM ', city: 'São Paulo' })
    .returning()
  return { companyId: c!.id, pixel, pixelId, token, contact: contact! }
}

const capi = (o: Partial<CapiServiceOptions> = {}) => new CapiService({ db, graphUrl: fake.url, testEventCode: null, ...o })
type Pub = { publish(c: string, t: string, d: unknown): Promise<unknown> }

describe('CapiService', () => {
  it('envia JSON com token do pixel, hash do telefone e e-mail normalizados (AC-T104-01)', async () => {
    const w = await world()
    const r = await capi().send({
      companyId: w.companyId,
      pixelConfigId: w.pixel.id,
      eventName: 'Purchase',
      eventId: 'ev-1',
      value: '199,90',
      currency: 'usd',
      user: { phone: '+55 (11) 99999-8888', email: '  Ana@Example.COM ' },
      source: 'manual',
    })
    expect(r).toMatchObject({ status: 'sent', eventId: 'ev-1', eventsReceived: 1 })
    const [ev] = fake.capiEventsFor(w.pixelId)
    expect(ev!.accessToken).toBe(w.token)
    expect(ev!.event).toMatchObject({
      event_name: 'Purchase',
      event_id: 'ev-1',
      action_source: 'chat',
      user_data: { ph: [h('5511999998888')], em: [h('ana@example.com')] },
      custom_data: { currency: 'USD', value: 199.9 },
    })
    const req = fake.requests.find((q) => q.endpoint === `/${w.pixelId}/events`)!
    expect(req.method).toBe('POST')
    expect({ ...req.query, ...req.body }).not.toHaveProperty('appsecret_proof')
    const json = JSON.stringify(req.json)
    for (const f of ['business_messaging', 'messaging_channel', 'page_id', 'ctwa_clid']) expect(json).not.toContain(f)
    const [log] = await db.select().from(capiEventLog).where(eq(capiEventLog.pixelConfigId, w.pixel.id))
    expect(log).toMatchObject({ status: 'sent', eventId: 'ev-1', source: 'manual', actionSource: 'chat' })
  })

  it('o mesmo event_id duas vezes faz 1 POST (AC-T104-02)', async () => {
    const w = await world()
    const input = { companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead' as const, eventId: 'dup-1', source: 'manual' as const }
    expect((await capi().send(input)).status).toBe('sent')
    expect((await capi().send(input)).status).toBe('duplicate')
    expect(fake.capiEventsFor(w.pixelId)).toHaveLength(1)
  })

  it('falha 5xx da Meta fica gravada como incerta (revisão 3); o mesmo event_id é reenviado depois', async () => {
    const w = await world()
    const input = { companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead' as const, eventId: 'f-1', source: 'manual' as const }
    fake.failNext(500, { message: 'boom', code: 2 })
    expect(await capi().send(input)).toMatchObject({ status: 'uncertain' })
    expect((await db.select().from(capiEventLog).where(eq(capiEventLog.pixelConfigId, w.pixel.id)))[0]).toMatchObject({ status: 'uncertain', error: expect.stringContaining('boom') })
    expect((await capi().send(input)).status).toBe('sent')
    expect(fake.capiEventsFor(w.pixelId)).toHaveLength(1)
  })

  it('token errado vira failed; pixel de outra empresa → not_found', async () => {
    const w = await world()
    fake.addPixel(w.pixelId, 'outro-token')
    expect(await capi().send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 't-1', source: 'manual' })).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('190'),
    })
    const other = await world()
    await expect(capi().send({ companyId: other.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 't-2', source: 'manual' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('test_event_code só fora de produção', async () => {
    const w = await world()
    await capi({ testEventCode: 'TEST42', isProduction: false }).send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 'tc-1', source: 'manual' })
    await capi({ testEventCode: 'TEST42', isProduction: true }).send({ companyId: w.companyId, pixelConfigId: w.pixel.id, eventName: 'Lead', eventId: 'tc-2', source: 'manual' })
    expect(fake.capiEventsFor(w.pixelId).map((e) => e.testEventCode)).toEqual(['TEST42', null])
  })

  it('userFromContact: telefone, e-mail, nome, cidade e external_id do contato', async () => {
    const w = await world()
    const u = await capi().userFromContact(w.companyId, w.contact.id)
    expect(u).toMatchObject({ phone: w.contact.phoneE164, externalId: w.contact.id, firstName: 'José', lastName: 'da Silva', city: 'São Paulo' })
    expect(await capi().userFromContact(w.companyId, null)).toEqual({})
  })
})

describe('venda automática (sale.recorded → meta-capi)', () => {
  it('decorator enfileira sale.recorded; job manda Purchase system_generated uma vez por venda', async () => {
    const w = await world({ autoSendSales: true })
    const noAuto = await world()
    const [sale] = await db.insert(sales).values({ companyId: w.companyId, contactId: w.contact.id, amountCents: 19990, currency: 'BRL', source: 'manual' }).returning()
    const queued: { data: MetaCapiSaleJobData; jobId: string }[] = []
    const published: string[] = []
    const inner: Pub = { publish: async (_c, type) => (published.push(type), '1-0') }
    const pub = capiSalePublisher(inner as never, { enqueue: async (data, opts) => void queued.push({ data, jobId: opts.jobId }) }) as Pub
    await pub.publish(w.companyId, 'sale.recorded', { sale_id: sale!.id })
    await pub.publish(w.companyId, 'chat.updated', { chat_id: sale!.id })
    expect(published).toEqual(['sale.recorded', 'chat.updated'])
    expect(queued).toEqual([{ data: { companyId: w.companyId, saleId: sale!.id }, jobId: `capi-sale-${sale!.id}` }])

    const out = await sendSaleToPixels({ db, capi: capi() }, queued[0]!.data)
    expect(out).toEqual([{ pixelConfigId: w.pixel.id, result: expect.objectContaining({ status: 'sent' }) }])
    const again = await sendSaleToPixels({ db, capi: capi() }, queued[0]!.data)
    expect(again[0]!.result.status).toBe('duplicate')
    const evs = fake.capiEventsFor(w.pixelId)
    expect(evs).toHaveLength(1)
    expect(evs[0]!.event).toMatchObject({
      event_name: 'Purchase',
      event_id: saleEventId(sale!.id),
      action_source: 'system_generated',
      custom_data: { currency: 'BRL', value: 199.9 },
      user_data: { em: [h('jose@example.com')], ph: [h(w.contact.phoneE164!.replace(/\D/g, ''))] },
    })
    expect(fake.capiEventsFor(noAuto.pixelId)).toHaveLength(0)
  })

  it('venda não aprovada não é enviada', async () => {
    const w = await world({ autoSendSales: true })
    const [sale] = await db.insert(sales).values({ companyId: w.companyId, amountCents: 1000, source: 'manual', status: 'refunded' }).returning()
    expect(await sendSaleToPixels({ db, capi: capi() }, { companyId: w.companyId, saleId: sale!.id })).toEqual([])
  })
})
