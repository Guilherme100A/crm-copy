// Arrastar da lista de fluxos (06 §2.1): o @dnd-kit/react 0.5.1 (STACK D §5, 0.x) fica isolado neste arquivo.
// Fluxos e cards de pasta são arrastados pela alça; pastas (cards, árvore e "Sem pasta") recebem fluxos e pastas;
// soltar um fluxo sobre outro (ou no fim da lista) reordena. Pasta solta em si mesma ou numa descendente é recusada
// aqui (aviso `flows-dnd-blocked`), antes de chegar à API (que também recusa com 409).
import { Feedback } from '@dnd-kit/dom'
import {
  DragDropProvider,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  type DragDropManager,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/react'
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

export type DragData = { kind: 'flow'; id: string } | { kind: 'folder'; id: string }
/** Alvo: pasta (`folderId` null = raiz), outro fluxo (soltar antes dele) ou o fim da lista. */
export type DropData = { kind: 'folder'; folderId: string | null } | { kind: 'flow'; id: string } | { kind: 'end' }

const SENSORS = [
  PointerSensor,
  KeyboardSensor.configure({
    keyboardCodes: {
      start: ['Space'],
      cancel: ['Escape'],
      end: ['Space', 'Tab'],
      up: ['ArrowUp'],
      down: ['ArrowDown'],
      left: ['ArrowLeft'],
      right: ['ArrowRight'],
    },
  }),
]

// Sem animação de soltura: a lista muda logo depois do dragend (ver board-dnd.tsx da T70).
const PLUGINS = <T extends readonly unknown[]>(defaults: T) => [
  ...defaults,
  Feedback.configure({ dropAnimation: null }),
]

interface DndState {
  /** Arrasto em curso (para mostrar as zonas de soltura). */
  active: DragData | null
  /** O alvo sob o ponteiro recusaria a soltura. */
  blockedTarget: string | null
}

const Ctx = createContext<DndState>({ active: null, blockedTarget: null })
export const useDndState = () => useContext(Ctx)

const keyOf = (d: DropData) =>
  d.kind === 'folder' ? `folder:${d.folderId ?? 'root'}` : d.kind === 'flow' ? `flow:${d.id}` : 'end'

export function FlowsDnd({
  canDrop,
  onDrop,
  onBlocked,
  children,
}: {
  /** `false` = soltura proibida (pasta em descendente). */
  canDrop: (source: DragData, target: DropData) => boolean
  onDrop: (source: DragData, target: DropData) => void
  onBlocked: () => void
  children: ReactNode
}) {
  const [state, setState] = useState<DndState>({ active: null, blockedTarget: null })
  const latest = useRef({ canDrop, onDrop, onBlocked })
  latest.current = { canDrop, onDrop, onBlocked }

  const onDragOver = useCallback((event: DragOverEvent) => {
    const source = event.operation.source?.data as DragData | undefined
    const target = event.operation.target?.data as DropData | undefined
    const blocked = source && target && !latest.current.canDrop(source, target) ? keyOf(target) : null
    setState((s) => (s.blockedTarget === blocked ? s : { ...s, blockedTarget: blocked }))
  }, [])

  // Como no quadro da T70: a mudança só é aplicada depois que a renderização do dragend termina.
  const onDragEnd = useCallback((event: DragEndEvent, manager: DragDropManager) => {
    setState({ active: null, blockedTarget: null })
    const source = event.operation.source?.data as DragData | undefined
    const target = event.operation.target?.data as DropData | undefined
    if (event.canceled || !source || !target) return
    const action = latest.current.canDrop(source, target)
      ? () => latest.current.onDrop(source, target)
      : () => latest.current.onBlocked()
    void manager.renderer.rendering.then(() => setTimeout(action, 0))
  }, [])

  // Sem permissão o provider continua montado (os hooks dependem dele); os itens é que ficam desabilitados.
  return (
    <DragDropProvider
      sensors={SENSORS}
      plugins={PLUGINS}
      onDragStart={(event) =>
        setState({ active: (event.operation.source?.data as DragData | undefined) ?? null, blockedTarget: null })
      }
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      <Ctx.Provider value={state}>{children}</Ctx.Provider>
    </DragDropProvider>
  )
}

/** Item arrastável pela alça (`handleRef`); fluxos também são alvo de reordenação. */
export function useDragItem(data: DragData, enabled: boolean) {
  const drag = useDraggable({ id: `${data.kind}:${data.id}`, type: data.kind, data, disabled: !enabled })
  const drop = useDroppable({
    id: `slot:${data.kind}:${data.id}`,
    type: data.kind === 'flow' ? 'flow-slot' : 'folder',
    accept: data.kind === 'flow' ? 'flow' : ['flow', 'folder'],
    data: (data.kind === 'flow'
      ? { kind: 'flow', id: data.id }
      : { kind: 'folder', folderId: data.id }) satisfies DropData,
    disabled: !enabled,
  })
  const { ref: dragRef } = drag
  const { ref: dropRef } = drop
  // Desabilitado, o elemento nem é registrado: o dnd-kit marcaria o item com aria-disabled (e o menu dentro dele).
  const ref = useCallback(
    (el: Element | null) => {
      dragRef(enabled ? el : null)
      dropRef(enabled ? el : null)
    },
    [dragRef, dropRef, enabled],
  )
  return { ref, handleRef: drag.handleRef, isDragging: drag.isDragging, isOver: drop.isDropTarget }
}

/** Alvo que só recebe (nó da árvore, "Sem pasta", fim da lista). */
export function useDropTarget(id: string, data: DropData, enabled: boolean) {
  const drop = useDroppable({
    id,
    type: data.kind === 'end' ? 'flow-slot' : 'folder',
    accept: data.kind === 'end' ? 'flow' : ['flow', 'folder'],
    data,
    disabled: !enabled,
  })
  return { ref: drop.ref, isOver: drop.isDropTarget }
}

export const dropKey = keyOf
