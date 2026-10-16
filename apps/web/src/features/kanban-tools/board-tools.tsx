// Ferramentas do quadro aberto (T76): barra (Filtros, Estatísticas, Exportar, Adicionar coluna), painéis, modais de
// coluna/card e os extras de cada coluna (menu e "Adicionar card"). O quadro da T70 só posiciona o que vem daqui.
import { useQueryClient } from '@tanstack/react-query'
import { BarChart3, Filter, Plus } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { boardKey, boardsKey, type ColumnDto } from '@/features/crms/api'
import type { BoardState } from '@/features/crms/board-state'
import { columnColor } from '@/features/crms/format'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { readStorage, writeStorage } from '@/lib/storage'
import { notify } from '@/lib/toast'
import { columnApi, statsKey } from './api'
import { CardModal } from './card-modal'
import { ColumnMenu } from './column-menu'
import { ColumnModal } from './column-modal'
import { ConfirmDialog, useCan, type ConfirmRequest } from './dialog'
import { ExportButton, ExportStatus } from './export-control'
import { activeFilterCount, toApiFilters, type BoardSearch } from './filters'
import { FiltersPanel } from './filters-panel'
import { StatsPanel } from './stats-panel'

const STATS_STORAGE_KEY = 'crms.stats.visible'

const readStatsVisible = () => readStorage(STATS_STORAGE_KEY) === '1'

export interface BoardTools {
  toolbar: ReactNode
  panels: ReactNode
  dialogs: ReactNode
  renderColumnMenu: (column: ColumnDto) => ReactNode
  renderColumnFooter: (column: ColumnDto) => ReactNode
}

export function useBoardTools({
  crmId,
  state,
  search,
  onSearch,
}: {
  crmId: string
  state: BoardState | undefined
  search: BoardSearch
  onSearch: (next: BoardSearch) => void
}): BoardTools {
  const t = useT('kanban-tools')
  const qc = useQueryClient()
  const can = useCan()
  const canEdit = can('kanban.edit')
  const canDelete = can('kanban.delete')
  const filters = useMemo(() => toApiFilters(search), [search])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [statsOpen, setStatsOpenState] = useState(readStatsVisible)
  const [columnModal, setColumnModal] = useState<{ column: ColumnDto | null } | null>(null)
  const [cardColumn, setCardColumn] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)

  const setStatsOpen = (v: boolean) => {
    setStatsOpenState(v)
    writeStorage(STATS_STORAGE_KEY, v ? '1' : '0')
  }

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: boardKey(crmId) })
    void qc.invalidateQueries({ queryKey: statsKey(crmId) })
    void qc.invalidateQueries({ queryKey: boardsKey })
  }
  const fail = (err: unknown) => notify('kt-error', err instanceof HttpError ? err.message : t('common.error'))

  const columns = state?.columns ?? []
  const count = activeFilterCount(search)

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={filtersOpen || count ? 'default' : 'outline'}
        size="sm"
        data-testid="crms-tools-filters"
        aria-expanded={filtersOpen}
        onClick={() => setFiltersOpen(!filtersOpen)}
      >
        <Filter aria-hidden /> <span className="max-sm:sr-only">{t('filters.title')}</span>
        {count ? (
          <span data-testid="crms-tools-filters-count" className="rounded-full bg-background/20 px-1.5 text-xs tabular-nums">
            {count}
          </span>
        ) : null}
      </Button>
      <Button variant={statsOpen ? 'default' : 'outline'} size="sm" data-testid="crms-tools-stats" aria-pressed={statsOpen} onClick={() => setStatsOpen(!statsOpen)}>
        <BarChart3 aria-hidden /> <span className="max-sm:sr-only">{statsOpen ? t('stats.hide') : t('stats.show')}</span>
      </Button>
      <ExportButton crmId={crmId} filters={filters} onStarted={setJobId} />
      {canEdit ? (
        <Button size="sm" data-testid="crms-tools-add-column" onClick={() => setColumnModal({ column: null })}>
          <Plus aria-hidden /> <span className="max-sm:sr-only">{t('column.add')}</span>
        </Button>
      ) : null}
    </div>
  )

  const panels = (
    <>
      {jobId ? <ExportStatus jobId={jobId} onDismiss={() => setJobId(null)} /> : null}
      {filtersOpen ? <FiltersPanel columns={columns} search={search} onChange={onSearch} /> : null}
      {statsOpen ? <StatsPanel crmId={crmId} filters={filters} colors={Object.fromEntries(columns.map((c) => [c.id, columnColor(c)]))} /> : null}
    </>
  )

  const renderColumnMenu = (column: ColumnDto) => (
    <ColumnMenu
      column={column}
      canEdit={canEdit}
      canDelete={canDelete}
      onEdit={() => setColumnModal({ column })}
      onToggleConversion={() => columnApi.update(crmId, column.id, { conversion_goal: !column.conversion_goal }).then(refresh, fail)}
      onDelete={() =>
        setConfirm({
          title: t('column.deleteTitle'),
          body: t('column.deleteBody', { name: column.name }),
          action: t('column.delete'),
          run: async () => {
            try {
              await columnApi.remove(crmId, column.id)
              if (search.column_id === column.id) onSearch({ ...search, column_id: undefined })
              refresh()
            } catch (err) {
              fail(err)
              throw err
            }
          },
        })
      }
    />
  )

  const renderColumnFooter = (column: ColumnDto) =>
    canEdit ? (
      <Button variant="ghost" size="sm" className="w-full" data-testid={`crms-column-add-card-${column.id}`} onClick={() => setCardColumn(column.id)}>
        <Plus aria-hidden /> {t('card.add')}
      </Button>
    ) : null

  const dialogs = (
    <>
      <ColumnModal
        open={!!columnModal}
        crmId={crmId}
        column={columnModal?.column ?? null}
        nextPosition={columns.length}
        onClose={() => setColumnModal(null)}
        onSaved={refresh}
      />
      <CardModal crmId={crmId} columnId={cardColumn} onClose={() => setCardColumn(null)} onCreated={refresh} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  )

  return { toolbar, panels, dialogs, renderColumnMenu, renderColumnFooter }
}
