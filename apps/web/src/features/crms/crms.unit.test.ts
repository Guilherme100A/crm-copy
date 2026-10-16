import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { configureHttp } from '@/lib/http'
import { boardQuery, fetchMoreCards, moveCardRequest, type BoardDto, type CardDto, type ColumnDto } from './api'
import { appendCards, applyTotals, hasMore, initialBoardState, moveCard, moveColumn, type BoardState } from './board-state'
import { columnColor, filterBoards, formatBRL, formatPercent, formatPhone, overviewOf, unreadLabel } from './format'

afterEach(() => configureHttp({ companyId: null }))

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const col = (id: string, position: number, extra: Partial<ColumnDto> = {}): ColumnDto => ({
  id,
  crm_id: 'b1',
  name: id.toUpperCase(),
  position,
  accent_color: null,
  conversion_goal: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...extra,
})

const card = (id: string, columnId: string, valueCents = 0): CardDto => ({
  id,
  crm_id: 'b1',
  column_id: columnId,
  chat_id: `chat-${id}`,
  position: 0,
  value_cents: valueCents,
  value: valueCents / 100,
  currency: 'BRL',
  chat: { status: 'open', unread_count: 0, last_message_preview: null },
  customer: { name: id, phone_e164: null },
  label_ids: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
})

const board = (id: string, name: string, s: Partial<BoardDto['summary']> = {}, updated = '2026-01-01T00:00:00.000Z'): BoardDto => ({
  id,
  name,
  columns: [],
  quantity_of_columns: 0,
  summary: { total_cards: 0, total_value_cents: 0, total_value: 0, conversion_count: 0, conversion_rate: 0, ...s },
  created_at: updated,
  updated_at: updated,
})

function sample(): BoardState {
  return initialBoardState(
    { id: 'b1', name: 'Vendas' },
    [col('a', 0), col('b', 1), col('c', 2)],
    [
      { columnId: 'a', items: [card('1', 'a', 1000), card('2', 'a', 500), card('3', 'a')], total: 3 },
      { columnId: 'b', items: [card('4', 'b', 200)], total: 25 },
      { columnId: 'c', items: [], total: 0 },
    ],
    { a: { count: 3, valueCents: 1500 }, b: { count: 25, valueCents: 9000 }, c: { count: 0, valueCents: 0 } },
  )
}

describe('formatos (AC-T70-01/04)', () => {
  it('BRL sem casas e com 2 casas, com espaço comum', () => {
    expect(formatBRL(123456, 0)).toBe('R$ 1.235')
    expect(formatBRL(123400, 0)).toBe('R$ 1.234')
    expect(formatBRL(123456)).toBe('R$ 1.234,56')
    expect(formatBRL(0, 0)).toBe('R$ 0')
  })

  it('percentual com 1 casa', () => {
    expect(formatPercent(33.333)).toBe('33,3%')
    expect(formatPercent(0)).toBe('0,0%')
    expect(formatPercent(100)).toBe('100,0%')
    expect(formatPercent(Number.NaN)).toBe('0,0%')
  })

  it('telefone BR legível; outros países como vieram', () => {
    expect(formatPhone('+5511999998888')).toBe('+55 (11) 99999-8888')
    expect(formatPhone('+551133334444')).toBe('+55 (11) 3333-4444')
    expect(formatPhone('+14155550100')).toBe('+14155550100')
    expect(formatPhone(null)).toBeNull()
  })

  it('não lidas: oculto em 0 e 9+ acima de 9', () => {
    expect(unreadLabel(0)).toBeNull()
    expect(unreadLabel(3)).toBe('3')
    expect(unreadLabel(9)).toBe('9')
    expect(unreadLabel(10)).toBe('9+')
  })

  it('cor automática por posição quando não há cor', () => {
    expect(columnColor({ accent_color: '#111111', position: 0 })).toBe('#111111')
    expect(columnColor({ accent_color: null, position: 8 })).toBe(columnColor({ accent_color: null, position: 0 }))
  })
})

describe('lista de quadros (AC-T70-01)', () => {
  it('indicadores: conversão média = Σ conversões / Σ cards', () => {
    const o = overviewOf([
      board('x', 'A', { total_cards: 2, total_value_cents: 1000, conversion_count: 1 }),
      board('y', 'B', { total_cards: 4, total_value_cents: 500, conversion_count: 1 }),
    ])
    expect(o).toEqual({ boards: 2, cards: 6, valueCents: 1500, conversions: 2, conversionRate: (2 / 6) * 100 })
    expect(formatPercent(o.conversionRate)).toBe('33,3%')
    expect(overviewOf([]).conversionRate).toBe(0)
  })

  it('busca local sem diferenciar maiúsculas/acentos e ordena por updated_at desc', () => {
    const list = [board('1', 'Pós-venda', {}, '2026-01-01T00:00:00.000Z'), board('2', 'Vendas', {}, '2026-03-01T00:00:00.000Z'), board('3', 'Suporte', {}, '2026-02-01T00:00:00.000Z')]
    expect(filterBoards(list, '').map((b) => b.id)).toEqual(['2', '3', '1'])
    expect(filterBoards(list, 'VEND').map((b) => b.id)).toEqual(['2', '1'])
    expect(filterBoards(list, 'pos').map((b) => b.id)).toEqual(['1'])
    expect(filterBoards(list, 'nada')).toEqual([])
  })
})

