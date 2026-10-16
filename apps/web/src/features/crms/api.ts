// Dados do kanban (T70 sobre a API da T50): lista de quadros com resumo, quadro com colunas e cards paginados por
// coluna (20), mover card/coluna. O quadro aberto vive no cache do TanStack Query (`boardQuery`) e as ações aplicam o
// resultado nele de forma otimista; um refetch recarrega cada coluna com tantos cards quantos já estavam carregados.
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { api, HttpError } from '@/lib/http'
import { initialBoardState, type BoardState, type ColumnTotals } from './board-state'

export interface ColumnDto {
  id: string
  crm_id: string
  name: string
  position: number
  accent_color: string | null
  conversion_goal: boolean
  created_at: string
  updated_at: string
}

export interface BoardDto {
  id: string
  name: string
  columns: ColumnDto[]
  quantity_of_columns: number
  summary: { total_cards: number; total_value_cents: number; total_value: number; conversion_count: number; conversion_rate: number }
  created_at: string
  updated_at: string
}

export interface CardDto {
  id: string
  crm_id: string
  column_id: string
  chat_id: string
  position: number
  value_cents: number
  value: number
  currency: string
  chat: { status: string; unread_count: number; last_message_preview: string | null }
  customer: { name: string; phone_e164: string | null }
  label_ids: string[]
  created_at: string
  updated_at: string
}

export interface ColumnTotalsDto {
  column_id: string
  total_count: number
  total_value_cents: number
}

interface CardsPage {
  items: CardDto[]
  page: { page: number; limit: number; total: number }
  columns: ColumnTotalsDto[]
}

export const CARD_PAGE_SIZE = 20
const MAX_LIMIT = 120

const enc = encodeURIComponent

export const CRMS_KEY = ['crms'] as const
export const boardsKey = [...CRMS_KEY, 'list'] as const
export const boardKey = (id: string) => [...CRMS_KEY, 'board', id] as const

export const boardsQuery = () =>
  queryOptions({ queryKey: boardsKey, queryFn: async () => (await api.get<{ items: BoardDto[] }>('/api/crms')).items })

const totalsOf = (columns: readonly ColumnTotalsDto[]): Record<string, ColumnTotals> =>
  Object.fromEntries(columns.map((c) => [c.column_id, { count: c.total_count, valueCents: c.total_value_cents }]))

const fetchCards = (crmId: string, columnId: string, page: number, limit: number) =>
  api.get<CardsPage>(`/api/crms/${enc(crmId)}/cards`, { query: { column_id: columnId, page, limit } })

/** Quadro + primeira página de cada coluna (ou o tanto já carregado, num refetch). */
export const boardQuery = (queryClient: QueryClient, crmId: string) =>
  queryOptions({
    queryKey: boardKey(crmId),
    queryFn: async (): Promise<BoardState> => {
      const prev = queryClient.getQueryData<BoardState>(boardKey(crmId))
      const { crm } = await api.get<{ crm: BoardDto }>(`/api/crms/${enc(crmId)}`)
      const columns = [...crm.columns].sort((a, b) => a.position - b.position)
      const pages = await Promise.all(
        columns.map((c) => {
          const loaded = prev?.cards[c.id]?.length ?? 0
          const limit = Math.min(MAX_LIMIT, Math.max(CARD_PAGE_SIZE, loaded))
          return fetchCards(crmId, c.id, 1, limit)
        }),
      )
      const totals = pages[0] ? totalsOf(pages[0].columns) : {}
      return initialBoardState(
        crm,
        columns,
        columns.map((c, i) => ({ columnId: c.id, items: pages[i]!.items, total: pages[i]!.page.total })),
        totals,
      )
    },
  })

/** Próxima página da coluna (sem repetir cards já carregados). */
export async function fetchMoreCards(crmId: string, columnId: string, loaded: number): Promise<{ items: CardDto[]; total: number }> {
  // Página de 20 alinhada ao que já está na tela; se o quadro mudou no meio, o dedupe do estado resolve.
  const page = Math.floor(loaded / CARD_PAGE_SIZE) + 1
  const r = await fetchCards(crmId, columnId, page, CARD_PAGE_SIZE)
  return { items: r.items, total: r.page.total }
}

export async function moveCardRequest(crmId: string, cardId: string, body: { new_column_id: string; before_card_id: string | null }) {
  const r = await api.patch<{ card: CardDto; columns: ColumnTotalsDto[] }>(`/api/crms/${enc(crmId)}/cards/${enc(cardId)}/move`, body)
  return { card: r.card, totals: totalsOf(r.columns) }
}

export async function moveColumnRequest(crmId: string, columnId: string, position: number) {
  return (await api.patch<{ columns: ColumnDto[] }>(`/api/crms/${enc(crmId)}/columns/${enc(columnId)}/move`, { position })).columns
}

export interface LabelOption {
  id: string
  name: string
  color?: string | null
}

/** Nomes das etiquetas (as mesmas opções do filtro de chats); sem acesso, os chips não aparecem. */
export const labelsQuery = () =>
  queryOptions({
    queryKey: [...CRMS_KEY, 'labels'] as const,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, LabelOption>> => {
      try {
        const r = await api.get<{ labels?: LabelOption[] }>('/api/chats/filter-options')
        return Object.fromEntries((r.labels ?? []).map((l) => [l.id, l]))
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return {}
        throw err
      }
    },
  })
