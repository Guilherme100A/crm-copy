// Modal "Filtrar contatos" (05 §2, `d3t`): data de criação (de/até), etiquetas (multi + busca), etapas do kanban
// agrupadas por quadro (+ busca) e campo personalizado (chave + valor opcional). Edita um rascunho; "Aplicar" grava
// nos search params.
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { boardsQuery, customFieldKeysQuery, labelsQuery } from './api'
import { ModalShell } from './dialogs'
import { advancedFilters, type ContactsSearch } from './filters'

const fieldClass =
  'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

const toggleIn = (xs: string[] | undefined, id: string) => {
  const set = new Set(xs ?? [])
  if (set.has(id)) set.delete(id)
  else set.add(id)
  return set.size ? [...set] : undefined
}

export function FiltersModal({
  open,
  search,
  onApply,
  onClose,
}: {
  open: boolean
  search: ContactsSearch
  onApply: (next: ContactsSearch) => void
  onClose: () => void
}) {
  const t = useT('contacts')
  return (
    <ModalShell open={open} onClose={onClose} testId="contacts-filters-modal" title={t('filters.title')}>
      {open ? <FiltersForm search={search} onApply={onApply} onClose={onClose} /> : null}
    </ModalShell>
  )
}

function FiltersForm({
  search,
  onApply,
  onClose,
}: {
  search: ContactsSearch
  onApply: (next: ContactsSearch) => void
  onClose: () => void
}) {
  const t = useT('contacts')
  const labels = useQuery(labelsQuery()).data ?? []
  const boards = useQuery(boardsQuery()).data ?? []
  const keys = useQuery(customFieldKeysQuery()).data ?? []
  const [draft, setDraft] = useState<ContactsSearch>(() => advancedFilters(search))
  const [labelQuery, setLabelQuery] = useState('')
  const [columnQuery, setColumnQuery] = useState('')

  const visibleLabels = useMemo(
    () => labels.filter((l) => norm(l.name).includes(norm(labelQuery.trim()))),
    [labels, labelQuery],
  )
  const visibleBoards = useMemo(() => {
    const q = norm(columnQuery.trim())
    return boards
      .map((b) => ({
        ...b,
        columns: q && !norm(b.name).includes(q) ? b.columns.filter((c) => norm(c.name).includes(q)) : b.columns,
      }))
      .filter((b) => b.columns.length > 0)
  }, [boards, columnQuery])

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        onApply({ q: search.q, ...advancedFilters(draft) })
      }}
    >
      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">{t('filters.createdFrom')}</span>
          <input
            data-testid="contacts-filter-created-from"
            type="date"
            className={fieldClass}
            value={draft.from ?? ''}
            max={draft.to || undefined}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value || undefined }))}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">{t('filters.createdTo')}</span>
          <input
            data-testid="contacts-filter-created-to"
            type="date"
            className={fieldClass}
            value={draft.to ?? ''}
            min={draft.from || undefined}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value || undefined }))}
          />
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('filters.labels')}</legend>
        <p className="text-xs text-muted-foreground">{t('filters.labelsHint')}</p>
        {labels.length > 6 ? (
          <input
            type="search"
            className={fieldClass}
            placeholder={t('filters.search')}
            aria-label={t('filters.search')}
            value={labelQuery}
            onChange={(e) => setLabelQuery(e.target.value)}
          />
        ) : null}
        {labels.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('filters.noLabels')}</p>
        ) : (
          <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
            {visibleLabels.map((l) => {
              const on = draft.labels?.includes(l.id) ?? false
              return (
                <label
                  key={l.id}
                  className="flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs has-checked:border-primary has-checked:bg-primary/10"
                >
                  <input
                    data-testid={`contacts-filter-label-${l.id}`}
                    type="checkbox"
                    className="size-3.5"
                    checked={on}
                    onChange={() => setDraft((d) => ({ ...d, labels: toggleIn(d.labels, l.id) }))}
                  />
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: l.color ?? 'currentColor' }}
                    aria-hidden
                  />
                  <span className="max-w-40 truncate">{l.name}</span>
                </label>
              )
            })}
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('filters.columns')}</legend>
        {boards.length > 0 ? (
          <input
            type="search"
            className={fieldClass}
            placeholder={t('filters.search')}
            aria-label={t('filters.columnsSearch')}
            value={columnQuery}
            onChange={(e) => setColumnQuery(e.target.value)}
          />
        ) : null}
        {boards.every((b) => b.columns.length === 0) ? (
          <p className="text-xs text-muted-foreground">{t('filters.noColumns')}</p>
        ) : (
          <div className="flex max-h-48 flex-col gap-3 overflow-y-auto">
            {visibleBoards.map((b) => (
              <div key={b.id} className="flex flex-col gap-1.5">
                <span className="truncate text-xs font-semibold text-muted-foreground uppercase">{b.name}</span>
                <div className="flex flex-wrap gap-2">
                  {b.columns.map((c) => (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs has-checked:border-primary has-checked:bg-primary/10"
                    >
                      <input
                        data-testid={`contacts-filter-column-${c.id}`}
                        type="checkbox"
                        className="size-3.5"
                        checked={draft.columns?.includes(c.id) ?? false}
                        onChange={() => setDraft((d) => ({ ...d, columns: toggleIn(d.columns, c.id) }))}
                      />
                      <span className="max-w-40 truncate">{c.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">{t('filters.customKey')}</span>
          <input
            data-testid="contacts-filter-custom-key"
            list="contacts-custom-field-keys"
            className={fieldClass}
            placeholder={t('filters.customKeyPlaceholder')}
            value={draft.cf_key ?? ''}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                cf_key: e.target.value || undefined,
                ...(e.target.value.trim() ? {} : { cf_value: undefined }),
              }))
            }
          />
          <datalist id="contacts-custom-field-keys">
            {keys.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">{t('filters.customValue')}</span>
          <input
            data-testid="contacts-filter-custom-value"
            className={fieldClass}
            placeholder={t('filters.customValuePlaceholder')}
            disabled={!draft.cf_key?.trim()}
            value={draft.cf_value ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, cf_value: e.target.value || undefined }))}
          />
        </label>
      </fieldset>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" data-testid="contacts-filters-reset" onClick={() => setDraft({})}>
          {t('filters.clear')}
        </Button>
        <Button variant="outline" data-testid="contacts-filters-cancel" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" data-testid="contacts-filters-apply">
          {t('filters.apply')}
        </Button>
      </div>
    </form>
  )
}
