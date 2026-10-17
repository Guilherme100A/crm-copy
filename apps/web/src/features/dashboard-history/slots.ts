// Slots por linha do histórico de vendas (T87 → T114): outra feature pluga uma coluna (ex.: "NF" com o status da nota)
// ou uma ação (ex.: "Reemitir nota") sem editar esta pasta. Como os slots do chat (T69), cada módulo cria
// `src/features/<módulo>/sale-history-slot.tsx` exportando
//   export const saleHistorySlot: SaleHistorySlot = { columns: [...], actions: [...] }
// e o histórico descobre o arquivo por glob (Vite). O arquivo do slot só faz `import type` daqui (evita ciclo de import).
// Ordem: `order` crescente, depois a de caminho/registro. `registerSaleColumn`/`registerSaleAction` também valem.
import type { ReactNode } from 'react'
import type { SaleDto } from './api'

export interface SaleColumnSlot {
  id: string
  /** Cabeçalho da coluna (texto já traduzido pelo dono do slot). */
  header: () => ReactNode
  cell: (sale: SaleDto) => ReactNode
  order?: number
}

export interface SaleActionSlot {
  id: string
  /** Botão/menu da ação; `null` esconde a ação nesta linha. */
  render: (sale: SaleDto) => ReactNode
  order?: number
}

export interface SaleHistorySlot {
  columns?: SaleColumnSlot[]
  actions?: SaleActionSlot[]
}

const columns = new Map<string, SaleColumnSlot>()
const actions = new Map<string, SaleActionSlot>()

function register<S extends { id: string }>(map: Map<string, S>, slot: S): () => void {
  map.set(slot.id, slot)
  return () => {
    if (map.get(slot.id) === slot) map.delete(slot.id)
  }
}

const ordered = <S extends { order?: number }>(map: Map<string, S>): S[] =>
  [...map.values()]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order ?? 0) - (b.s.order ?? 0) || a.i - b.i)
    .map(({ s }) => s)

export const registerSaleColumn = (slot: SaleColumnSlot): (() => void) => register(columns, slot)
export const registerSaleAction = (slot: SaleActionSlot): (() => void) => register(actions, slot)
export const saleColumns = (): SaleColumnSlot[] => ordered(columns)
export const saleActions = (): SaleActionSlot[] => ordered(actions)

const isColumn = (v: unknown): v is SaleColumnSlot => !!v && typeof (v as SaleColumnSlot).id === 'string' && typeof (v as SaleColumnSlot).header === 'function' && typeof (v as SaleColumnSlot).cell === 'function'
const isAction = (v: unknown): v is SaleActionSlot => !!v && typeof (v as SaleActionSlot).id === 'string' && typeof (v as SaleActionSlot).render === 'function'

/** Registra os slots dos módulos encontrados pelo glob (em ordem de caminho); devolve quantos entraram. */
export function collectSaleSlots(modules: Record<string, unknown>): number {
  let n = 0
  for (const path of Object.keys(modules).sort()) {
    const slot = (modules[path] as { saleHistorySlot?: SaleHistorySlot } | undefined)?.saleHistorySlot
    if (!slot || typeof slot !== 'object') continue
    for (const c of Array.isArray(slot.columns) ? slot.columns : []) {
      if (!isColumn(c)) continue
      registerSaleColumn(c)
      n++
    }
    for (const a of Array.isArray(slot.actions) ? slot.actions : []) {
      if (!isAction(a)) continue
      registerSaleAction(a)
      n++
    }
  }
  return n
}
