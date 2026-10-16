// `/crms` (04 §2): indicadores agregados, busca local por nome e grade de quadros com mini-funil e métricas.
// Criar/editar/excluir quadro são da T76.
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Columns3, DollarSign, LayoutGrid, Search, TrendingUp } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useI18n, useT } from '@/i18n'
import { boardsQuery, type BoardDto } from './api'
import { columnColor, filterBoards, formatBRL, formatPercent, overviewOf } from './format'

export function CrmsListPage() {
  const t = useT('crms')
  const q = useQuery(boardsQuery())
  const [search, setSearch] = useState('')
  const boards = useMemo(() => q.data ?? [], [q.data])
  const overview = useMemo(() => overviewOf(boards), [boards])
  const visible = useMemo(() => filterBoards(boards, search), [boards, search])

  return (
    <section data-testid="crms-page" className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('list.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('list.subtitle')}</p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat testid="crms-stat-boards" icon={<LayoutGrid />} label={t('list.stats.boards')} value={String(overview.boards)} />
        <Stat testid="crms-stat-cards" icon={<Columns3 />} label={t('list.stats.cards')} value={String(overview.cards)} />
        <Stat testid="crms-stat-value" icon={<DollarSign />} label={t('list.stats.value')} value={formatBRL(overview.valueCents, 0)} />
        <Stat testid="crms-stat-conversion" icon={<TrendingUp />} label={t('list.stats.conversion')} value={formatPercent(overview.conversionRate)} />
      </div>

      <label className="relative block w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          data-testid="crms-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('list.search')}
          aria-label={t('list.search')}
          className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      {q.isPending ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-56 animate-pulse rounded-xl border bg-muted/40" />
          ))}
        </div>
      ) : q.isError ? (
        <div data-testid="crms-error" className="flex items-center gap-3 rounded-lg border p-4 text-sm">
          <span className="flex-1">{t('list.error')}</span>
          <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
            {t('list.retry')}
          </Button>
        </div>
      ) : boards.length === 0 ? (
        <p data-testid="crms-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('list.empty')}
        </p>
      ) : visible.length === 0 ? (
        <p data-testid="crms-search-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('list.searchEmpty', { q: search.trim() })}
        </p>
      ) : (
        <ul data-testid="crms-grid" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((b) => (
            <li key={b.id} className="min-w-0">
              <BoardTile board={b} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Stat({ testid, icon, label, value }: { testid: string; icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border bg-card p-3 sm:p-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p data-testid={testid} className="truncate text-lg font-semibold tabular-nums">
          {value}
        </p>
      </div>
    </div>
  )
}

function BoardTile({ board }: { board: BoardDto }) {
  const t = useT('crms')
  const { locale } = useI18n()
  const columns = [...board.columns].sort((a, b) => a.position - b.position)
  const s = board.summary
  const updated = new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(new Date(board.updated_at))
  return (
    <Link
      to="/crms/$crmId"
      params={{ crmId: board.id }}
      data-testid={`crms-board-${board.id}`}
      className="flex h-full flex-col gap-3 rounded-xl border bg-card p-4 transition-colors outline-none hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="min-w-0">
        <h2 data-testid={`crms-board-name-${board.id}`} className="truncate font-semibold">
          {board.name}
        </h2>
        <p data-testid={`crms-board-columns-${board.id}`} className="text-xs text-muted-foreground">
          {t('list.board.columns', { n: board.quantity_of_columns || columns.length })}
        </p>
      </div>

      <div data-testid={`crms-board-funnel-${board.id}`} className="flex flex-col gap-1">
        <div className="flex h-2 overflow-hidden rounded-full bg-muted">
          {columns.map((c) => (
            <span key={c.id} className="h-full flex-1" style={{ backgroundColor: columnColor(c) }} />
          ))}
        </div>
        <div className="flex gap-1 overflow-hidden text-[11px] text-muted-foreground">
          {columns.map((c) => (
            <span key={c.id} data-testid={`crms-board-funnel-step-${c.id}`} className="min-w-0 flex-1 truncate" title={c.name}>
              {c.name}
            </span>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-sm">
        <Metric label={t('list.board.cards')} testid={`crms-board-cards-${board.id}`} value={String(s.total_cards)} />
        <Metric label={t('list.board.value')} testid={`crms-board-value-${board.id}`} value={formatBRL(s.total_value_cents, 0)} />
        <Metric label={t('list.board.converted')} testid={`crms-board-converted-${board.id}`} value={String(s.conversion_count)} />
      </dl>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t('list.board.rate')}</span>
          <span data-testid={`crms-board-rate-${board.id}`} className="font-medium tabular-nums">
            {formatPercent(s.conversion_rate)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, Math.max(0, s.conversion_rate))}%` }} />
        </div>
      </div>

      <p className="mt-auto text-xs text-muted-foreground">{t('list.board.updated', { date: updated })}</p>
    </Link>
  )
}

function Metric({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={testid} className="truncate font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  )
}
