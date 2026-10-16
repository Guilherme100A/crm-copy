// Nó do canvas (06 §2.2 `nodeHeader`): cabeçalho com ícone, nome e ações (copiar, excluir), resumo das ações, badge de
// erros da validação e handles: entrada à esquerda (o Início não tem) e uma saída por handle normalizado à direita.
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Copy, Trash2 } from 'lucide-react'
import { createContext, memo, useContext } from 'react'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { blockOf } from '../palette/catalog'
import { outputHandles, type EditorNode } from './model'

export interface NodeActions {
  readOnly: boolean
  onCopy: (id: string) => void
  onDelete: (id: string) => void
}

export const NodeActionsContext = createContext<NodeActions>({ readOnly: true, onCopy: () => undefined, onDelete: () => undefined })

/** Rótulo curto da saída: `option:abc` → `abc`, `output:x` → `x`, fixos pelo i18n. */
export function handleLabel(handle: string, t: (k: string) => string): string {
  const i = handle.indexOf(':')
  if (i > 0) return handle.slice(i + 1)
  return t(`handles.${handle}`)
}

function FlowNodeView({ id, type, data, selected }: NodeProps<EditorNode>) {
  const t = useT('flow-editor')
  const { readOnly, onCopy, onDelete } = useContext(NodeActionsContext)
  const block = blockOf(type)
  const Icon = block.icon
  const handles = outputHandles({ type, data })
  const errors = data.errors ?? []
  const isEntry = !!data.isEntry
  return (
    <div
      data-testid={`flow-node-${id}`}
      data-type={type}
      data-invalid={errors.length ? 'true' : undefined}
      className={cn(
        'relative w-56 rounded-xl border bg-card text-card-foreground shadow-sm',
        selected && 'ring-2 ring-primary',
        errors.length && 'border-destructive ring-1 ring-destructive/60',
      )}
    >
      {!isEntry ? <Handle type="target" position={Position.Left} className="!size-3 !border-2 !border-background !bg-muted-foreground" /> : null}
      <div className="flex items-center gap-2 rounded-t-xl px-2.5 py-2 text-white" style={{ backgroundColor: block.color }}>
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{data.name || t(`types.${type}`)}</span>
        {!readOnly && !isEntry ? (
          <span className="nodrag flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              data-testid={`flow-node-copy-${id}`}
              aria-label={t('node.copy')}
              title={t('node.copy')}
              onClick={(e) => {
                e.stopPropagation()
                onCopy(id)
              }}
              className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white"
            >
              <Copy className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              data-testid={`flow-node-delete-${id}`}
              aria-label={t('node.delete')}
              title={t('node.delete')}
              onClick={(e) => {
                e.stopPropagation()
                onDelete(id)
              }}
              className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 px-2.5 py-2 text-xs">
        <span className="text-muted-foreground">{type === 'unsupported' ? t('node.unsupported', { type: data.original_type ?? '?' }) : t(`types.${type}`)}</span>
        {data.description ? <p className="line-clamp-2 break-words">{data.description}</p> : null}
        <span className="text-muted-foreground">{t('node.actions', { n: data.actions.length })}</span>
        {handles.length > 1 ? (
          <ul className="mt-1 flex flex-col gap-1.5">
            {handles.map((h) => (
              <li key={h} className="relative flex items-center justify-end pr-2 text-[11px] text-muted-foreground">
                <span className="truncate">{handleLabel(h, t)}</span>
                <Handle
                  type="source"
                  id={h}
                  position={Position.Right}
                  className="!-right-[17px] !size-3 !border-2 !border-background !bg-primary"
                  isConnectable={!readOnly}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {handles.length === 1 ? (
        <Handle type="source" id={handles[0]} position={Position.Right} className="!size-3 !border-2 !border-background !bg-primary" isConnectable={!readOnly} />
      ) : null}
      {errors.length ? (
        <span
          data-testid={`flow-node-error-${id}`}
          title={errors.join('\n')}
          className="absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-bold text-white shadow"
        >
          {errors.length}
        </span>
      ) : null}
    </div>
  )
}

export const FlowNodeComponent = memo(FlowNodeView)