describe('estado do quadro (AC-T70-02/03)', () => {
  it('mover entre colunas atualiza contagens e somas e calcula before_card_id', () => {
    const r = moveCard(sample(), '1', 'b', 0)!
    expect(r.body).toEqual({ new_column_id: 'b', before_card_id: '4' })
    expect(r.state.cards.a!.map((c) => c.id)).toEqual(['2', '3'])
    expect(r.state.cards.b!.map((c) => c.id)).toEqual(['1', '4'])
    expect(r.state.cards.b![0]!.column_id).toBe('b')
    expect(r.state.totals.a).toEqual({ count: 2, valueCents: 500 })
    expect(r.state.totals.b).toEqual({ count: 26, valueCents: 10000 })
  })

  it('soltar no fim / em coluna vazia manda before_card_id null', () => {
    expect(moveCard(sample(), '2', 'c')!.body).toEqual({ new_column_id: 'c', before_card_id: null })
    expect(moveCard(sample(), '1', 'a', 2)!.body).toEqual({ new_column_id: 'a', before_card_id: null })
  })

  it('reordenar dentro da coluna não muda totais; mesma posição não gera movimento', () => {
    const r = moveCard(sample(), '3', 'a', 0)!
    expect(r.state.cards.a!.map((c) => c.id)).toEqual(['3', '1', '2'])
    expect(r.body.before_card_id).toBe('1')
    expect(r.state.totals).toEqual(sample().totals)
    expect(moveCard(sample(), '1', 'a', 0)).toBeNull()
    expect(moveCard(sample(), 'x', 'a', 0)).toBeNull()
  })

  it('totais do servidor substituem os otimistas', () => {
    const r = moveCard(sample(), '1', 'b', 0)!
    expect(applyTotals(r.state, { b: { count: 30, valueCents: 1 } }).totals.b).toEqual({ count: 30, valueCents: 1 })
  })

  it('reordenar coluna recompacta posições', () => {
    const s = moveColumn(sample(), 'c', 0)!
    expect(s.columns.map((c) => [c.id, c.position])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ])
    expect(moveColumn(sample(), 'a', 0)).toBeNull()
  })

  it('carregar mais: anexa sem duplicar e sabe quando acabou', () => {
    const s = sample()
    expect(hasMore(s, 'b')).toBe(true)
    expect(hasMore(s, 'a')).toBe(false)
    const next = appendCards(s, 'b', [card('4', 'b'), card('5', 'b')], 25)
    expect(next.cards.b!.map((c) => c.id)).toEqual(['4', '5'])
  })
})

describe('api do quadro', () => {
  it('carrega o quadro com a 1ª página de cada coluna (20) e os totais', async () => {
    const calls: string[] = []
    configureHttp({
      fetch: async (url) => {
        calls.push(url)
        if (url === '/api/crms/b1') return json({ crm: { ...board('b1', 'Vendas'), columns: [col('b', 1), col('a', 0)] } })
        const column = new URL(url, 'http://x').searchParams.get('column_id')!
        return json({
          items: [card(`${column}1`, column, 100)],
          page: { page: 1, limit: 20, total_count: 1, has_more: false },
          columns: [
            { column_id: 'a', total_count: 1, total_value_cents: 100 },
            { column_id: 'b', total_count: 1, total_value_cents: 100 },
          ],
        })
      },
    })
    const qc = new QueryClient()
    const state = await qc.fetchQuery(boardQuery(qc, 'b1'))
    expect(state.columns.map((c) => c.id)).toEqual(['a', 'b'])
    expect(state.cards.a!.map((c) => c.id)).toEqual(['a1'])
    expect(state.totals.b).toEqual({ count: 1, valueCents: 100 })
    expect(calls).toContain('/api/crms/b1/cards?column_id=a&page=1&limit=20')
  })

  it('carregar mais pede a página seguinte; mover manda o corpo da T50', async () => {
    const seen: { url: string; body?: string }[] = []
    configureHttp({
      fetch: async (url, init) => {
        seen.push({ url, body: typeof init.body === 'string' ? init.body : undefined })
        if (url.includes('/move'))
          return json({ card: card('1', 'b'), columns: [{ column_id: 'b', total_count: 2, total_value_cents: 0 }] })
        return json({ items: [], page: { page: 2, limit: 20, total_count: 21, has_more: false }, columns: [] })
      },
    })
    await fetchMoreCards('b1', 'a', 20)
    expect(seen[0]!.url).toBe('/api/crms/b1/cards?column_id=a&page=2&limit=20')
    const r = await moveCardRequest('b1', '1', { new_column_id: 'b', before_card_id: null })
    expect(JSON.parse(seen[1]!.body!)).toEqual({ new_column_id: 'b', before_card_id: null })
    expect(r.totals).toEqual({ b: { count: 2, valueCents: 0 } })
  })
})
