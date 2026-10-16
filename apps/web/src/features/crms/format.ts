// Formatos do kanban (04 §2, §5): BRL sem casas nos indicadores e na grade, com 2 casas em colunas e cards; percentuais
// com 1 casa; telefone BR legível; badge de não lidas "9+". O espaço não separável do Intl vira espaço comum.
import type { BoardDto } from './api'

const NBSP = /[\u00a0\u202f]/g

const moneyFormats = new Map<number, Intl.NumberFormat>()

/** `R$ 1.234` (`decimals` 0) ou `R$ 1.234,56` (`decimals` 2). */
export function formatBRL(cents: number, decimals: 0 | 2 = 2): string {
  let f = moneyFormats.get(decimals)
  if (!f) {
    f = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    moneyFormats.set(decimals, f)
  }
  return f.format((cents || 0) / 100).replace(NBSP, ' ')
}

const percentFormat = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** `33,3%` (o valor já vem em pontos percentuais). */
export function formatPercent(value: number): string {
  return `${percentFormat.format(Number.isFinite(value) ? value : 0)}%`
}

/** `+55 (11) 99999-8888` / `+55 (11) 3333-4444`; fora do Brasil devolve o E.164 como veio. */
export function formatPhone(e164: string | null | undefined): string | null {
  if (!e164) return null
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164)
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : e164
}

export const unreadLabel = (n: number): string | null => (n > 0 ? (n > 9 ? '9+' : String(n)) : null)

export interface Overview {
  boards: number
  cards: number
  valueCents: number
  conversions: number
  /** Σ conversões / Σ cards × 100 (0 sem cards). */
  conversionRate: number
}

/** Indicadores da lista: soma dos resumos de todos os quadros. */
export function overviewOf(boards: readonly BoardDto[]): Overview {
  let cards = 0
  let valueCents = 0
  let conversions = 0
  for (const b of boards) {
    cards += b.summary.total_cards
    valueCents += b.summary.total_value_cents
    conversions += b.summary.conversion_count
  }
  return { boards: boards.length, cards, valueCents, conversions, conversionRate: cards ? (conversions / cards) * 100 : 0 }
}

/** Busca local da lista (nome, sem diferenciar maiúsculas/acentos) com ordenação por `updated_at` desc. */
export function filterBoards(boards: readonly BoardDto[], search: string): BoardDto[] {
  const q = normalize(search.trim())
  return boards.filter((b) => !q || normalize(b.name).includes(q)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

const normalize = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

const AUTO_COLORS = ['#3B82F6', '#8B5CF6', '#F59E0B', '#10B981', '#EC4899', '#06B6D4', '#F97316', '#84CC16']

/** Cor da coluna: a escolhida ou a automática pela posição (04 §5.27). */
export const columnColor = (column: { accent_color: string | null; position: number }): string =>
  column.accent_color || AUTO_COLORS[column.position % AUTO_COLORS.length]!
