// Painel Propriedades (06 §2.2 `flowProperties`): com um nó selecionado mostra tipo, nome, descrição, posição e o
// editor do tipo (registro `node-editors/registry.ts`, T56/T57) ou a lista genérica de ações; sem seleção mostra os
// dados do fluxo e os totais (nós, conexões).
import type { FlowAction } from '@crm/shared/flows'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FlowDto } from '../canvas/api'
import type { EditorNode } from '../canvas/model'
import { getNodeEditor } from '../node-editors/registry'
import { blockOf } from '../palette/catalog'

const field = 'w-full rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70'

export interface PropertiesPanelProps {
  flow: FlowDto
  node: EditorNode | null
  stats: { nodes: number; edges: number }
  readOnly: boolean
  onNodeChange: (id: string, patch: { name?: string; description?: string }) => void
  onActionsChange: (id: string, actions: FlowAction[]) => void
  onClose?: () => void
  className?: string
}

/** Campo de texto que só propaga ao sair/Enter (evita salvar a cada tecla). */
function CommitInput({
  value,
  onCommit,
  disabled,
  testId,
  multiline,
  label,
}: {
  value: string
  onCommit: (v: string) => void
  disabled: boolean
  testId: string
  multiline?: boolean
  label: string
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <label className="flex flex-col gap-1 text-xs font-medium">
      {label}
      {multiline ? (
        <textarea data-testid={testId} className={cn(field, 'min-h-16 py-1.5')} value={draft} disabled={disabled} maxLength={2000} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      ) : (
        <input
          data-testid={testId}
          className={cn(field, 'h-8')}
          value={draft}
          disabled={disabled}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
        />
      )}
    </label>
  )
}

export function PropertiesPanel({ flow, node, stats, readOnly, onNodeChange, onActionsChange, onClose, className }: PropertiesPanelProps) {
  const t = useT('flow-editor')
  const Editor = node ? getNodeEditor(node.type ?? '') : null
  return (
    <aside data-testid="flow-properties" aria-label={t('properties.title')} className={cn('flex min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border bg-card p-3', className)}>
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{t('properties.title')}</h2>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent">
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
      {node ? (
        <div data-testid="flow-properties-node" data-node-id={node.id} className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-xs">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: blockOf(node.type).color }} aria-hidden />
            <span className="font-medium">{t(`types.${node.type}`)}</span>
            <span className="ml-auto text-muted-foreground tabular-nums" data-testid="flow-prop-position">
              {Math.round(node.position.x)}, {Math.round(node.position.y)}
            </span>
          </p>
          <CommitInput label={t('properties.name')} testId="flow-prop-name" value={node.data.name} disabled={readOnly} onCommit={(name) => onNodeChange(node.id, { name })} />
          <CommitInput
            label={t('properties.description')}
            testId="flow-prop-description"
            multiline
            value={node.data.description ?? ''}
            disabled={readOnly}
            onCommit={(description) => onNodeChange(node.id, { description })}
          />
          {node.data.errors?.length ? (
            <ul data-testid="flow-prop-errors" className="flex flex-col gap-1 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              {node.data.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
          <div data-testid="flow-node-editor" className="flex flex-col gap-2">
            {Editor ? (
              <Editor nodeId={node.id} type={node.type ?? ''} actions={node.data.actions} readOnly={readOnly} onChange={(actions) => onActionsChange(node.id, actions)} />
            ) : (
              <div data-testid="flow-prop-actions" className="flex flex-col gap-1">
                <p className="text-xs font-medium">{t('properties.actions')}</p>
                {node.data.actions.length ? (
                  <ul className="flex flex-col gap-1">
                    {node.data.actions.map((a) => (
                      <li key={a.id} className="rounded-md border px-2 py-1 font-mono text-[11px] break-all">
                        {a.type}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('properties.noActions')}</p>
                )}
                <p className="text-[11px] text-muted-foreground">{t('properties.noEditor')}</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div data-testid="flow-properties-flow" className="flex flex-col gap-2 text-sm">
          <p className="font-medium break-words">{flow.name}</p>
          {flow.description ? <p className="text-xs break-words text-muted-foreground">{flow.description}</p> : null}
          <dl className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-muted/50 p-2">
              <dt className="text-xs text-muted-foreground">{t('properties.nodes')}</dt>
              <dd data-testid="flow-stat-nodes" className="font-semibold tabular-nums">
                {stats.nodes}
              </dd>
            </div>
            <div className="rounded-lg bg-muted/50 p-2">
              <dt className="text-xs text-muted-foreground">{t('properties.edges')}</dt>
              <dd data-testid="flow-stat-edges" className="font-semibold tabular-nums">
                {stats.edges}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">{t('properties.hint')}</p>
        </div>
      )}
    </aside>
  )
}
