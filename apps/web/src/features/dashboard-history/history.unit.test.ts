import type { InfiniteData } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { dashboardTab } from '@/features/dashboard/tabs'
import { salesHistoryQuery, type SaleDto, type SalesPage } from './api'
import { exportState, flattenSales, formatAmount, formatSoldAt, historyParams, nowLocalIn, optional, parseAmount, prependSale, zonedToIso } from './logic'
import './register'
import { collectSaleSlots, registerSaleAction, registerSaleColumn, saleActions, saleColumns } from './slots'

const sale = (id: string, soldAt = '2026-03-09T12:00:00.000Z'): SaleDto => ({
  id,
  amount_cents: 1000,
  currency: 'BRL',
  sold_at: soldAt,
  status: 'paid',
  source: 'manual',
  external_id: null,
  source_id: null,
  ctwa_clid: null,
  contact_id: null,
  connection_id: null,
  product_id: null,
  product_name: null,
  instance_name: null,
  instance_number: null,
  lead_number: null,
  customer_name: null,
  note_issuer_id: null,
  utmify_integration_id: null,
  created_at: soldAt,
  updated_at: soldAt,
})

const page = (n: number, ids: string[], hasMore: boolean): SalesPage => ({ items: ids.map((id) => sale(id)), page: { page: n, limit: 20, has_more: hasMore } })
const data = (...pages: SalesPage[]): InfiniteData<SalesPage> => ({ pages, pageParams: pages.map((p) => p.page.page) })

