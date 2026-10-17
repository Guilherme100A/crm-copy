// `/customers` (05 §2): cabeçalho com a contagem ("N+" quando o total é desconhecido), ações (Filtros, Importar do
// WhatsApp só com conexão conectada, Exportar CSV), busca com debounce de 500 ms, chips dos filtros ativos, lista com
// rolagem infinita (tabela no desktop, cartões no mobile), seleção em massa com exclusões e barra de ações em massa
// (excluir, disparo em massa, exportar, limpar). Trocar de empresa limpa seleção e filtros (05 §5 nº 23).
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Download, Filter, MessageCircle, Search, Send, Smartphone, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useContactActions } from '@/features/contact-form/actions'
import { useContactJobActions } from '@/features/contact-jobs/actions'
import { useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import {
  boardsQuery,
  CONTACTS_KEY,
  connectionsQuery,
  contactsCountQuery,
  contactsListQuery,
  firstConnected,
  labelsQuery,
  type ContactDto,
} from './api'
import { ContactsCards, ContactsTable, type ListSelectionProps } from './contact-list'
import { BulkDeleteDialog, ExportDialog, ImportWhatsAppDialog } from './dialogs'
import {
  chipsOf,
  clearAdvanced,
  hasFilters,
  toApiFilters,
  withoutChip,
  type Chip,
  type ContactsSearch,
} from './filters'
import { FiltersModal } from './filters-modal'
import {
  bulkDeleteManifest,
  emptySelection,
  exportBody,
  MASS_DISPATCH_DRAFT_KEY,
  massDispatchDraft,
  selectAll,
  selectedCount,
  toggle,
  toggleVisible,
  type Selection,
} from './selection'

export const SEARCH_DEBOUNCE_MS = 500

type Dialog = 'filters' | 'delete' | 'export' | 'export-filtered' | 'import-whatsapp' | null

export function ContactsPage({
  search,
  onSearch,
}: {
  search: ContactsSearch
  onSearch: (next: ContactsSearch) => void
}) {
  const t = useT('contacts')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const profile = useQuery(profileQuery()).data
  const session = profile ? sessionFrom(profile) : null
  const companyId = session?.company?.id ?? null
  const can = (key: string) => !!session && hasAny(session, [key])

  // Troca de empresa: enquanto os search params da empresa anterior não foram limpos, a lista já consulta a nova
  // sem filtros (seleção, busca e filtros zeram no efeito abaixo).
  const [scope, setScope] = useState(companyId)
  const switching = scope !== null && scope !== companyId
  const filters = useMemo(() => (switching ? {} : toApiFilters(search)), [search, switching])
  const filtered = !switching && hasFilters(search)
  const q = useInfiniteQuery(contactsListQuery(companyId, filters))
  const items = useMemo(() => {
    const seen = new Set<string>()
    const out: ContactDto[] = []
    for (const p of q.data?.pages ?? []) for (const c of p.items) if (!seen.has(c.id) && seen.add(c.id)) out.push(c)
    return out
  }, [q.data])
  const first = q.data?.pages[0]?.page
  const total = first ? first.total_count : null
  const hasMore = q.hasNextPage
  const [menuOpened, setMenuOpened] = useState(false)

  const connections = useQuery(connectionsQuery())
  const connected = firstConnected(connections.data)

  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [text, setText] = useState(search.q ?? '')
  // T86: Novo contato, Editar/Abrir chat por linha, Importar CSV e Exportações recentes.
  const contactActions = useContactActions()
  const jobActions = useContactJobActions()

  // Busca com debounce de 500 ms: só a última digitação vira search param (e consulta).
  useEffect(() => {
    if ((search.q ?? '') === (text.trim() ? text : '')) return
    const timer = setTimeout(() => onSearch({ ...search, q: text.trim() ? text : undefined }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, search, onSearch])

  // "Todos do filtro" vale para o filtro em que foi escolhido: mudou o filtro, o modo todos sai.
  const filtersKey = JSON.stringify(filters)
  const lastFilters = useRef(filtersKey)
  useEffect(() => {
    if (lastFilters.current === filtersKey) return
    lastFilters.current = filtersKey
    setSelection((s) => (s.all ? emptySelection() : s))
  }, [filtersKey])

  // Troca de empresa: zera seleção, busca e filtros; a empresa nova vale quando a URL já está limpa.
  const searchEmpty = Object.values(search).every((v) => v === undefined)
  useEffect(() => {
    if (scope === companyId) return
    if (scope === null || !switching) {
      setScope(companyId)
      return
    }
    setSelection(emptySelection())
    setText('')
    setDialog(null)
    setMenuOpened(false)
    if (searchEmpty) setScope(companyId)
    else onSearch({})
  }, [scope, companyId, switching, searchEmpty, onSearch])

  // Rolagem infinita: a sentinela no fim da lista pede a próxima página.
  const sentinel = useRef<HTMLDivElement>(null)
  const { isFetchingNextPage, fetchNextPage } = q
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && !isFetchingNextPage && void fetchNextPage(),
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, isFetchingNextPage, fetchNextPage, items.length])

  // Total do filtro: o da lista quando veio; com filtro (skip_total) consulta à parte quando a seleção precisa dele.
  const needsCount = total === null && (menuOpened || selection.all)
  const countQ = useQuery({ ...contactsCountQuery(companyId, filters), enabled: needsCount && !switching })
  const filterTotal = total ?? countQ.data ?? null

  const order = useMemo(() => items.map((c) => c.id), [items])
  const count = selectedCount(selection, filterTotal, items.length)
  const countText = `${count.n}${count.estimated ? '+' : ''}`
  const totalText = filterTotal !== null ? String(filterTotal) : `${items.length}${hasMore ? '+' : ''}`
  const selecting = count.n > 0

  const listProps: ListSelectionProps = {
    selection,
    onToggle: (id, shift) => setSelection((s) => toggle(s, id, order, shift)),
    onToggleVisible: () => setSelection((s) => toggleVisible(s, order)),
    onSelectAll: () => setSelection(selectAll()),
    allMode: filtered ? 'filter' : 'account',
    allLabel: t(filtered ? 'select.allFilter' : 'select.allAccount', { n: totalText }),
    allReady: filterTotal !== null || !hasMore,
    onMenuOpen: () => setMenuOpened(true),
    rowActions: contactActions.rowActions,
  }

  const clearSelection = () => setSelection(emptySelection())
  const exportCount = dialog === 'export-filtered' ? totalText : countText

  return (
    <section
      data-testid="page-contacts"
      className={cn('mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4', selecting && 'pb-20')}
    >
      <header className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p data-testid="contacts-count" className="text-sm text-muted-foreground">
            {q.isPending
              ? t('loadingCount')
              : total !== null || !hasMore
                ? t((total ?? items.length) === 1 ? 'count.one' : 'count.other', { n: total ?? items.length })
                : t('count.unknown', { n: items.length })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" data-testid="contacts-filters-open" onClick={() => setDialog('filters')}>
            <Filter aria-hidden /> {t('actions.filters')}
            {chipsOf(search).length ? (
              <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
                {chipsOf(search).length}
              </span>
            ) : null}
          </Button>
          {connected && can('contacts.edit') ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="contacts-import-whatsapp"
              onClick={() => setDialog('import-whatsapp')}
            >
              <Smartphone aria-hidden /> {t('actions.importWhatsapp')}
            </Button>
          ) : null}
          {jobActions.recentExportsButton}
          <Button
            variant="outline"
            size="sm"
            data-testid="contacts-export-csv"
            onClick={() => setDialog('export-filtered')}
          >
            <Download aria-hidden /> {t('actions.exportCsv')}
          </Button>
          {jobActions.importButton}
          {contactActions.newButton}
        </div>
      </header>

      <label className="relative block w-full sm:max-w-md">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          data-testid="contacts-search"
          type="text"
          inputMode="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          className="h-9 w-full rounded-md border bg-background pr-9 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {text ? (
          <button
            type="button"
            data-testid="contacts-search-clear"
            aria-label={t('search.clear')}
            className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent"
            onClick={() => {
              setText('')
              onSearch({ ...search, q: undefined })
            }}
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </label>

      <Chips search={search} onSearch={onSearch} />

      {q.isPending ? (
        <div data-testid="contacts-loading" className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg border bg-muted/40" />
          ))}
        </div>
      ) : q.isError ? (
        <div data-testid="contacts-error" className="flex flex-wrap items-center gap-3 rounded-lg border p-4 text-sm">
          <span className="flex-1">{t('states.error')}</span>
          <Button variant="outline" size="sm" data-testid="contacts-retry" onClick={() => void q.refetch()}>
            {t('states.retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div
          data-testid="contacts-empty"
          className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"
        >
          <MessageCircle className="size-8" aria-hidden />
          <p>{filtered ? t('states.emptyFiltered') : t('states.empty')}</p>
          {filtered ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setText('')
                onSearch({})
              }}
            >
              {t('chips.clear')}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {isDesktop ? <ContactsTable items={items} {...listProps} /> : <ContactsCards items={items} {...listProps} />}
          <div ref={sentinel} className="h-px" aria-hidden />
          {isFetchingNextPage ? (
            <p className="text-center text-xs text-muted-foreground">{t('states.loadingMore')}</p>
          ) : null}
        </>
      )}

      {selecting ? (
        <div
          data-testid="contacts-bulk-bar"
          role="toolbar"
          aria-label={t('bulk.label')}
          className="fixed inset-x-4 bottom-20 z-40 flex flex-wrap items-center gap-2 rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur lg:inset-x-auto lg:right-6 lg:bottom-6 lg:w-[min(44rem,calc(100vw-20rem))]"
        >
          <span data-testid="contacts-bulk-count" className="px-2 text-sm font-medium tabular-nums">
            {t(count.n === 1 && !count.estimated ? 'bulk.countOne' : 'bulk.count', { n: countText })}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {can('contacts.delete') ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                data-testid="contacts-bulk-delete"
                onClick={() => setDialog('delete')}
              >
                <Trash2 aria-hidden /> <span className="max-sm:sr-only">{t('bulk.delete')}</span>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              data-testid="contacts-bulk-dispatch"
              onClick={() => {
                const draft = massDispatchDraft(selection, filters, count.n)
                void navigate({
                  to: '/mass-dispatches',
                  state: (prev) => ({ ...prev, [MASS_DISPATCH_DRAFT_KEY]: draft }),
                })
              }}
            >
              <Send aria-hidden /> <span className="max-sm:sr-only">{t('bulk.dispatch')}</span>
            </Button>
            <Button variant="ghost" size="sm" data-testid="contacts-bulk-export" onClick={() => setDialog('export')}>
              <Download aria-hidden /> <span className="max-sm:sr-only">{t('bulk.export')}</span>
            </Button>
            <Button variant="outline" size="sm" data-testid="contacts-bulk-clear" onClick={clearSelection}>
              <X aria-hidden /> <span className="max-sm:sr-only">{t('bulk.clear')}</span>
            </Button>
          </div>
        </div>
      ) : null}

      <FiltersModal
        open={dialog === 'filters'}
        search={search}
        onClose={() => setDialog(null)}
        onApply={(next) => {
          onSearch(next)
          setDialog(null)
        }}
      />
      <BulkDeleteDialog
        open={dialog === 'delete'}
        count={countText}
        manifest={() => bulkDeleteManifest(selection, filters)}
        onClose={() => setDialog(null)}
        onDone={() => {
          clearSelection()
          void qc.invalidateQueries({ queryKey: [...CONTACTS_KEY, 'list'] })
        }}
      />
      <ExportDialog
        open={dialog === 'export' || dialog === 'export-filtered'}
        count={exportCount}
        body={(custom) => exportBody(dialog === 'export' ? selection : null, filters, custom)}
        onClose={() => setDialog(null)}
      />
      <ImportWhatsAppDialog
        open={dialog === 'import-whatsapp'}
        connection={connected}
        onClose={() => setDialog(null)}
      />
      {contactActions.dialogs}
      {jobActions.dialogs}
    </section>
  )
}

/** Chips dos filtros ativos (05 §2, `qge`): remoção individual + "Limpar filtros". */
function Chips({ search, onSearch }: { search: ContactsSearch; onSearch: (next: ContactsSearch) => void }) {
  const t = useT('contacts')
  const chips = chipsOf(search)
  const labels = useQuery({ ...labelsQuery(), enabled: chips.some((c) => c.kind === 'label') }).data ?? []
  const boards = useQuery({ ...boardsQuery(), enabled: chips.some((c) => c.kind === 'column') }).data ?? []
  if (!chips.length) return null
  const columnName = (id: string) => {
    for (const b of boards) {
      const c = b.columns.find((x) => x.id === id)
      if (c) return `${b.name} · ${c.name}`
    }
    return t('chips.unknownColumn')
  }
  const chipText = (c: Chip): string => {
    switch (c.kind) {
      case 'label':
        return t('chips.label', { name: labels.find((l) => l.id === c.id)?.name ?? t('chips.unknownLabel') })
      case 'column':
        return t('chips.column', { name: columnName(c.id) })
      case 'created-at':
        return search.from && search.to
          ? t('chips.createdBetween', { from: formatDay(search.from), to: formatDay(search.to) })
          : search.from
            ? t('chips.createdFrom', { from: formatDay(search.from) })
            : t('chips.createdTo', { to: formatDay(search.to ?? '') })
      case 'custom-field':
        return search.cf_value?.trim()
          ? t('chips.customValue', { key: search.cf_key ?? '', value: search.cf_value })
          : t('chips.customKey', { key: search.cf_key ?? '' })
    }
  }
  const testId = (c: Chip) =>
    c.kind === 'label' || c.kind === 'column' ? `contacts-chip-${c.kind}-${c.id}` : `contacts-chip-${c.kind}`
  return (
    <div data-testid="contacts-chips" className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <span
          key={testId(c)}
          data-testid={testId(c)}
          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 py-0.5 pr-1 pl-3 text-xs"
        >
          <span className="truncate">{chipText(c)}</span>
          <button
            type="button"
            data-testid="contacts-chip-remove"
            aria-label={t('chips.remove', { name: chipText(c) })}
            className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-accent"
            onClick={() => onSearch(withoutChip(search, c))}
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="h-7"
        data-testid="contacts-filters-clear"
        onClick={() => onSearch(clearAdvanced(search))}
      >
        {t('chips.clear')}
      </Button>
    </div>
  )
}

/** `AAAA-MM-DD` → `DD/MM/AAAA` (sem fuso: é um dia do calendário). */
export function formatDay(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : d
}
