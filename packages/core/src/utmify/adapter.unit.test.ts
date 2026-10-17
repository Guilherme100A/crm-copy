// Adapter UTMify (T113) contra o FakeUtmify local (nada sai para a rede).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createUtmifyTracker, utmifyDate, utmifyOrderPayload, utmifyPlatform, UTMIFY_ORDERS_PATH } from './adapter'
import { FakeUtmify } from './fake'
import {
  emptyAttribution,
  redactTrackerSecret,
  SalesTrackerError,
  type SaleAttribution,
  type TrackedSale,
} from './port'

const TOKEN = 'utm_UNIT_TOKEN_SECRETO_9z8y'
const fake = new FakeUtmify([TOKEN])

beforeAll(async () => {
  await fake.start()
})
afterAll(async () => {
  await fake.stop()
})
beforeEach(() => fake.reset())

const sale = (over: Partial<TrackedSale> = {}): TrackedSale => ({
  id: '0b6f8a52-6e0e-4e44-9a43-2b6f2a6d1c01',
  status: 'approved',
  amount_cents: 19_700,
  currency: 'BRL',
  sold_at: '2026-10-16T13:30:14.123Z',
  approved_at: '2026-10-16T13:30:14.123Z',
  refunded_at: null,
  customer: { name: 'Ana Lima', email: 'ana@x.com', phone: '+5511999990000' },
  product: { id: 'prod-1', name: 'Mentoria' },
  ...over,
})
const attribution: SaleAttribution = {
  ...emptyAttribution(),
  utm_source: 'FB',
  utm_medium: 'cpc',
  utm_campaign: 'black-friday',
  utm_content: 'video-1',
  utm_term: 'curso',
  source_id: '120210000000001',
  ctwa_clid: 'ARAkLk-ctwa',
}

const caught = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as SalesTrackerError,
  )

describe('payload (docs.utmify.com.br/envio-de-vendas)', () => {
  it('datas em "YYYY-MM-DD HH:MM:SS" UTC e platform em PascalCase', () => {
    expect(utmifyDate('2026-10-16T13:30:14.123Z')).toBe('2026-10-16 13:30:14')
    expect(utmifyDate(null)).toBeNull()
    expect(utmifyDate('não é data')).toBeNull()
    expect(utmifyPlatform('Meu CRM de Vendas')).toBe('MeuCrmDeVendas')
    expect(utmifyPlatform('')).toBe('Crm')
  })

  it('venda aprovada → status paid, valor, produto, utm_* e src/sck; BRL omite a moeda', () => {
    const p = utmifyOrderPayload(sale(), attribution, { platform: 'Crm' })
    expect(p).toMatchObject({
      orderId: sale().id,
      platform: 'Crm',
      paymentMethod: 'pix',
      status: 'paid',
      createdAt: '2026-10-16 13:30:14',
      approvedDate: '2026-10-16 13:30:14',
      refundedAt: null,
      customer: { name: 'Ana Lima', email: 'ana@x.com', phone: '5511999990000', document: null },
      products: [{ id: 'prod-1', name: 'Mentoria', planId: null, planName: null, quantity: 1, priceInCents: 19_700 }],
      trackingParameters: {
        src: '120210000000001',
        sck: 'ARAkLk-ctwa',
        utm_source: 'FB',
        utm_medium: 'cpc',
        utm_campaign: 'black-friday',
        utm_content: 'video-1',
        utm_term: 'curso',
      },
      commission: { totalPriceInCents: 19_700, gatewayFeeInCents: 0, userCommissionInCents: 19_700 },
    })
    expect((p.commission as Record<string, unknown>).currency).toBeUndefined()
    expect(p.isTest).toBeUndefined()
  })

  it('reembolso → status refunded com refundedAt e o MESMO createdAt; outra moeda vai em commission.currency', () => {
    const p = utmifyOrderPayload(
      sale({ status: 'refunded', refunded_at: '2026-10-18T01:44:39Z', currency: 'usd' }),
      emptyAttribution(),
    )
    expect(p).toMatchObject({ status: 'refunded', createdAt: '2026-10-16 13:30:14', refundedAt: '2026-10-18 01:44:39' })
    expect((p.commission as Record<string, unknown>).currency).toBe('USD')
    expect(p.trackingParameters).toEqual({
      src: null,
      sck: null,
      utm_source: null,
      utm_campaign: null,
      utm_medium: null,
      utm_content: null,
      utm_term: null,
    })
  })

  it('sem produto nem cliente: usa o id da venda, "Venda" e "Cliente"', () => {
    const p = utmifyOrderPayload(
      sale({ product: null, customer: { name: null, email: null, phone: null } }),
      emptyAttribution(),
    )
    expect(p.products).toEqual([expect.objectContaining({ id: sale().id, name: 'Venda' })])
    expect(p.customer).toMatchObject({ name: 'Cliente', email: '', phone: null })
  })
})