describe('histórico com rolagem infinita (AC-T87-01)', () => {
  it('próxima página só quando has_more', () => {
    const q = salesHistoryQuery({ start_date: '2026-03-01', end_date: '2026-03-09' })
    expect(q.initialPageParam).toBe(1)
    const next = q.getNextPageParam as (last: SalesPage) => number | undefined
    expect(next(page(1, ['a'], true))).toBe(2)
    expect(next(page(3, ['a'], false))).toBeUndefined()
    expect(q.queryKey).toEqual(['dashboard', 'sales-history', { start_date: '2026-03-01', end_date: '2026-03-09' }])
  })

  it('junta as páginas sem repetir venda (paginação por deslocamento)', () => {
    expect(flattenSales(undefined)).toEqual([])
    const rows = flattenSales(data(page(1, ['a', 'b'], true), page(2, ['b', 'c'], false)))
    expect(rows.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('filtros do dashboard: período, conexões e produtos', () => {
    expect(historyParams({ start_date: '2026-03-01', end_date: '2026-03-09' }, [])).toEqual({ start_date: '2026-03-01', end_date: '2026-03-09' })
    expect(historyParams({ start_date: '2026-03-01', end_date: '2026-03-01' }, ['c1', 'c1'], { product_ids: ['p1', 'p2'] })).toEqual({
      start_date: '2026-03-01',
      end_date: '2026-03-01',
      connection_ids: 'c1',
      product_ids: 'p1,p2',
    })
  })
})

describe('venda criada vai para o topo (AC-T87-01)', () => {
  it('entra no início da 1ª página mesmo com sold_at antigo', () => {
    const before = data(page(1, ['a', 'b'], true), page(2, ['c'], false))
    const old = sale('new', '2020-01-01T00:00:00.000Z')
    const after = prependSale(before, old)
    expect(flattenSales(after).map((s) => s.id)).toEqual(['new', 'a', 'b', 'c'])
    expect(after.pageParams).toEqual([1, 2])
    expect(before.pages[0]!.items).toHaveLength(2)
  })

  it('não duplica se a venda já estava numa página (upsert)', () => {
    const after = prependSale(data(page(1, ['a'], true), page(2, ['x', 'c'], false)), sale('x'))
    expect(flattenSales(after).map((s) => s.id)).toEqual(['x', 'a', 'c'])
  })

  it('lista vazia/sem cache vira uma página com a venda', () => {
    expect(flattenSales(prependSale(undefined, sale('n'))).map((s) => s.id)).toEqual(['n'])
    expect(flattenSales(prependSale(data(page(1, [], false)), sale('n'))).map((s) => s.id)).toEqual(['n'])
  })
})

describe('exportar bloqueado com 0 linhas (AC-T87-01)', () => {
  it('0 linhas: desabilitado com o motivo "vazio"; com linhas: desabilitado "em breve" (sem backend)', () => {
    expect(exportState(0)).toEqual({ enabled: false, reason: 'empty' })
    expect(exportState(3)).toEqual({ enabled: false, reason: 'soon' })
  })
})

describe('formulário da venda', () => {
  it('valor em centavos: vírgula ou ponto, até 2 casas, nunca negativo', () => {
    expect(parseAmount('0')).toBe(0)
    expect(parseAmount('12,5')).toBe(1250)
    expect(parseAmount('12.50')).toBe(1250)
    expect(parseAmount('1.234,56')).toBe(123456)
    expect(parseAmount(' 99 ')).toBe(9900)
    expect(parseAmount('0.1')).toBe(10)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('-1')).toBeNull()
    expect(parseAmount('1,234')).toBeNull()
    expect(parseAmount('abc')).toBeNull()
  })

  it('data/hora da venda no fuso da empresa → ISO UTC', () => {
    expect(zonedToIso('2026-03-09T23:30', 'America/Sao_Paulo')).toBe('2026-03-10T02:30:00.000Z')
    expect(zonedToIso('2026-03-09T23:30', 'UTC')).toBe('2026-03-09T23:30:00.000Z')
    expect(zonedToIso('2026-07-01T12:00', 'Europe/Lisbon')).toBe('2026-07-01T11:00:00.000Z')
    expect(zonedToIso('2026-01-01T12:00', 'Europe/Lisbon')).toBe('2026-01-01T12:00:00.000Z')
    expect(zonedToIso('2026-03-09', 'UTC')).toBeNull()
    expect(zonedToIso('', 'UTC')).toBeNull()
  })

  it('padrão do campo: agora no fuso da empresa', () => {
    const now = new Date('2026-03-10T02:30:45Z')
    expect(nowLocalIn('America/Sao_Paulo', now)).toBe('2026-03-09T23:30')
    expect(nowLocalIn('UTC', now)).toBe('2026-03-10T02:30')
  })

  it('texto vazio vira null', () => {
    expect(optional('  ')).toBeNull()
    expect(optional(' Ana ')).toBe('Ana')
  })

  it('valor na moeda da venda e data no fuso', () => {
    expect(formatAmount(123456, 'BRL')).toBe('R$ 1.234,56')
    expect(formatAmount(1000, 'USD')).toBe('US$ 10,00')
    expect(formatAmount(1000, 'XX')).toBe('XX 10.00')
    expect(formatSoldAt('2026-03-10T02:30:00.000Z', 'America/Sao_Paulo')).toBe('09/03/2026 23:30')
  })
})

describe('slots por linha para a T114 e montagem', () => {
  it('colunas e ações registradas em ordem; o desregistro remove', () => {
    // T114: o slot real (sale-invoice) já entra pelo glob do histórico.
    const baseCols = saleColumns().map((c) => c.id)
    const baseActs = saleActions().map((a) => a.id)
    const offB = registerSaleColumn({ id: 't-b', header: () => 'B', cell: () => 'b', order: 2 })
    const offA = registerSaleColumn({ id: 't-a', header: () => 'A', cell: () => 'a', order: 1 })
    const offAct = registerSaleAction({ id: 't-act', render: (s) => s.id })
    expect(saleColumns().map((c) => c.id).filter((id) => !baseCols.includes(id))).toEqual(['t-a', 't-b'])
    expect(saleActions().filter((a) => a.id === 't-act').map((a) => a.render(sale('z')))).toEqual(['z'])
    offA()
    offB()
    offAct()
    expect(saleColumns().map((c) => c.id)).toEqual(baseCols)
    expect(saleActions().map((a) => a.id)).toEqual(baseActs)
  })

  it('descobre `sale-history-slot.tsx` de outros módulos (ignora formatos inválidos)', () => {
    const n = collectSaleSlots({
      '../sale-invoice/sale-history-slot.tsx': {
        saleHistorySlot: { columns: [{ id: 'nf', header: () => 'NF', cell: () => 'Sem emissor' }], actions: [{ id: 'reissue', render: () => null }] },
      },
      '../x/sale-history-slot.tsx': { saleHistorySlot: { columns: [{ id: 'bad' }] } },
      '../y/sale-history-slot.tsx': {},
    })
    expect(n).toBe(2)
    expect(saleColumns().map((c) => c.id)).toContain('nf')
    expect(saleActions().map((a) => a.id)).toContain('reissue')
  })

  it('o histórico ocupa o slot `history` da T78', () => {
    expect(dashboardTab('history')?.name).toBe('HistoryPanel')
  })
})
