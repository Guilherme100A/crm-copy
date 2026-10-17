// Adapter Notasy (T112) contra o FakeNotasy local: nada sai para a rede.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { InvoiceIssuerError } from '../port'
import { invoiceJobId, invoiceSalePublisher } from '../emission'
import { createNotasyIssuer, normalizeNotasyToken, notasySalePayload, NOTASY_DEFAULT_API_URL } from './adapter'
import { FakeNotasy } from './fake'

const TOKEN = 'ntsy_TOKEN_SECRETO_9f3a'
const fake = new FakeNotasy([TOKEN])
const sale = {
  id: '0b5a3c1e-0000-4000-8000-000000000001',
  amount_cents: 19790,
  currency: 'BRL',
  sold_at: '2026-10-16T12:00:00.000Z',
  status: 'approved',
  external_id: 'run-1-node-1',
}
const customer = {
  name: 'Ana',
  email: 'ana@x.com',
  phone: '+5511999990000',
  state: 'SP',
  city: 'São Paulo',
  zip: '01000-000',
}
const product = { id: 'prod-1', name: 'Curso' }

beforeAll(async () => {
  await fake.start()
})
afterAll(async () => {
  await fake.stop()
})

const caught = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as InvoiceIssuerError,
  )

describe('createNotasyIssuer', () => {
  it('POST no endpoint da integração com o JSON da venda; 200 → succeeded com o id do emissor', async () => {
    const issuer = createNotasyIssuer({ token: TOKEN, apiUrl: `${fake.url}/` })
    const res = await issuer.issue(sale, customer, product)
    expect(res.status).toBe('succeeded')
    expect(res.external_id).toBe(fake.sales.at(-1)!.id)
    const req = fake.requests.at(-1)!
    expect(req).toMatchObject({ method: 'POST', path: `/integrations/endpoint/${TOKEN}`, token: TOKEN })
    expect(req.headers['content-type']).toContain('application/json')
    expect(req.body).toMatchObject({
      id: sale.id,
      external_sale_id: 'run-1-node-1',
      currency: 'BRL',
      total: 19790,
      customer: { name: 'Ana', email: 'ana@x.com', phone: '+5511999990000' },
      products: [{ name: 'Curso', quantity: 1, price: 19790 }],
    })
  })

  it('token inválido (404 da Notasy) → unauthorized sem o token na mensagem', async () => {
    const other = 'ntsy_OUTRO_TOKEN_1234'
    const err = await caught(createNotasyIssuer({ token: other, apiUrl: fake.url }).issue(sale, customer, null))
    expect(err).toBeInstanceOf(InvoiceIssuerError)
    expect(err!.code).toBe('unauthorized')
    expect(err!.details).toEqual({ status: 404 })
    expect(JSON.stringify([err!.message, err!.details])).not.toContain(other)
  })

  it('500 → upstream com a mensagem do emissor; rede fora → upstream sem o token', async () => {
    fake.failNext(500, { success: false, error: { message: 'Serviço indisponível' } })
    const err = await caught(createNotasyIssuer({ token: TOKEN, apiUrl: fake.url }).issue(sale, customer, product))
    expect(err).toMatchObject({
      code: 'upstream',
      message: 'Falha na Notasy: Serviço indisponível',
      details: { status: 500 },
    })
    const leaky = vi.fn(async (url: string | URL | Request) => {
      throw new Error(`connect ECONNREFUSED ${String(url)}`)
    }) as unknown as typeof fetch
    const net = await caught(
      createNotasyIssuer({ token: TOKEN, apiUrl: fake.url, fetch: leaky }).issue(sale, customer, product),
    )
    expect(net!.code).toBe('upstream')
    expect(net!.message).toContain('[redacted]')
    expect(net!.message).not.toContain(TOKEN)
  })

  it('422 → validation; sem token → "Emissor não configurado"', async () => {
    fake.failNext(422, { success: false, error: { message: 'CPF inválido' } })
    expect(
      await caught(createNotasyIssuer({ token: TOKEN, apiUrl: fake.url }).issue(sale, customer, product)),
    ).toMatchObject({ code: 'validation', message: 'Notasy recusou a venda: CPF inválido' })
    expect(
      await caught(createNotasyIssuer({ token: '  ', apiUrl: fake.url }).issue(sale, customer, product)),
    ).toMatchObject({ message: 'Emissor não configurado' })
  })

  it('failNext com times e failAlways/reset controlam as falhas do fake', async () => {
    const issuer = createNotasyIssuer({ token: TOKEN, apiUrl: fake.url })
    fake.failNext(503, undefined, 2)
    expect(await caught(issuer.issue(sale, customer, product))).toMatchObject({ code: 'upstream' })
    expect(await caught(issuer.issue(sale, customer, product))).toMatchObject({ code: 'upstream' })
    expect((await issuer.issue(sale, customer, product)).status).toBe('succeeded')
    fake.failAlways(500)
    expect(await caught(issuer.issue(sale, customer, product))).toMatchObject({ code: 'upstream' })
    fake.reset()
    expect((await issuer.issue(sale, customer, product)).status).toBe('succeeded')
  })

  it('URL base: opção > NOTASY_API_URL > padrão público', async () => {
    const seen: string[] = []
    const spy = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    vi.stubEnv('NOTASY_API_URL', '')
    await createNotasyIssuer({ token: TOKEN, fetch: spy }).issue(sale, customer, product)
    vi.stubEnv('NOTASY_API_URL', 'http://env.notasy.test')
    await createNotasyIssuer({ token: TOKEN, fetch: spy }).issue(sale, customer, product)
    vi.unstubAllEnvs()
    expect(seen).toEqual([
      `${NOTASY_DEFAULT_API_URL}/integrations/endpoint/${TOKEN}`,
      `http://env.notasy.test/integrations/endpoint/${TOKEN}`,
    ])
  })
})

