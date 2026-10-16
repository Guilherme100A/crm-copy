// Estado do quadro aberto (puro, testável): colunas em ordem, cards carregados por coluna e os totais do servidor
// (`total_count` e soma dos valores por coluna, 04 §5.19). Mover card/coluna aplica a mudança na hora e devolve o
// corpo do `PATCH move` correspondente.
import type { BoardDto, CardDto, ColumnDto } from './api'

export interface ColumnTotals {
  count: number
  valueCents: number
}

export interface BoardState {
  crm: Pick<BoardDto, 'id' | 'name'>
  columns: ColumnDto[]
  cards: Record<string, CardDto[]>
  totals: Record<string, ColumnTotals>
}

export function initialBoardState(
  crm: Pick<BoardDto, 'id' | 'name'>,
  columns: ColumnDto[],
  pages: { columnId: string; items: CardDto[]; total: number }[],
  totals: Record<string, ColumnTotals>,
): BoardState {
  const cards: Record<string, CardDto[]> = {}
  const t: Record<string, ColumnTotals> = {}
  for (const c of columns) {
    const page = pages.find((p) => p.columnId === c.id)
    cards[c.id] = page?.items ?? []
    t[c.id] = totals[c.id] ?? { count: page?.total ?? cards[c.id]!.length, valueCents: sumValues(cards[c.id]!) }
  }
  return { crm: { id: crm.id, name: crm.name }, columns, cards, totals: t }
}

const sumValues = (cards: readonly CardDto[]) => cards.reduce((s, c) => s + (c.value_cents || 0), 0)

/** A coluna tem mais cards no servidor do que os carregados. */
export const hasMore = (state: BoardState, columnId: string): boolean =>
  (state.cards[columnId]?.length ?? 0) < (state.totals[columnId]?.count ?? 0)

export function appendCards(state: BoardState, columnId: string, items: readonly CardDto[], total?: number): BoardState {
  const current = state.cards[columnId] ?? []
  const seen = new Set(current.map((c) => c.id))
  const next = [...current, ...items.filter((c) => !seen.has(c.id))]
  const totals = total === undefined ? state.totals : { ...state.totals, [columnId]: { ...(state.totals[columnId] ?? { valueCents: 0 }), count: total } }
  return { ...state, cards: { ...state.cards, [columnId]: next }, totals }
}

export function findCard(state: BoardState, cardId: string): { columnId: string; index: number; card: CardDto } | null {
  for (const [columnId, list] of Object.entries(state.cards)) {
    const index = list.findIndex((c) => c.id === cardId)
    if (index >= 0) return { columnId, index, card: list[index]! }
  }
  return null
}

export interface CardMove {
  state: BoardState
  body: { new_column_id: string; before_card_id: string | null }
}

/**
 * Move o card para `toIndex` (índice final na coluna de destino; `undefined` = fim). Ajusta contagens e somas.
 * Devolve `null` se nada mudou ou o card/coluna não existe.
 */
export function moveCard(state: BoardState, cardId: string, toColumnId: string, toIndex?: number): CardMove | null {
  const from = findCard(state, cardId)
  if (!from || !state.cards[toColumnId]) return null
  const source = state.cards[from.columnId]!.filter((c) => c.id !== cardId)
  const target = from.columnId === toColumnId ? source : [...state.cards[toColumnId]!]
  const index = Math.max(0, Math.min(toIndex ?? target.length, target.length))
  if (from.columnId === toColumnId && index === from.index) return null
  const moved = { ...from.card, column_id: toColumnId }
  target.splice(index, 0, moved)
  const cards = { ...state.cards, [from.columnId]: source, [toColumnId]: target }
  let totals = state.totals
  if (from.columnId !== toColumnId) {
    const value = from.card.value_cents || 0
    const src = state.totals[from.columnId] ?? { count: 0, valueCents: 0 }
    const dst = state.totals[toColumnId] ?? { count: 0, valueCents: 0 }
    totals = {
      ...state.totals,
      [from.columnId]: { count: Math.max(0, src.count - 1), valueCents: Math.max(0, src.valueCents - value) },
      [toColumnId]: { count: dst.count + 1, valueCents: dst.valueCents + value },
    }
  }
  return { state: { ...state, cards, totals }, body: { new_column_id: toColumnId, before_card_id: target[index + 1]?.id ?? null } }
}

/** Reordena a coluna para `toIndex` (posições recompactadas 0..n-1). */
export function moveColumn(state: BoardState, columnId: string, toIndex: number): BoardState | null {
  const from = state.columns.findIndex((c) => c.id === columnId)
  if (from < 0) return null
  const index = Math.max(0, Math.min(toIndex, state.columns.length - 1))
  if (index === from) return null
  const columns = [...state.columns]
  columns.splice(index, 0, columns.splice(from, 1)[0]!)
  return { ...state, columns: columns.map((c, position) => (c.position === position ? c : { ...c, position })) }
}

/** Totais confirmados pelo servidor (resposta do `PATCH move`). */
export function applyTotals(state: BoardState, totals: Record<string, ColumnTotals>): BoardState {
  return { ...state, totals: { ...state.totals, ...totals } }
}

/** Atualiza o card com a versão do servidor, sem mudar a ordem local. */
export function replaceCard(state: BoardState, card: CardDto): BoardState {
  const at = findCard(state, card.id)
  if (!at) return state
  const list = [...state.cards[at.columnId]!]
  list[at.index] = { ...card, column_id: at.columnId }
  return { ...state, cards: { ...state.cards, [at.columnId]: list } }
}
