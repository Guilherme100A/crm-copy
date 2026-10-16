// Árvore JSON da amostra (09 §2 "árvore JSON"): objetos e arrays expandem; clicar numa folha escolhe o caminho
// (notação de ponto, igual à do processador) para o destino do mapeamento.
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { childPath } from './mapping'

const preview = (v: unknown) => (typeof v === 'string' ? `"${v.length > 60 ? `${v.slice(0, 60)}…` : v}"` : String(v))

export function JsonTree({ value, onPick, disabled }: { value: unknown; onPick: (path: string) => void; disabled?: boolean }) {
  return (
    <div data-testid="webhook-json-tree" className="max-h-80 overflow-auto rounded-lg border bg-muted/30 p-2 font-mono text-xs">
      <Node label={null} path="" value={value} onPick={onPick} disabled={disabled} depth={0} />
    </div>
  )
}

function Node({ label, path, value, onPick, disabled, depth }: { label: string | null; path: string; value: unknown; onPick: (p: string) => void; disabled?: boolean; depth: number }) {
  const [open, setOpen] = useState(depth < 3)
  const isObj = value !== null && typeof value === 'object'
  const testId = path ? `webhook-json-node-${path}` : undefined
  if (!isObj) {
    return (
      <button
        type="button"
        data-testid={testId}
        data-path={path}
        disabled={disabled || !path}
        onClick={() => onPick(path)}
        className={cn('flex w-full min-w-0 items-baseline gap-1 rounded px-1 py-0.5 text-left', !disabled && path && 'hover:bg-primary/10')}
        title={path}
      >
        {label !== null ? <span className="shrink-0 text-sky-700 dark:text-sky-400">{label}:</span> : null}
        <span className="min-w-0 truncate text-emerald-700 dark:text-emerald-400">{preview(value)}</span>
      </button>
    )
  }
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>)
  return (
    <div data-testid={testId} data-path={path}>
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent" aria-expanded={open}>
        {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
        {label !== null ? <span className="text-sky-700 dark:text-sky-400">{label}</span> : null}
        <span className="text-muted-foreground">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open ? (
        <div className="ml-3 border-l pl-2">
          {entries.map(([k, v]) => (
            <Node key={k} label={k} path={childPath(path, k)} value={v} onPick={onPick} disabled={disabled} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
