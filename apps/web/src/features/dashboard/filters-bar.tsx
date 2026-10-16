// Barra de filtros da aba Vendas (02 §2 `Bmt`, §5.7–5.14): presets de período e personalizado, conexões e produtos
// (seleção múltipla), grupos de filtro salvos (aplicar, salvar, excluir), limpar e "Atualizar" com a última atualização.
import { Dialog } from '@base-ui/react/dialog'
import { Popover } from '@base-ui/react/popover'
import { Bookmark, ChevronDown, Eraser, RefreshCw, Save, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { Bootstrap, FilterGroup } from './api'
import { PRESETS, customProblem, type DashboardSearch, type Preset } from './search'

const field = 'h-9 rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'

export interface FiltersBarProps {
  search: DashboardSearch
  onSearch: (next: DashboardSearch) => void
  bootstrap: Bootstrap | undefined
  lastUpdated: string | null
  computedAt: string | null
  refreshing: boolean
  onRefresh: () => void
  onSaveGroup: (name: string) => Promise<void>
  onDeleteGroup: (group: FilterGroup) => Promise<void>
}

export function FiltersBar({ search, onSearch, bootstrap, lastUpdated, computedAt, refreshing, onRefresh, onSaveGroup, onDeleteGroup }: FiltersBarProps) {
  const t = useT('dashboard')
  const preset: Preset = search.preset ?? 'today'
  const [customOpen, setCustomOpen] = useState(preset === 'custom')
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<FilterGroup | null>(null)
  const connections = bootstrap?.connections ?? []
  const products = bootstrap?.products ?? []
  const groups = bootstrap?.filter_groups ?? []
  const applied = groups.find((g) => g.id === search.group) ?? null

  const setPreset = (p: Preset) => {
    if (p === 'custom') {
      setCustomOpen(true)
      return
    }
    setCustomOpen(false)
    onSearch({ ...search, preset: p, start_date: undefined, end_date: undefined })
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('filters.period')}>
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            data-testid={`dashboard-preset-${p}`}
            aria-pressed={p === 'custom' ? preset === 'custom' || customOpen : preset === p && !customOpen}
            onClick={() => setPreset(p)}
            className={cn(
              'h-8 rounded-full border px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
              (p === 'custom' ? preset === 'custom' || customOpen : preset === p && !customOpen) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
            )}
          >
            {t(`presets.${p}`)}
          </button>
        ))}
      </div>
      {customOpen ? <CustomRange search={search} onApply={(start, end) => onSearch({ ...search, preset: 'custom', start_date: start, end_date: end })} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelect
          testId="dashboard-connections"
          optionPrefix="dashboard-connection-option-"
          allLabel={t('filters.allConnections')}
          options={connections.map((c) => ({ id: c.id, label: c.name, hint: c.phone_number }))}
          selected={search.connection_ids ?? []}
          onChange={(ids) => onSearch({ ...search, connection_ids: ids, group: undefined })}
        />
        <MultiSelect
          testId="dashboard-products"
          optionPrefix="dashboard-product-option-"
          allLabel={t('filters.allProducts')}
          options={products.map((p) => ({ id: p.id, label: p.name, hint: p.currency }))}
          selected={search.product_ids ?? []}
          onChange={(ids) => onSearch({ ...search, product_ids: ids, group: undefined })}
        />
        <GroupsMenu groups={groups} applied={applied} onApply={(g) => onSearch({ ...search, connection_ids: g.connection_ids, product_ids: g.product_ids, group: g.id })} onDelete={setConfirm} />
        <Button variant="outline" size="sm" data-testid="dashboard-group-save" onClick={() => setSaving(true)}>
          <Save aria-hidden /> <span className="max-sm:sr-only">{t('groups.save')}</span>
        </Button>
        <Button variant="ghost" size="sm" data-testid="dashboard-clear" onClick={() => onSearch({ tab: search.tab })}>
          <Eraser aria-hidden /> <span className="max-sm:sr-only">{t('filters.clear')}</span>
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {lastUpdated ? (
            <span data-testid="dashboard-last-updated" data-computed-at={computedAt ?? undefined} className="text-xs text-muted-foreground">
              {t('filters.lastUpdated', { time: lastUpdated })}
            </span>
          ) : null}
          <Button variant="outline" size="sm" data-testid="dashboard-refresh" disabled={refreshing} onClick={onRefresh}>
            <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden /> <span className="max-sm:sr-only">{t('filters.refresh')}</span>
          </Button>
        </div>
      </div>
      <SaveGroupDialog
        open={saving}
        summary={t('groups.summary', { c: search.connection_ids?.length ?? 0, p: search.product_ids?.length ?? 0 })}
        onClose={() => setSaving(false)}
        onSave={async (name) => {
          await onSaveGroup(name)
          setSaving(false)
        }}
      />
      <ConfirmDialog
        open={!!confirm}
        body={confirm ? t('groups.deleteBody', { name: confirm.name }) : ''}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (confirm) await onDeleteGroup(confirm)
          setConfirm(null)
        }}
      />
    </div>
  )
}

