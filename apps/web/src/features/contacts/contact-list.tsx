// Lista de contatos (05 §2, `GTt`): tabela no desktop e cartões no mobile, com checkbox por contato (Shift+clique
// seleciona o intervalo), avatar com a inicial, telefone (ou o LID) e até 3 etiquetas + "+N". O menu de seleção
// oferece "visíveis" e "Todos do filtro ({n})" / "Todos da conta ({n})".
import { ChevronDown, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { ContactDto, ContactLabel } from './api'
import { isSelected, type Selection } from './selection'

export interface ListSelectionProps {
  selection: Selection
  onToggle: (id: string, shift: boolean) => void
  onToggleVisible: () => void
  onSelectAll: () => void
  /** "Todos do filtro" (com filtro) ou "Todos da conta". */
  allMode: 'filter' | 'account'
  allLabel: string
  /** Total do filtro já conhecido (senão a opção "todos" espera a contagem). */
  allReady: boolean
  onMenuOpen: () => void
  /** T86: ações por linha (Abrir chat, Editar); sem elas a coluna não aparece. */
  rowActions?: (c: ContactDto) => ReactNode
}

const shiftOf = (e: ChangeEvent<HTMLInputElement>) => (e.nativeEvent as MouseEvent).shiftKey === true

function RowCheckbox({
  contact,
  selection,
  onToggle,
}: {
  contact: ContactDto
  selection: Selection
  onToggle: ListSelectionProps['onToggle']
}) {
  const t = useT('contacts')
  return (
    <input
      type="checkbox"
      data-testid={`contacts-select-${contact.id}`}
      aria-label={t('select.row', { name: contact.name })}
      className="size-4 shrink-0 cursor-pointer accent-primary"
      checked={isSelected(selection, contact.id)}
      onChange={(e) => onToggle(contact.id, shiftOf(e))}
    />
  )
}

export function Avatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
      aria-hidden
    >
      {initial}
    </span>
  )
}

export function LabelChips({ labels, max }: { labels: readonly ContactLabel[]; max: number }) {
  const shown = labels.slice(0, max)
  const rest = labels.length - shown.length
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((l) => (
        <span key={l.id} className="inline-flex max-w-32 items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: l.color ?? 'currentColor' }}
            aria-hidden
          />
          <span className="truncate">{l.name}</span>
        </span>
      ))}
      {rest > 0 ? <span className="text-xs text-muted-foreground">+{rest}</span> : null}
    </span>
  )
}

const phoneOf = (c: ContactDto) => c.phone_e164 ?? c.wa_lid ?? ''