describe('createUtmifyTracker contra o FakeUtmify', () => {
  it('POST /api-credentials/orders com x-api-token; o fake guarda o pedido', async () => {
    const before = fake.orders.length
    const tracker = createUtmifyTracker({ token: TOKEN, apiUrl: fake.url, platform: 'Crm' })
    await expect(tracker.pushSale(sale(), attribution)).resolves.toEqual({ order_id: sale().id })
    const req = fake.requests.at(-1)!
    expect(req).toMatchObject({ method: 'POST', path: UTMIFY_ORDERS_PATH, token: TOKEN })
    expect(req.headers['content-type']).toContain('application/json')
    expect(fake.orders.length).toBe(before + 1)
    expect(fake.orders.at(-1)).toMatchObject({ orderId: sale().id, status: 'paid' })
  })

  it('credencial desconhecida → unauthorized (API_CREDENTIAL_NOT_FOUND), sem o token na mensagem', async () => {
    const other = 'utm_OUTRO_TOKEN_desconhecido'
    const err = await caught(createUtmifyTracker({ token: other, apiUrl: fake.url }).pushSale(sale(), attribution))
    expect(err).toBeInstanceOf(SalesTrackerError)
    expect(err!.code).toBe('unauthorized')
    expect(err!.message).toContain('API_CREDENTIAL_NOT_FOUND')
    expect(err!.message).not.toContain(other)
  })

  it('500 → upstream; 400 → validation; rede fora → upstream; token vazio → não configurada', async () => {
    const tracker = createUtmifyTracker({ token: TOKEN, apiUrl: fake.url })
    fake.failNext(500, { message: 'boom' })
    expect(await caught(tracker.pushSale(sale(), attribution))).toMatchObject({
      code: 'upstream',
      message: 'Falha na UTMify: boom',
    })
    fake.failNext(400, { message: 'Invalid fields: customer.email' })
    expect((await caught(tracker.pushSale(sale(), attribution)))?.code).toBe('validation')
    const offline = createUtmifyTracker({ token: TOKEN, apiUrl: 'http://127.0.0.1:9', timeoutMs: 2_000 })
    expect((await caught(offline.pushSale(sale(), attribution)))?.code).toBe('upstream')
    expect(await caught(createUtmifyTracker({ token: '  ' }).pushSale(sale(), attribution))).toMatchObject({
      code: 'unauthorized',
      message: 'Integração UTMify não configurada',
    })
  })

  it('erro que ecoa o token é redigido (AC-T113-04)', async () => {
    fake.failNext(502, { message: `gateway caiu para ${TOKEN}` })
    const err = await caught(createUtmifyTracker({ token: TOKEN, apiUrl: fake.url }).pushSale(sale(), attribution))
    expect(err!.message).not.toContain(TOKEN)
    expect(err!.message).toContain('[redacted]')
    expect(redactTrackerSecret('a'.repeat(400), null)).toHaveLength(301)
  })

  it('o fake recusa corpo sem campos obrigatórios e status fora da lista', async () => {
    const post = (body: unknown) =>
      fetch(`${fake.url}${UTMIFY_ORDERS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-token': TOKEN },
        body: JSON.stringify(body),
      })
    expect((await post({ orderId: 'x' })).status).toBe(400)
    expect((await post({ ...utmifyOrderPayload(sale(), attribution), status: 'approved' })).status).toBe(400)
  })
})
