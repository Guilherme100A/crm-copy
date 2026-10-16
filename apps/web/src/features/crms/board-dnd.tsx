// Quadro arrastável (04 §2 "board"/"Coluna"): o @dnd-kit/react 0.5.1 (STACK D §5, 0.x) fica isolado neste arquivo.
// Cards são sortables do grupo da coluna (o card inteiro é a alça); colunas são sortables do tipo `column`, arrastadas
// pela alça do cabeçalho. Durante o arrasto a ordem vive numa prévia local (`move()` no dragover); ao soltar, a
// mudança vai para `onMoveCard`/`onMoveColumn` e a prévia some quando o estado do quadro chega.
import { Feedback } from '@dnd-kit/dom'
import { move } from '@dnd-kit/helpers'
import { DragDropProvider, KeyboardSensor, PointerSensor, type DragDropManager, type DragEndEvent, type DragOverEvent } from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { GripVertical, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { CardDto, ColumnDto, LabelOption } from './api'
import { hasMore, type BoardState } from './board-state'
import { CardView } from './card-view'
import { columnColor, formatBRL } from './format'

interface Order {
  columns: string[]
  cards: Record<string, string[]>
}

const orderOf = (state: BoardState): Order => ({
  columns: state.columns.map((c) => c.id),
  cards: Object.fromEntries(state.columns.map((c) => [c.id, (state.cards[c.id] ?? []).map((k) => k.id)])),
})

// Enter abre o card; o arrasto por teclado começa no Espaço (setas movem, Espaço/Tab solta, Esc cancela).
const SENSORS = [
  PointerSensor,
  KeyboardSensor.configure({
    keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Tab'], up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'] },
  }),
]

// Sem animação de soltura: o estado do quadro muda no dragend e o React reposiciona o elemento no meio da animação,
// cuja promise não termina; o clone (`data-dnd-placeholder`) ficaria preso no DOM.
const NO_DROP_ANIMATION = <T extends readonly unknown[]>(defaults: T) => [...defaults, Feedback.configure({ dropAnimation: null })]

/** `CollisionPriority.Low` do @dnd-kit/abstract: a coluna só ganha do card quando não há card sob o ponteiro. */
const COLUMN_COLLISION_PRIORITY = 1

export interface KanbanBoardProps {
  state: BoardState
  labels: Record<string, LabelOption>
  loadingMore: Record<string, boolean>
  onOpenCard: (card: CardDto) => void
  onMoveCard: (cardId: string, toColumnId: string, toIndex?: number) => void
  onMoveColumn: (columnId: string, toIndex: number) => void
  onLoadMore: (columnId: string) => void
}

export function KanbanBoard({ state, labels, loadingMore, onOpenCard, onMoveCard, onMoveColumn, onLoadMore }: KanbanBoardProps) {
  const [preview, setPreview] = useState<Order | null>(null)
  const dragging = useRef(false)
  const base = useMemo(() => orderOf(state), [state])

  // O estado do quadro mudou (soltura aplicada, refetch): a prévia deixa de valer.
  useEffect(() => {
    if (!dragging.current) setPreview(null)
  }, [state])

  const order = preview ?? base
  const columnsById = useMemo(() => new Map(state.columns.map((c) => [c.id, c])), [state.columns])
  const cardsById = useMemo(() => new Map(Object.values(state.cards).flatMap((l) => l.map((c) => [c.id, c] as const))), [state.cards])

  const onDragOver = (event: DragOverEvent) => {
    if (event.operation.source?.type !== 'card') return
    setPreview((p) => {
      const current = p ?? base
      const cards = move(current.cards, event)
      return cards === current.cards ? current : { ...current, cards }
    })
  }

  /** O que fazer ao soltar (calculado com o snapshot do dragend). */
  const dropAction = (event: DragEndEvent): (() => void) => {
    const clear = () => setPreview(null)
    const { source } = event.operation
    if (event.canceled || !source) return clear
    const id = String(source.id)
    if (source.type === 'column') {
      const columns = move(order.columns, event)
      const to = columns.indexOf(id)
      if (to < 0 || to === base.columns.indexOf(id)) return clear
      return () => {
        setPreview({ ...order, columns })
        onMoveColumn(id, to)
      }
    }
    const finalCards = preview?.cards ?? base.cards
    const toColumn = Object.keys(finalCards).find((k) => finalCards[k]!.includes(id))
    const fromColumn = Object.keys(base.cards).find((k) => base.cards[k]!.includes(id))
    if (!toColumn || !fromColumn) return clear
    const to = finalCards[toColumn]!.indexOf(id)
    if (toColumn === fromColumn && to === base.cards[fromColumn]!.indexOf(id)) return clear
    return () => onMoveCard(id, toColumn, to)
  }

  // O dnd-kit chama o dragend dentro de um startTransition e só encerra a soltura (status `dropped`, remoção do
  // placeholder) quando essa transition faz commit. Atualizar o quadro ali dentro, com o DOM reordenado pelo
  // OptimisticSortingPlugin, às vezes deixava a transition sem commit: coluna presa em `data-dnd-dragging` e clone no
  // DOM. Por isso a mudança só é aplicada depois que a renderização do dragend termina.
  const onDragEnd = (event: DragEndEvent, manager: DragDropManager) => {
    dragging.current = false
    const action = dropAction(event)
    void manager.renderer.rendering.then(() => setTimeout(action, 0))
  }

  return (
    <DragDropProvider
      sensors={SENSORS}
      onDragStart={() => {
        dragging.current = true
      }}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      <div
        data-testid="crms-board-scroll"
        className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-3 lg:snap-none"      >
        {order.columns.map((columnId, index) => {
          const column = columnsById.get(columnId)
          if (!column) return null
          const cards = (order.cards[columnId] ?? []).map((cid) => cardsById.get(cid)).filter((c): c is CardDto => !!c)
          return (
            <SortableColumn
              key={columnId}
              column={column}
              index={index}
              totals={state.totals[columnId] ?? { count: 0, valueCents: 0 }}
              more={hasMore(state, columnId)}
              loadingMore={!!loadingMore[columnId]}
              onLoadMore={() => onLoadMore(columnId)}
            >
              {cards.map((card, i) => (
                <SortableCard
                  key={card.id}
                  card={card}
                  columnId={columnId}
                  index={i}
                  columns={state.columns}
                  labels={labels}
                  onOpen={() => onOpenCard(card)}
                  onMoveTo={(to) => onMoveCard(card.id, to)}
                />
              ))}
            </SortableColumn>
          )
        })}
      </div>
    </DragDropProvider>
  )
}

