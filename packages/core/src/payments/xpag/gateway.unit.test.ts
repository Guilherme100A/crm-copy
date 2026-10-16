// Adapter XPag contra o FakeXPag local (nunca a API real).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PaymentGatewayError, type PaymentGateway } from '../port'
import { FakeXPag } from './fake'
import { createXPagGateway, validateXPagCharge, XPAG_WEBHOOK_TOKEN_HEADER } from './gateway'

const CLIENT_ID = 'cli-unit'
const SECRET = 'sk_xpag_UNITSECRET_9f3a'
const HOOK_SECRET = 'whsec_UNIT_hook_secret'
const fake = new FakeXPag({ clientId: CLIENT_ID, clientSecret: SECRET })
let gw: PaymentGateway

const make = (over: Partial<Parameters<typeof createXPagGateway>[0]> = {}) =>
  createXPagGateway({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    webhookSecret: HOOK_SECRET,
    webhookUrl: 'http://api.test/api/hooks/payments/xpag/abc',
    apiUrl: fake.url,
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...over,
  })

const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as PaymentGatewayError)

beforeAll(async () => {
  await fake.start()
  gw = make()
})
afterAll(() => fake.stop())

describe('testConnection', () => {
  it('ok com a credencial certa (GET /balance com X-Client-Id/X-Client-Secret)', async () => {
    expect(await gw.testConnection()).toEqual({ ok: true })
    const req = fake.requests.at(-1)!
    expect(req).toMatchObject({ method: 'GET', path: '/balance' })
    expect(req.headers['x-client-id']).toBe(CLIENT_ID)
  })

  it('credencial recusada → ok:false sem a chave; rede fora → ok:false', async () => {
    const r = await make({ clientSecret: `${SECRET}-errado` }).testConnection()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/recusada/)
    expect(JSON.stringify(r)).not.toContain('UNITSECRET')
    expect((await make({ apiUrl: 'http://127.0.0.1:1' }).testConnection()).ok).toBe(false)
  })
})

describe('createCharge', () => {
  it('BRL/PIX devolve transaction_id, copia-e-cola e QR; manda valor decimal e webhook com token', async () => {
    const r = await gw.createCharge({ currency: 'brl', method: 'pix', amount_cents: 12345, name: 'Ana', document: '123', external_id: 'ch-1' })
    expect(r.transaction_id).toMatch(/^pr_/)
    expect(r.status).toBe('created')
    expect(r.payment_code).toMatch(/^00020126/)
    expect(r.qr_image_url).toMatch(/^data:image/)
    const cashin = fake.cashins.at(-1)!
    expect(cashin.body).toMatchObject({ currency: 'BRL', amount: 123.45, name: 'Ana', external_id: 'ch-1' })
    expect(new URL(cashin.webhook_url!).searchParams.get('token')).toBe(HOOK_SECRET)
  })

  it('BRL chave sem valor não manda amount', async () => {
    await gw.createCharge({ currency: 'BRL', method: 'PIX', amount_cents: null })
    expect(fake.cashins.at(-1)!.body.amount).toBeUndefined()
  })

  it('MXN SPEI → CLABE e banco; OXXO → referência e validade; COP → código, QR e expiração; ARS → conta', async () => {
    const spei = await gw.createCharge({ currency: 'MXN', method: 'SPEI', amount_cents: 50000 })
    expect(spei.payment_code).toBe('012345678901234567')
    expect(spei.bank_info).toMatchObject({ bank_name: expect.stringContaining('STP'), beneficiary: 'XPag Pagamentos' })
    expect(fake.cashins.at(-1)!.body.method).toBeUndefined()

    const oxxo = await gw.createCharge({ currency: 'MXN', method: 'OXXO', amount_cents: 25000, name: 'Luis', email: 'l@x.mx' })
    expect(oxxo.payment_code).toBe('8204240000119882')
    expect(oxxo.expires_at).toBe('2026-01-13T00:00:00.000Z')
    expect(fake.cashins.at(-1)!.body).toMatchObject({ method: 'OXXO', payerData: { name: 'Luis', email: 'l@x.mx' } })

    const cop = await gw.createCharge({ currency: 'COP', method: 'BREB', amount_cents: 5_000_000, phone: '+57 300 123 4567' })
    expect(cop.payment_code).toMatch(/^000201COP/)
    expect(cop.bank_info).toEqual({ reference: '@xpag123' })
    expect(cop.expires_at).toBe('2026-01-01T00:15:00.000Z')
    expect(fake.cashins.at(-1)!.body).toMatchObject({ method: 'BREB', phone: '3001234567', amount: 50000 })

    const ars = await gw.createCharge({ currency: 'ARS', method: 'BANK_TRANSFER', amount_cents: 100000, name: 'Juan', document: '20123456789' })
    expect(ars.payment_code).toBe('0000003100000000000001')
    expect(fake.cashins.at(-1)!.body).toMatchObject({ method: 'BANK_TRANSFER', name: 'Juan', document_type: 'CUIT' })
  })

  it('fora da matriz, limites e ARS sem valor falham ANTES da chamada', async () => {
    const before = fake.requests.length
    const cases: [Parameters<PaymentGateway['createCharge']>[0], string, string?][] = [
      [{ currency: 'USD', method: 'PIX', amount_cents: 100 }, 'validation', 'currency'],
      [{ currency: 'BRL', method: 'SPEI', amount_cents: 100 }, 'validation', 'method'],
      [{ currency: 'COP', method: 'PSE', amount_cents: 2_000_000 }, 'validation', 'method'],
      [{ currency: 'MXN', method: 'OXXO', amount_cents: 999 }, 'validation', 'amount'],
      [{ currency: 'MXN', method: 'OXXO', amount_cents: 1_000_001 }, 'validation', 'amount'],
      [{ currency: 'COP', method: 'NEQUI', amount_cents: 999_999 }, 'validation', 'amount'],
      [{ currency: 'COP', method: 'NEQUI', amount_cents: 2_000_000, phone: '2001234567' }, 'validation', 'phone'],
      [{ currency: 'BRL', method: 'PIX', amount_cents: 10.5 }, 'validation', 'amount'],
      [{ currency: 'ARS', method: 'BANK_TRANSFER', amount_cents: 100, name: '' }, 'validation', 'name'],
      [{ currency: 'ARS', method: 'BANK_TRANSFER' }, 'coming_soon'],
    ]
    for (const [req, code, path] of cases) {
      const err = await caught(gw.createCharge(req))
      expect(err, JSON.stringify(req)).toBeInstanceOf(PaymentGatewayError)
      expect(err!.code).toBe(code)
      if (path) expect((err!.details!.fields as { path: string }[])[0]!.path).toBe(path)
      else expect(err!.message).toMatch(/em breve/)
    }
    expect(fake.requests.length).toBe(before)
  })

  it('erros do gateway: credencial → unauthorized; limite → validation; outro → upstream sem segredo', async () => {
    expect((await caught(make({ clientSecret: 'x' }).createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 100 })))!.code).toBe('unauthorized')
    fake.failNext(400, { ok: false, error: 'amount_below_min', error_code: 'amount_below_min' })
    expect((await caught(gw.createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 100 })))!.code).toBe('validation')
    fake.failNext(500, { ok: false, error: `boom ${SECRET}` })
    const err = (await caught(gw.createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 100 })))!
    expect(err.code).toBe('upstream')
    expect(err.message).not.toContain('UNITSECRET')
  })

  it('normaliza e expõe a matriz', () => {
    expect(validateXPagCharge({ currency: ' mxn ', method: 'spei', amount_cents: 100 })).toMatchObject({ currency: 'MXN', method: 'SPEI' })
    expect(gw.supported().map((s) => s.currency)).toEqual(['BRL', 'MXN', 'COP', 'ARS'])
  })
})

