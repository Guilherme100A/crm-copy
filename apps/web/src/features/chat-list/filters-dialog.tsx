// Modal "Filtros de chat" (spec 03 "Observado no app"): responsável, período, CRM, etiquetas, conexões e
// departamentos. Aplicar grava na URL (AC-T69-01); Limpar zera só os avançados; Cancelar descarta o rascunho.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { connectionNamesQuery, crmBoardsQuery, filterOptionsQuery } from './api'
import { ADVANCED_KEYS, periodProblem, type AdvancedFilters, type ChatSearch } from './search'

const pickAdvanced = (s: ChatSearch): AdvancedFilters => Object.fromEntries(ADVANCED_KEYS.map((k) => [k, s[k]])) as AdvancedFilters
const EMPTY = Object.fromEntries(ADVANCED_KEYS.map((k) => [k, undefined])) as unknown as AdvancedFilters

type IdsKey = 'connection_ids' | 'department_ids' | 'label_ids'

function toggle(list: string[] | undefined, id: string, on: boolean): string[] | undefined {
  const set = new Set(list ?? [])
  if (on) set.add(id)
  else set.delete(id)
  return set.size ? [...set] : undefined
}

function CheckList({ title, items, selected, prefix, onToggle, empty }: { title: string; items: { id: string; name: string }[]; selected?: string[]; prefix: string; onToggle: (id: string, on: boolean) => void; empty: string }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 text-sm font-medium">{title}</legend>
      {items.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : null}
      <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
        {items.map((i) => (
          <label key={i.id} className="flex min-w-0 items-center gap-2 text-sm">
            <input type="checkbox" data-testid={`${prefix}-${i.id}`} checked={selected?.includes(i.id) ?? false} onChange={(e) => onToggle(i.id, e.target.checked)} />
            <span className="truncate">{i.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function ChatFiltersDialog({ open, onOpenChange, search, onApply }: { open: boolean; onOpenChange: (open: boolean) => void; search: ChatSearch; onApply: (f: AdvancedFilters) => void }) {
  const t = useT('chat-list')
  const [draft, setDraft] = useState<AdvancedFilters>(() => pickAdvanced(search))
  const [error, setError] = useState<string | null>(null)
  const options = useQuery({ ...filterOptionsQuery(), enabled: open })
  const names = useQuery({ ...connectionNamesQuery(), enabled: open }).data ?? {}
  const boards = useQuery({ ...crmBoardsQuery(), enabled: open }).data ?? []

  // Reabrir parte do que está na URL.
  useEffect(() => {
    if (open) {
      setDraft(pickAdvanced(search))
      setError(null)
    }
  }, [open]) // só ao abrir

  const set = (patch: Partial<AdvancedFilters>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setError(null)
  }
  const toggleIds = (key: IdsKey) => (id: string, on: boolean) => set({ [key]: toggle(draft[key], id, on) })

  const apply = () => {
    const p = periodProblem(draft.created_from, draft.created_to)
    if (p) return setError(t(`filters.period.${p}`))
    onApply(draft)
    onOpenChange(false)
  }

  const opts = options.data
  const connections = (opts?.connections ?? []).map((id) => ({ id, name: names[id] ?? t('filters.connectionFallback', { id: id.slice(0, 8) }) }))
  const inputClass = 'h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Popup
          data-testid="chat-filters-modal"
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(90dvh,40rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{t('filters.title')}</Dialog.Title>
          {options.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <div className="h-9 animate-pulse rounded bg-muted" />
              <div className="h-20 animate-pulse rounded bg-muted" />
            </div>
          ) : options.isError ? (
            <p className="text-sm text-destructive">{t('errors.load')}</p>
          ) : (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('filters.assigned')}</span>
                <select data-testid="chat-filter-assigned" value={draft.assigned_to ?? ''} onChange={(e) => set({ assigned_to: e.target.value || undefined })} className={inputClass}>
                  <option value="">{t('filters.assignedAll')}</option>
                  <option value="me">{t('filters.assignedMe')}</option>
                  <option value="none">{t('filters.assignedNone')}</option>
                  {opts?.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">{t('filters.period.title')}</legend>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                    {t('filters.period.from')}
                    <input type="date" data-testid="chat-filter-created-from" value={draft.created_from ?? ''} onChange={(e) => set({ created_from: e.target.value || undefined })} className={inputClass} />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                    {t('filters.period.to')}
                    <input type="date" data-testid="chat-filter-created-to" value={draft.created_to ?? ''} onChange={(e) => set({ created_to: e.target.value || undefined })} className={inputClass} />
                  </label>
                </div>
              </fieldset>
              {boards.length ? (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t('filters.crm')}</span>
                  <select data-testid="chat-filter-crm" value={draft.crm_id ?? ''} onChange={(e) => set({ crm_id: e.target.value || undefined })} className={inputClass}>
                    <option value="">{t('filters.crmAll')}</option>
                    {boards.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <CheckList title={t('filters.labels')} items={opts?.labels ?? []} selected={draft.label_ids} prefix="chat-filter-label" onToggle={toggleIds('label_ids')} empty={t('filters.noLabels')} />
              <CheckList title={t('filters.connections')} items={connections} selected={draft.connection_ids} prefix="chat-filter-connection" onToggle={toggleIds('connection_ids')} empty={t('filters.noConnections')} />
              <CheckList
                title={t('filters.departments')}
                items={opts?.departments ?? []}
                selected={draft.department_ids}
                prefix="chat-filter-department"
                onToggle={toggleIds('department_ids')}
                empty={t('filters.noDepartments')}
              />
            </div>
          )}
          {error ? (
            <p role="alert" data-testid="chat-filters-error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
            <Button variant="ghost" data-testid="chat-filters-clear" className="mr-auto" onClick={() => set(EMPTY)}>
              {t('filters.clear')}
            </Button>
            <Button variant="outline" data-testid="chat-filters-cancel" onClick={() => onOpenChange(false)}>
              {t('filters.cancel')}
            </Button>
            <Button data-testid="chat-filters-apply" onClick={apply}>
              {t('filters.apply')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
