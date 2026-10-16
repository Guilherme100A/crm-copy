// Paleta de blocos (06 §2.2 "Ferramentas"): busca, grupos e itens arrastáveis (HTML5, `application/reactflow`).
// Clicar/tocar num item adiciona o bloco no centro da área visível (é o caminho no mobile).
import { Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { NodeType } from '@crm/shared/flows'
import { BLOCKS, DND_MIME, GROUP_ORDER, PALETTE_TYPES, searchBlocks } from './catalog'

export function Palette({ onAdd, onClose, className }: { onAdd: (type: NodeType) => void; onClose: () => void; className?: string }) {
  const t = useT('flow-editor')
  const [query, setQuery] = useState('')
  const visible = useMemo(() => searchBlocks(PALETTE_TYPES, query, (type) => t(`types.${type}`)), [query, t])

  return (
    <aside data-testid="flow-palette" aria-label={t('palette.title')} className={cn('flex min-h-0 flex-col gap-2 rounded-xl border bg-card p-3 shadow-lg', className)}>
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{t('palette.title')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <label className="relative block">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          data-testid="flow-palette-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('palette.search')}
          aria-label={t('palette.search')}
          className="h-9 w-full rounded-md border bg-background pr-2 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {visible.length === 0 ? <p className="p-2 text-center text-xs text-muted-foreground">{t('palette.empty')}</p> : null}
        {GROUP_ORDER.map((group) => {
          const items = visible.filter((type) => BLOCKS[type].group === group)
          if (!items.length) return null
          return (
            <section key={group} className="flex flex-col gap-1">
              <h3 className="px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t(`groups.${group}`)}</h3>
              <ul className="grid grid-cols-2 gap-1.5">
                {items.map((type) => {
                  const { icon: Icon, color } = BLOCKS[type]
                  return (
                    <li key={type}>
                      <button
                        type="button"
                        draggable
                        data-testid={`flow-palette-item-${type}`}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(DND_MIME, type)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onClick={() => onAdd(type)}
                        title={t('palette.hint')}
                        className="flex w-full min-w-0 cursor-grab items-center gap-2 rounded-lg border bg-background px-2 py-2 text-left text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md text-white" style={{ backgroundColor: color }} aria-hidden>
                          <Icon className="size-3.5" />
                        </span>
                        <span className="min-w-0 truncate">{t(`types.${type}`)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </aside>
  )
}