function CustomRange({ search, onApply }: { search: DashboardSearch; onApply: (start: string, end: string) => void }) {
  const t = useT('dashboard')
  const [start, setStart] = useState(search.start_date ?? '')
  const [end, setEnd] = useState(search.end_date ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    setStart(search.start_date ?? '')
    setEnd(search.end_date ?? '')
  }, [search.start_date, search.end_date])
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs font-medium">
        {t('filters.from')}
        <input data-testid="dashboard-custom-start" type="date" className={field} value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        {t('filters.to')}
        <input data-testid="dashboard-custom-end" type="date" className={field} value={end} onChange={(e) => setEnd(e.target.value)} />
      </label>
      <Button
        size="sm"
        data-testid="dashboard-custom-apply"
        onClick={() => {
          const p = customProblem(start, end)
          setProblem(p)
          if (!p) onApply(start, end)
        }}
      >
        {t('filters.apply')}
      </Button>
      {problem ? (
        <p data-testid="dashboard-custom-error" role="alert" className="w-full text-xs text-destructive">
          {t(`filters.problems.${problem}`)}
        </p>
      ) : null}
    </div>
  )
}

interface Option {
  id: string
  label: string
  hint?: string | null
}

function MultiSelect({
  testId,
  optionPrefix,
  allLabel,
  options,
  selected,
  onChange,
}: {
  testId: string
  optionPrefix: string
  allLabel: string
  options: Option[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const t = useT('dashboard')
  const [query, setQuery] = useState('')
  const set = new Set(selected)
  const label = selected.length === 0 ? allLabel : t('filters.selected', { n: selected.length })
  const q = query.trim().toLowerCase()
  const visible = q ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').includes(q)) : options
  return (
    <Popover.Root>
      <Popover.Trigger data-testid={testId} className={cn(field, 'inline-flex max-w-56 items-center gap-1.5 hover:bg-accent')}>
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" collisionPadding={8} className="z-[60]">
          <Popover.Popup className="flex max-h-80 w-[min(18rem,calc(100vw-2rem))] flex-col gap-2 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg outline-none">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('filters.search')}
              aria-label={t('filters.search')}
              className={cn(field, 'h-8 w-full')}
            />
            <div className="flex items-center justify-between text-xs">
              <button type="button" className="text-primary hover:underline" onClick={() => onChange([])}>
                {allLabel}
              </button>
            </div>
            <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
              {visible.length === 0 ? <li className="p-2 text-center text-xs text-muted-foreground">{t('filters.noOptions')}</li> : null}
              {visible.map((o) => (
                <li key={o.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                    <input
                      type="checkbox"
                      data-testid={`${optionPrefix}${o.id}`}
                      className="size-4"
                      checked={set.has(o.id)}
                      onChange={(e) => onChange(e.target.checked ? [...selected, o.id] : selected.filter((x) => x !== o.id))}
                    />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint ? <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function GroupsMenu({ groups, applied, onApply, onDelete }: { groups: FilterGroup[]; applied: FilterGroup | null; onApply: (g: FilterGroup) => void; onDelete: (g: FilterGroup) => void }) {
  const t = useT('dashboard')
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="dashboard-groups" className={cn(field, 'inline-flex max-w-56 items-center gap-1.5 hover:bg-accent')}>
        <Bookmark className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{applied?.name ?? t('groups.label')}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" collisionPadding={8} className="z-[60]">
          <Popover.Popup data-testid="dashboard-groups-list" className="flex max-h-80 w-[min(18rem,calc(100vw-2rem))] flex-col gap-1 overflow-y-auto rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg outline-none">
            {groups.length === 0 ? <p className="p-2 text-center text-xs text-muted-foreground">{t('groups.empty')}</p> : null}
            {groups.map((g) => (
              <div key={g.id} className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid={`dashboard-group-${g.id}`}
                  onClick={() => {
                    onApply(g)
                    setOpen(false)
                  }}
                  className={cn('flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent', applied?.id === g.id && 'bg-accent')}
                >
                  <span className="truncate text-sm font-medium">{g.name}</span>
                  <span className="text-xs text-muted-foreground">{t('groups.summary', { c: g.connection_ids.length, p: g.product_ids.length })}</span>
                </button>
                <button
                  type="button"
                  data-testid={`dashboard-group-delete-${g.id}`}
                  aria-label={t('groups.delete')}
                  onClick={() => {
                    setOpen(false)
                    onDelete(g)
                  }}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </div>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Modal({ open, onClose, testId, title, children }: { open: boolean; onClose: () => void; testId: string; title: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid={testId}
          className="fixed top-1/2 left-1/2 z-[70] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SaveGroupDialog({ open, summary, onClose, onSave }: { open: boolean; summary: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const t = useT('dashboard')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (open) {
      setName('')
      setError(null)
    }
  }, [open])
  return (
    <Modal open={open} onClose={onClose} testId="dashboard-group-modal" title={t('groups.saveTitle')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) {
            setError(t('groups.nameRequired'))
            return
          }
          setPending(true)
          try {
            await onSave(name.trim())
          } catch {
            setError(t('common.error'))
          } finally {
            setPending(false)
          }
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('groups.name')}
          <input data-testid="dashboard-group-name" className={cn(field, 'w-full')} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <p data-testid="dashboard-group-summary" className="text-xs text-muted-foreground">
          {summary}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" data-testid="dashboard-group-modal-save" disabled={pending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function ConfirmDialog({ open, body, onCancel, onConfirm }: { open: boolean; body: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const t = useT('dashboard')
  const [pending, setPending] = useState(false)
  return (
    <Modal open={open} onClose={onCancel} testId="dashboard-confirm" title={t('groups.deleteTitle')}>
      <p className="text-sm text-muted-foreground">{body}</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" data-testid="dashboard-confirm-cancel" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="destructive"
          data-testid="dashboard-confirm-ok"
          disabled={pending}
          onClick={async () => {
            setPending(true)
            try {
              await onConfirm()
            } finally {
              setPending(false)
            }
          }}
        >
          {t('groups.delete')}
        </Button>
      </div>
    </Modal>
  )
}