function SortableColumn({
  column,
  index,
  totals,
  more,
  loadingMore,
  onLoadMore,
  children,
}: {
  column: ColumnDto
  index: number
  totals: { count: number; valueCents: number }
  more: boolean
  loadingMore: boolean
  onLoadMore: () => void
  children: React.ReactNode[]
}) {
  const t = useT('crms')
  const { ref, handleRef, isDragging } = useSortable({
    id: column.id,
    index,
    type: 'column',
    accept: ['card', 'column'],
    collisionPriority: COLUMN_COLLISION_PRIORITY,
    plugins: NO_DROP_ANIMATION,
  })
  const color = columnColor(column)
  return (
    <section
      ref={ref}
      data-testid={`crms-column-${column.id}`}
      data-column-id={column.id}
      data-position={index}
      aria-label={column.name}
      className={cn(
        'flex max-h-full w-[85vw] max-w-80 shrink-0 snap-start flex-col rounded-xl border bg-muted/40 sm:w-72',
        isDragging && 'opacity-60 ring-2 ring-primary/40',
      )}
      style={{ scrollSnapAlign: 'start' } as CSSProperties}
    >
      <header className="flex items-center gap-2 border-b px-2 py-2" style={{ borderTop: `3px solid ${color}`, borderTopLeftRadius: 12, borderTopRightRadius: 12 }}>
        <button
          ref={handleRef}
          type="button"
          data-testid={`crms-column-handle-${column.id}`}
          aria-label={t('board.dragColumn', { name: column.name })}
          className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <h2 data-testid={`crms-column-name-${column.id}`} className="min-w-0 flex-1 truncate text-sm font-semibold">
          {column.name}
        </h2>
        <span data-testid={`crms-column-count-${column.id}`} className="rounded-full bg-background px-2 py-0.5 text-xs font-medium tabular-nums">
          {totals.count}
        </span>
      </header>
      <p data-testid={`crms-column-value-${column.id}`} className="px-3 pt-2 text-xs font-medium text-muted-foreground tabular-nums">
        {formatBRL(totals.valueCents)}
      </p>
      <div data-testid={`crms-column-cards-${column.id}`} className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {children}
        {children.length === 0 ? (
          <p data-testid={`crms-column-empty-${column.id}`} className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            {t('board.dropHere')}
          </p>
        ) : null}
        {more ? (
          <Button data-testid={`crms-column-load-more-${column.id}`} variant="ghost" size="sm" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('board.loadMore')}
          </Button>
        ) : null}
      </div>
    </section>
  )
}

function SortableCard({
  card,
  columnId,
  index,
  columns,
  labels,
  onOpen,
  onMoveTo,
}: {
  card: CardDto
  columnId: string
  index: number
  columns: readonly ColumnDto[]
  labels: Record<string, LabelOption>
  onOpen: () => void
  onMoveTo: (columnId: string) => void
}) {
  const { ref, isDragging } = useSortable({ id: card.id, index, group: columnId, type: 'card', accept: 'card', plugins: NO_DROP_ANIMATION })
  return (
    <article
      ref={ref}
      data-testid={`crms-card-${card.id}`}
      data-column-id={columnId}
      data-chat-id={card.chat_id}
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen()
      }}
      className={cn(
        'cursor-pointer rounded-lg border bg-card p-3 shadow-xs outline-none transition-shadow hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring',
        isDragging && 'opacity-60 shadow-md',
      )}
    >
      <CardView card={{ ...card, column_id: columnId }} columns={columns} labels={labels} onMoveTo={onMoveTo} />
    </article>
  )
}