describe('parseWebhook', () => {
  it('token válido → payment.approved com centavos e paid_at', async () => {
    const charge = await gw.createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 12345 })
    const hook = fake.webhookFor(charge.transaction_id)
    expect(hook.url).toContain('/api/hooks/payments/xpag/abc')
    expect(gw.parseWebhook(hook.rawBody, hook.headers)).toEqual([
      { type: 'payment.approved', transaction_id: charge.transaction_id, amount_cents: 12345, currency: 'BRL', paid_at: '2025-11-24T12:00:00.000Z' },
    ])
    expect(gw.parseWebhook(Buffer.from(hook.rawBody), new Headers(hook.headers))).toHaveLength(1)
  })

  it('token ausente ou inválido → invalid_signature e nenhum evento', async () => {
    const charge = await gw.createCharge({ currency: 'BRL', method: 'PIX', amount_cents: 100 })
    const hook = fake.webhookFor(charge.transaction_id)
    for (const headers of [{}, { [XPAG_WEBHOOK_TOKEN_HEADER]: 'errado' }, { [XPAG_WEBHOOK_TOKEN_HEADER]: `${HOOK_SECRET}x` }]) {
      let events: unknown = null
      try {
        events = gw.parseWebhook(hook.rawBody, headers)
      } catch (e) {
        expect((e as PaymentGatewayError).code).toBe('invalid_signature')
      }
      expect(events).toBeNull()
    }
  })

  it('mapeia status: failed, expired, med_closed devolvido; ignora cashout, pending e med aberto', () => {
    const h = { [XPAG_WEBHOOK_TOKEN_HEADER]: HOOK_SECRET }
    const p = (o: Record<string, unknown>) => JSON.stringify({ type: 'cashin', transaction_id: 'pr_1', amount: 10, currency: 'BRL', ...o })
    expect(gw.parseWebhook(p({ status: 'failed' }), h)[0]!.type).toBe('payment.failed')
    expect(gw.parseWebhook(p({ status: 'expired' }), h)[0]!.type).toBe('payment.expired')
    expect(gw.parseWebhook(p({ status: 'med_closed', med: { result: 'refunded' } }), h)[0]!.type).toBe('payment.refunded')
    expect(gw.parseWebhook(p({ status: 'med' }), h)).toEqual([])
    expect(gw.parseWebhook(p({ status: 'pending' }), h)).toEqual([])
    expect(gw.parseWebhook(p({ type: 'cashout', status: 'completed' }), h)).toEqual([])
    expect(() => gw.parseWebhook('{nope', h)).toThrow(PaymentGatewayError)
  })
})
