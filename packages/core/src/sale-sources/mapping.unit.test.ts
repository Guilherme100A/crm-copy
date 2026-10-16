import { describe, expect, it } from 'vitest'
import { parseJsonPath, readJsonPath, resolveSaleEvent, saleAmountToCents } from './mapping'

const body = {
  data: { id: 'ORD-1', status: 'Paid', valor: '1.299,90', buyer: { 'full name': 'Ana Lima', phone: '+55 (11) 98888-7777', email: ' ANA@X.COM ' } },
  itens: [{ produto: 'p1' }],
  tracking: { utm_source: 'facebook', clid: 'CL1' },
}
const mapping = {
  external_id: '$.data.id',
  status: '$.data.status',
  amount: '$.data.valor',
  phone: '$.data.buyer.phone',
  name: "$.data.buyer['full name']",
  email: 'data.buyer.email',
  product_id: '$.itens[0].produto',
  utm_source: '$.tracking.utm_source',
  ctwa_clid: '$.tracking.clid',
}

describe('JSONPath', () => {
  it('aceita $.a.b, [n], ["x"], [\'x y\'] e caminho sem $', () => {
    expect(parseJsonPath("$.a.b[0]['c d']")).toEqual(['a', 'b', 0, 'c d'])
    expect(parseJsonPath('a.b')).toEqual(['a', 'b'])
    expect(parseJsonPath('$["x"]')).toEqual(['x'])
    expect(parseJsonPath('$.a[')).toBeNull()
    expect(readJsonPath(body, '$.itens[0].produto')).toBe('p1')
    expect(readJsonPath(body, '$.nao.existe')).toBeUndefined()
    expect(readJsonPath(body, '$.__proto__')).toBeUndefined()
  })
})

describe('resolveSaleEvent', () => {
  it('resolve o SaleEvent (status do mapa padrão, valor BR, telefone E.164, e-mail normalizado, atribuição)', () => {
    const r = resolveSaleEvent(body, { mapping })
    expect(r).toEqual({
      ok: true,
      event: {
        external_id: 'ORD-1',
        status: 'approved',
        amount_cents: 129990,
        currency: 'BRL',
        sold_at: null,
        customer: { phone: '+5511988887777', name: 'Ana Lima', email: 'ana@x.com' },
        product_id: 'p1',
        attribution: { utm_source: 'facebook', utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null, ctwa_clid: 'CL1', source_id: null, source_url: null },
      },
    })
  })

  it('caminho obrigatório ausente → missing com campo e caminho; status desconhecido e valor inválido → errors', () => {
    const r = resolveSaleEvent({ data: { id: 'X' } }, { mapping })
    expect(r).toMatchObject({ ok: false, missing: [{ field: 'status', path: '$.data.status' }, { field: 'amount', path: '$.data.valor' }, { field: 'phone', path: '$.data.buyer.phone' }] })
    expect(resolveSaleEvent({ ...body, data: { ...body.data, status: 'Concluido' } }, { mapping })).toMatchObject({ ok: false, errors: ['unknown_status:Concluido'] })
    expect(resolveSaleEvent({ ...body, data: { ...body.data, status: 'CONCLUIDO' } }, { mapping, statusMap: { concluido: 'approved' } })).toMatchObject({ ok: true })
    expect(resolveSaleEvent({ ...body, data: { ...body.data, valor: 'abc' } }, { mapping })).toMatchObject({ ok: false, errors: ['invalid_value:amount'] })
  })

  it('valor em centavos e decimal', () => {
    expect(saleAmountToCents('199.90', 'decimal')).toBe(19990)
    expect(saleAmountToCents(19990, 'cents')).toBe(19990)
    expect(saleAmountToCents('19990', 'cents')).toBe(19990)
    expect(saleAmountToCents(-1, 'decimal')).toBeNull()
  })
})
