// Histórico de vendas (02 §3.7, §5.36; T87), abaixo do painel de Vendas: mesmos filtros do dashboard (período,
// conexões, produtos), 20 por página com rolagem infinita até "Fim do histórico", "Nova venda" (perm `sales.edit`) que
// põe a venda criada no topo e "Exportar CSV" bloqueado com 0 linhas (com linhas: ainda sem backend, "em breve").
// Colunas/ações extras por linha (NF, "Reemitir") entram pelos slots de `./slots` (T114).
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { bootstrapQuery, dashboardKey, DEFAULT_TZ } from '@/features/dashboard/api'
import { DASH } from '@/features/dashboard/format'
import { periodOf } from '@/features/dashboard/search'
import type { DashboardTabProps } from '@/features/dashboard/tabs'
import { useI18n, useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { salesHistoryQuery, type SaleDto } from './api'
import { exportState, flattenSales, formatAmount, formatSoldAt, historyParams, prependSale } from './logic'
import { SaleModal } from './sale-modal'
import { collectSaleSlots, saleActions, saleColumns } from './slots'

collectSaleSlots(import.meta.glob('../*/sale-history-slot.tsx', { eager: true }))

const NS = 'dashboard-history'

const COLUMNS = ['instance_name', 'instance_number', 'lead_number', 'customer_name', 'product', 'id', 'amount', 'currency', 'source_id', 'sold_at'] as const
type Column = (typeof COLUMNS)[number]

export function HistoryPanel({ connectionIds, period: periodProp, timeZone, search, ready = true }: DashboardTabProps) {
  const t = useT(NS)
  const { locale } = useI18n()
  const qc = useQueryClient()
  const tz = timeZone ?? DEFAULT_TZ
  const period = periodProp ?? periodOf(search ?? {}, tz)
  const params = useMemo(() => historyParams(period, connectionIds, search), [period, connectionIds, search])
  const query = salesHistoryQuery(params)
  const q = useInfiniteQuery({ ...query, enabled: ready })
  const profile = useQuery(profileQuery()).data
  const canEdit = !!profile && hasAny(sessionFrom(profile), ['sales.edit'])
  const products = useQuery(bootstrapQuery(locale)).data?.products ?? []
  const [creating, setCreating] = useState(false)

  const rows = flattenSales(q.data)
  const hasMore = !!q.hasNextPage
  const exp = exportState(rows.length)
  const extraColumns = saleColumns()
  const actions = saleActions()

  // Rolagem infinita: a sentinela no fim da tabela pede a próxima página.
  const sentinel = useRef<HTMLDivElement>(null)
  const { isFetchingNextPage, fetchNextPage } = q
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && !isFetchingNextPage && void fetchNextPage(), { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, isFetchingNextPage, fetchNextPage, rows.length])

  const onCreated = (sale: SaleDto) => {
    setCreating(false)
    // A venda vai para o topo da lista em cache (sem recarregar: a ordem do servidor a poria abaixo se o `sold_at` for
    // antigo). Os números do painel de Vendas são recalculados.
    qc.setQueryData(query.queryKey, (old) => prependSale(old, sale))
    void qc.invalidateQueries({ queryKey: dashboardKey })
  }

  const cell = (s: SaleDto, c: Column) => {
    switch (c) {
      case 'product':
        return s.product_name ?? DASH
      case 'id':
        return s.external_id ?? s.id.slice(0, 8)
      case 'amount':
        return formatAmount(s.amount_cents, s.currency, locale)
      case 'sold_at':
        return formatSoldAt(s.sold_at, tz, locale)
      default:
        return s[c] || DASH
    }
  }

  return (
    <section data-testid="dashboard-history" className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">{t('title')}</h2>
        <div className="flex flex-col items-end gap-0.5">
          <Button variant="outline" size="sm" data-testid="dashboard-history-export" disabled={!exp.enabled} aria-describedby="dashboard-history-export-reason" data-reason={exp.reason}>
            <Download aria-hidden /> {t('export.label')}
          </Button>
          <span id="dashboard-history-export-reason" data-testid="dashboard-history-export-reason" className="text-[11px] text-muted-foreground">
            {t(`export.${exp.reason}`)}
          </span>
        </div>
        {canEdit ? (
          <Button size="sm" data-testid="dashboard-history-new" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> {t('new')}
          </Button>
        ) : null}
      </div>

      {q.isPending ? (
        <div data-testid="dashboard-history-loading" aria-busy className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-md bg-muted/60" />
          ))}
        </div>
      ) : q.isError && rows.length === 0 ? (
        <div data-testid="dashboard-history-error" role="alert" className="flex flex-col items-center gap-3 p-6 text-center text-sm">
          <p>{t('error')}</p>
          <Button variant="outline" size="sm" data-testid="dashboard-history-retry" onClick={() => void q.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div data-testid="dashboard-history-empty" className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          <p>{t('empty')}</p>
          {canEdit ? (
            <Button size="sm" variant="outline" data-testid="dashboard-history-empty-new" onClick={() => setCreating(true)}>
              <Plus aria-hidden /> {t('new')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table data-testid="dashboard-history-table" className="w-full min-w-[60rem] text-sm">
            <thead className="text-left text-[11px] tracking-wide text-muted-foreground uppercase">
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c} scope="col" className={c === 'amount' ? 'px-2 py-2 text-right font-medium' : 'px-2 py-2 font-medium'}>
                    {t(`columns.${c}`)}
                  </th>
                ))}
                {extraColumns.map((c) => (
                  <th key={c.id} scope="col" className="px-2 py-2 font-medium">
                    {c.header()}
                  </th>
                ))}
                {actions.length ? (
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    {t('columns.actions')}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} data-testid={`dashboard-history-item-${s.id}`} className="border-t">
                  {COLUMNS.map((c) => (
                    <td key={c} data-testid={`dashboard-history-item-${c.replace(/_/g, '-')}-${s.id}`} className={c === 'amount' ? 'px-2 py-2 text-right whitespace-nowrap tabular-nums' : 'max-w-48 truncate px-2 py-2'}>
                      {cell(s, c)}
                    </td>
                  ))}
                  {extraColumns.map((c) => (
                    <td key={c.id} data-testid={`dashboard-history-item-${c.id}-${s.id}`} className="px-2 py-2">
                      {c.cell(s)}
                    </td>
                  ))}
                  {actions.length ? (
                    <td className="px-2 py-2">
                      <div className="flex justify-end gap-1">
                        {actions.map((a) => (
                          <span key={a.id}>{a.render(s)}</span>
                        ))}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <div ref={sentinel} data-testid="dashboard-history-sentinel" className="h-px" />
          {isFetchingNextPage ? (
            <p data-testid="dashboard-history-loading-more" className="p-2 text-center text-xs text-muted-foreground">
              {t('loadingMore')}
            </p>
          ) : hasMore ? (
            <div className="flex justify-center p-2">
              <Button variant="ghost" size="sm" data-testid="dashboard-history-more" onClick={() => void fetchNextPage()}>
                {t('more')}
              </Button>
            </div>
          ) : (
            <p data-testid="dashboard-history-end" className="p-2 text-center text-xs text-muted-foreground">
              {t('end')}
            </p>
          )}
        </div>
      )}
      <SaleModal open={creating} onClose={() => setCreating(false)} onCreated={onCreated} timeZone={tz} products={products} />
    </section>
  )
}
