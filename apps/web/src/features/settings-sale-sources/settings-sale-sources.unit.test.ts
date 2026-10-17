import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS } from '../settings/tabs'
import { EVENTS_POLL_MS, eventsPages, hasPending, pollInterval, prettyJson } from './events'
import {
  childPath,
  cleanMapping,
  DEFAULT_MAPPING,
  generateSecret,
  mappingIssues,
  parseJsonPath,
  parseSample,
  signBody,
  statusMapFrom,
  statusRowsFrom,
  validSourceName,
} from './rules'
import type { InboundSaleEventDto } from './api'

describe('fontes de venda (T90)', () => {
  it('JSONPath igual ao do servidor', () => {
    expect(parseJsonPath('$.a.b')).toEqual(['a', 'b'])
    expect(parseJsonPath('$.x[0].y')).toEqual(['x', 0, 'y'])
    expect(parseJsonPath("$['a b']")).toEqual(['a b'])
    expect(parseJsonPath('data.id')).toEqual(['data', 'id'])
    for (const bad of ['', '$', '$.', '$..a', '$[x]', '$.a[']) expect(parseJsonPath(bad)).toBeNull()
    // Como no servidor, sem `$.` o primeiro segmento é solto.
    expect(parseJsonPath('$a b')).toEqual(['a b'])
  })

  it('caminho da árvore da amostra volta pelo parser', () => {
    expect(childPath('', 'data')).toBe('$.data')
    expect(childPath('$.data', 0)).toBe('$.data[0]')
    expect(childPath('$', 'first name')).toBe("$['first name']")
    expect(parseJsonPath(childPath(childPath('', 'buyer info'), 'phone'))).toEqual(['buyer info', 'phone'])
  })

  it('mapeamento: obrigatórios vazios e caminhos inválidos; só campos preenchidos são enviados', () => {
    expect(mappingIssues(DEFAULT_MAPPING)).toEqual({})
    expect(mappingIssues({ external_id: '$.id', status: '', amount: '$..x', phone: '$.p', email: '$[bad]' })).toEqual({
      status: 'required',
      amount: 'invalid',
      email: 'invalid',
    })
    expect(mappingIssues({ ...DEFAULT_MAPPING, utm_source: '$.'.padEnd(301, 'a') })).toEqual({ utm_source: 'invalid' })
    expect(cleanMapping({ external_id: ' $.id ', name: '   ', product_id: '$.product' })).toEqual({
      external_id: '$.id',
      product_id: '$.product',
    })
  })

  it('mapa de status: valor bruto aparado em minúsculas, linhas vazias saem', () => {
    expect(
      statusMapFrom([
        { raw: ' PAGO ', status: 'approved' },
        { raw: '', status: 'pending' },
        { raw: 'Estornado', status: 'refunded' },
      ]),
    ).toEqual({ pago: 'approved', estornado: 'refunded' })
    expect(statusRowsFrom({ paid: 'approved', x: 'nope' })).toEqual([{ raw: 'paid', status: 'approved' }])
    expect(statusRowsFrom(null)).toEqual([])
  })

  it('nome de 2 a 120 caracteres', () => {
    expect(validSourceName(' a ')).toBe(false)
    expect(validSourceName('ab')).toBe(true)
    expect(validSourceName('x'.repeat(121))).toBe(false)
  })

  it('amostra: JSON válido ou erro (sem chamar o servidor)', () => {
    expect(parseSample('{"id":1}')).toEqual({ ok: true, value: { id: 1 } })
    expect(parseSample('{id:1}')).toEqual({ ok: false })
    expect(parseSample('  ')).toEqual({ ok: false })
  })

  it('segredo HMAC forte gerado no navegador (64 hex) e assinatura igual à do recebimento', async () => {
    const s = generateSecret()
    expect(s).toMatch(/^[0-9a-f]{64}$/)
    expect(generateSecret()).not.toBe(s)
    expect(generateSecret(2, (a) => a.fill(10))).toBe('0a0a')
    const body = '{"id":"1","status":"paid"}'
    expect(await signBody(s, body)).toBe(createHmac('sha256', s).update(body, 'utf8').digest('hex'))
  })

  it('log: páginas, pendentes (refetch) e corpo formatado', () => {
    expect(eventsPages(0)).toBe(1)
    expect(eventsPages(41, 20)).toBe(3)
    const ev = (status: InboundSaleEventDto['status']) => ({ status }) as InboundSaleEventDto
    expect(hasPending([ev('processed'), ev('failed')])).toBe(false)
    expect(hasPending([ev('processed'), ev('pending')])).toBe(true)
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('not json')).toBe('not json')
    // Refetch: com pendente na página, ou até o fim da janela depois de um replay (o evento sai do filtro enquanto pendente).
    expect(pollInterval([ev('pending')], 0, 1000)).toBe(EVENTS_POLL_MS)
    expect(pollInterval([], 2000, 1000)).toBe(EVENTS_POLL_MS)
    expect(pollInterval([ev('failed')], 1000, 1000)).toBe(false)
    expect(pollInterval(undefined, 0, 1000)).toBe(false)
  })

  it('aba sale_sources no grupo Integrações com settings.integrations.view', () => {
    expect(SETTINGS_TABS.find((x) => x.id === 'sale_sources')).toMatchObject({
      group: 'integrations',
      labelKey: 'settings-sale-sources:tab',
      permissions: ['settings.integrations.view'],
    })
  })
})