describe('token e payload', () => {
  it('aceita o token puro ou o endpoint inteiro colado do painel', () => {
    expect(normalizeNotasyToken(`  ${TOKEN} `)).toBe(TOKEN)
    expect(normalizeNotasyToken(`https://api-notasy.com.br/integrations/endpoint/${TOKEN}`)).toBe(TOKEN)
    expect(normalizeNotasyToken(`https://api-notasy.com.br/integrations/endpoint/${TOKEN}/?x=1`)).toBe(TOKEN)
  })

  it('sem produto, o item vai como "Venda" com o valor da venda', () => {
    expect(notasySalePayload(sale, customer, null).products).toEqual([
      { id: null, name: 'Venda', quantity: 1, price: 19790 },
    ])
  })
})

describe('invoiceSalePublisher', () => {
  const inner = () => ({ publish: vi.fn(async () => 'id-1'), extra: 'x' })

  it('sale.recorded aprovada com note_issuer_id enfileira invoice-<saleId>-1; publica antes', async () => {
    const base = inner()
    const enqueue = vi.fn(async () => undefined)
    const pub = invoiceSalePublisher(base as never, { enqueue })
    const data = { sale_id: sale.id, sale: { id: sale.id, status: 'approved', note_issuer_id: 'iss-1' } }
    await (pub as unknown as { publish: (...a: unknown[]) => Promise<unknown> }).publish('co-1', 'sale.recorded', data)
    expect(base.publish).toHaveBeenCalledWith('co-1', 'sale.recorded', data, undefined)
    expect(enqueue).toHaveBeenCalledWith(
      { companyId: 'co-1', saleId: sale.id, generation: 1 },
      { jobId: invoiceJobId(sale.id, 1) },
    )
    expect(invoiceJobId(sale.id, 1)).not.toContain(':')
    expect((pub as unknown as { extra: string }).extra).toBe('x')
  })

  it('sem note_issuer_id, pendente ou outro evento: não enfileira (AC-T112-02); falha ao enfileirar só loga', async () => {
    const enqueue = vi.fn(async () => {
      throw new Error('redis fora')
    })
    const warn = vi.fn()
    const pub = invoiceSalePublisher(inner() as never, { enqueue, logger: { warn } }) as unknown as {
      publish: (...a: unknown[]) => Promise<unknown>
    }
    await pub.publish('co', 'sale.recorded', {
      sale_id: 's1',
      sale: { id: 's1', status: 'approved', note_issuer_id: null },
    })
    await pub.publish('co', 'sale.recorded', {
      sale_id: 's2',
      sale: { id: 's2', status: 'approved', note_issuer_id: '  ' },
    })
    await pub.publish('co', 'sale.recorded', {
      sale_id: 's3',
      sale: { id: 's3', status: 'pending', note_issuer_id: 'iss' },
    })
    await pub.publish('co', 'chat.updated', { chat_id: 'c' })
    expect(enqueue).not.toHaveBeenCalled()
    await expect(
      pub.publish('co', 'sale.recorded', {
        sale_id: 's4',
        sale: { id: 's4', status: 'approved', note_issuer_id: 'iss' },
      }),
    ).resolves.toBe('id-1')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