/** Botão + menu de seleção (visíveis / todos). */
export function SelectMenu({
  visibleState,
  onToggleVisible,
  onSelectAll,
  allMode,
  allLabel,
  allReady,
  onMenuOpen,
}: { visibleState: 'none' | 'some' | 'all' } & Omit<ListSelectionProps, 'selection' | 'onToggle'>) {
  const t = useT('contacts')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (boxRef.current) boxRef.current.indeterminate = visibleState === 'some'
  }, [visibleState])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative flex items-center gap-1">
      <input
        ref={boxRef}
        type="checkbox"
        data-testid="contacts-select-visible-toggle"
        aria-label={t('select.visible')}
        className="size-4 cursor-pointer accent-primary"
        checked={visibleState === 'all'}
        onChange={onToggleVisible}
      />
      <button
        type="button"
        data-testid="contacts-select-menu-open"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('select.menu')}
        className="flex size-6 items-center justify-center rounded hover:bg-accent"
        onClick={() => {
          if (!open) onMenuOpen()
          setOpen((o) => !o)
        }}
      >
        <ChevronDown className="size-4" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          data-testid="contacts-select-menu"
          className="absolute top-full left-0 z-30 mt-1 flex w-60 flex-col rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="contacts-select-visible"
            className="rounded px-3 py-2 text-left hover:bg-accent"
            onClick={() => {
              onToggleVisible()
              setOpen(false)
            }}
          >
            {t('select.visible')}
          </button>
          {allReady ? (
            <button
              type="button"
              role="menuitem"
              data-testid={`contacts-select-all-${allMode}`}
              className="rounded px-3 py-2 text-left hover:bg-accent"
              onClick={() => {
                onSelectAll()
                setOpen(false)
              }}
            >
              {allLabel}
            </button>
          ) : (
            <span
              data-testid="contacts-select-all-loading"
              className="flex items-center gap-2 px-3 py-2 text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden /> {t('select.counting')}
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function visibleStateOf(selection: Selection, ids: readonly string[]): 'none' | 'some' | 'all' {
  const n = ids.filter((id) => isSelected(selection, id)).length
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some'
}

export function ContactsTable({ items, ...sel }: { items: readonly ContactDto[] } & ListSelectionProps) {
  const t = useT('contacts')
  const ids = items.map((c) => c.id)
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <table data-testid="contacts-table" className="w-full table-fixed text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground uppercase">
          <tr>
            <th className="w-20 px-3 py-2">
              <SelectMenu
                visibleState={visibleStateOf(sel.selection, ids)}
                onToggleVisible={sel.onToggleVisible}
                onSelectAll={sel.onSelectAll}
                allMode={sel.allMode}
                allLabel={sel.allLabel}
                allReady={sel.allReady}
                onMenuOpen={sel.onMenuOpen}
              />
            </th>
            <th className="px-3 py-2 font-medium">{t('table.name')}</th>
            <th className="w-48 px-3 py-2 font-medium">{t('table.phone')}</th>
            <th className="w-[30%] px-3 py-2 font-medium">{t('table.labels')}</th>
            {sel.rowActions ? <th className="w-24 px-3 py-2"><span className="sr-only">{t('contact-form:entry.actions')}</span></th> : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((c) => (
            <tr
              key={c.id}
              data-testid={`contacts-row-${c.id}`}
              data-selected={isSelected(sel.selection, c.id) ? 'true' : 'false'}
              className={cn('hover:bg-muted/30', isSelected(sel.selection, c.id) && 'bg-primary/5')}
            >
              <td className="px-3 py-2">
                <RowCheckbox contact={c} selection={sel.selection} onToggle={sel.onToggle} />
              </td>
              <td className="px-3 py-2">
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar name={c.name} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{c.name}</span>
                    {c.email ? <span className="block truncate text-xs text-muted-foreground">{c.email}</span> : null}
                  </span>
                </span>
              </td>
              <td className="truncate px-3 py-2 tabular-nums">
                {phoneOf(c) || <span className="text-muted-foreground">{t('table.noPhone')}</span>}
              </td>
              <td className="px-3 py-2">
                <LabelChips labels={c.labels} max={3} />
              </td>
              {sel.rowActions ? <td className="px-3 py-2">{sel.rowActions(c)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ContactsCards({ items, ...sel }: { items: readonly ContactDto[] } & ListSelectionProps) {
  const t = useT('contacts')
  const ids = items.map((c) => c.id)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <SelectMenu
          visibleState={visibleStateOf(sel.selection, ids)}
          onToggleVisible={sel.onToggleVisible}
          onSelectAll={sel.onSelectAll}
          allMode={sel.allMode}
          allLabel={sel.allLabel}
          allReady={sel.allReady}
          onMenuOpen={sel.onMenuOpen}
        />
        <span>{t('select.visible')}</span>
      </div>
      <ul data-testid="contacts-cards" className="flex flex-col gap-2">
        {items.map((c) => (
          <li
            key={c.id}
            data-testid={`contacts-row-${c.id}`}
            data-selected={isSelected(sel.selection, c.id) ? 'true' : 'false'}
            className={cn(
              'flex min-w-0 items-start gap-3 rounded-xl border bg-card p-3',
              isSelected(sel.selection, c.id) && 'border-primary/50 bg-primary/5',
            )}
          >
            <span className="pt-2.5">
              <RowCheckbox contact={c} selection={sel.selection} onToggle={sel.onToggle} />
            </span>
            <Avatar name={c.name} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate font-medium">{c.name}</span>
              <span className="truncate text-xs text-muted-foreground tabular-nums">
                {phoneOf(c) || t('table.noPhone')}
              </span>
              {c.labels.length ? <LabelChips labels={c.labels} max={2} /> : null}
            </span>
            {sel.rowActions ? <span className="shrink-0">{sel.rowActions(c)}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
