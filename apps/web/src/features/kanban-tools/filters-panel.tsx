// Painel de filtros do quadro (04 §2 "painel de filtros", §5.20–5.24): responsável, etapa e atualizado de/até com
// Aplicar/Limpar; etiquetas como chips que aplicam na hora. O estado mora na URL (`BoardSearch`).
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ColumnDto } from '@/features/crms/api'
import { useT } from '@/i18n'
import { api, HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import { fieldClass } from './dialog'
import { cleanSearch, labelIdsOf, toggleLabel, type BoardSearch } from './filters'

interface FilterOptions {
  labels: { id: string; name: string; color?: string | null }[]
  users: { id: string; name: string }[]
}

/** Etiquetas e usuários (as opções do filtro de chats, já no escopo); sem acesso, listas vazias. */
export const filterOptionsQuery = () => ({
  queryKey: ['crms', 'filter-options'] as const,
  staleTime: 60_000,
  queryFn: async (): Promise<FilterOptions> => {
    try {
      const r = await api.get<Partial<FilterOptions>>('/api/chats/filter-options')
      return { labels: r.labels ?? [], users: r.users ?? [] }
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) return { labels: [], users: [] }
      throw err
    }
  },
})

type Draft = Pick<BoardSearch, 'column_id' | 'assigned_to' | 'updated_from' | 'updated_to'>

const draftOf = (s: BoardSearch): Draft => ({ column_id: s.column_id, assigned_to: s.assigned_to, updated_from: s.updated_from, updated_to: s.updated_to })

export function FiltersPanel({ columns, search, onChange }: { columns: readonly ColumnDto[]; search: BoardSearch; onChange: (next: BoardSearch) => void }) {
  const t = useT('kanban-tools')
  const options = useQuery(filterOptionsQuery())
  const [draft, setDraft] = useState<Draft>(() => draftOf(search))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setDraft(draftOf(search)), [search])

  const set = (k: keyof Draft, v: string) => setDraft((d) => ({ ...d, [k]: v || undefined }))
  const apply = () => {
    if (draft.updated_from && draft.updated_to && draft.updated_to < draft.updated_from) {
      setError(t('filters.badRange'))
      return
    }
    setError(null)
    onChange(cleanSearch({ ...search, ...draft }))
  }
  const clear = () => {
    setError(null)
    onChange({})
  }
  const selectedLabels = labelIdsOf(search)
  const labels = options.data?.labels ?? []

  return (
    <section data-testid="kt-filters" aria-label={t('filters.title')} className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
          {t('filters.assigned')}
          <select data-testid="kt-filter-assigned" className={fieldClass} value={draft.assigned_to ?? ''} onChange={(e) => set('assigned_to', e.target.value)}>
            <option value="">{t('filters.anyone')}</option>
            <option value="me">{t('filters.me')}</option>
            <option value="none">{t('filters.nobody')}</option>
            {(options.data?.users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
          {t('filters.column')}
          <select data-testid="kt-filter-column" className={fieldClass} value={draft.column_id ?? ''} onChange={(e) => set('column_id', e.target.value)}>
            <option value="">{t('filters.allColumns')}</option>
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
          {t('filters.from')}
          <input data-testid="kt-filter-from" type="date" className={fieldClass} value={draft.updated_from ?? ''} onChange={(e) => set('updated_from', e.target.value)} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
          {t('filters.to')}
          <input data-testid="kt-filter-to" type="date" className={fieldClass} value={draft.updated_to ?? ''} onChange={(e) => set('updated_to', e.target.value)} />
        </label>
      </div>
      {error ? (
        <p data-testid="kt-filter-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" data-testid="kt-filter-apply" onClick={apply}>
          {t('filters.apply')}
        </Button>
        <Button size="sm" variant="outline" data-testid="kt-filter-clear" onClick={clear}>
          {t('filters.clear')}
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium">{t('filters.labels')}</p>
        {labels.length ? (
          <div className="flex flex-wrap gap-1.5">
            {labels.map((l) => {
              const on = selectedLabels.includes(l.id)
              return (
                <button
                  key={l.id}
                  type="button"
                  data-testid={`kt-filter-label-${l.id}`}
                  aria-pressed={on}
                  onClick={() => onChange(toggleLabel(search, l.id))}
                  className={cn('max-w-full truncate rounded-full border px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring', on ? 'font-semibold' : 'opacity-80')}
                  style={l.color ? { borderColor: l.color, color: l.color, backgroundColor: on ? `${l.color}1f` : undefined } : undefined}
                >
                  {l.name}
                </button>
              )
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('filters.noLabels')}</p>
        )}
      </div>
    </section>
  )
}
