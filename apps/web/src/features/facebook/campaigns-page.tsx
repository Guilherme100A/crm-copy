// Gerenciador de anúncios (11 §2.1, §3.4–3.5, §4, §5.2–5.3; AC-T106-02/03/04/05). O bundle traz os três níveis de uma
// vez (`async=1`: 202 até o job terminar, com progresso pelo SSE `meta.bundle.progress`); a tela mostra os estados
// (sem contas, nenhuma incluída, carregando/parcial/pronto, limite da Meta, erros por conta), a tabela com colunas de
// métricas reordenáveis (ordem por empresa no localStorage), o switch de status otimista e o modal de nome/orçamento.
import { Dialog } from '@base-ui/react/dialog'
import { Popover } from '@base-ui/react/popover'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowDown, ArrowUp, Columns3, Filter, GripVertical, Info, Pencil, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { inputClass, serverMessage, useDebounced } from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { hasAny } from '@/lib/session'
import { readStorage, writeStorage } from '@/lib/storage'
import { notify } from '@/lib/toast'
import { useIsDesktop, useMediaQuery } from '@/lib/use-media-query'
import { APP_NAME, cn } from '@/lib/utils'
import { bundleKeyPrefix, bundleQueryKey, fetchBundle, fetchProfiles, patchEntity, profilesKey, type BundleEnvelope, type BundleMode, type BundleQuery, type BundleRow } from './api'
import { FacebookLayout, NS, selectClass, useFacebookSession } from './layout'
import { onBundleProgress } from './realtime'
import {
  accountErrorsSummary,
  agoParts,
  budgetInitial,
  canToggle,
  cellValue,
  columnOrderKey,
  cooldownLeft,
  currencyKey,
  currencyList,
  dropColumn,
  editModes,
  editPatch,
  formatCell,
  formatMoney,
  isDefaultOrder,
  isRateLimited,
  LEVELS,
  managerView,
  matchesSearch,
  matchesStatus,
  METRIC_COLUMNS,
  moveColumn,
  nextSort,
  normalizeCurrency,
  PAIR_COLUMNS,
  parseColumnOrder,
  periodQuery,
  PERIODS,
  rowCount,
  serverStatusFilter,
  shouldReplace,
  sortRows,
  applyProbable,
  probableSales,
  statusKey,
  statusOptions,
  statusTone,
  togglePatch,
  totals,
  progressReadMode,
  type BundleLevel,
  type EditMode,
  type MetricColumn,
  type Period,
  type SortKey,
  type SortState,
} from './rules'

export interface CampaignsSearch {
  fb_level?: BundleLevel
  fb_status?: string
  fb_q?: string
  fb_period?: Period
  fb_since?: string
  fb_until?: string
}

/** Polling de reserva enquanto o bundle está pendente (o SSE é o caminho normal). */
export const POLL_MS = 3000
/**
 * Leituras `async` seguidas sem nenhum avanço (status, contas, linhas) antes de ler em modo `sync`. Bundle pronto com
 * erro de conta não fica no cache do servidor, e o reenfileiramento com o mesmo jobId é deduplicado pelo BullMQ contra
 * o job concluído: o estado ficaria `loading` até expirar (pendência registrada no relatório da T106).
 */
const STALL_POLLS = 4
const CACHE_MS = 5 * 60_000
const AGO_TICK_MS = 15_000

/** Último "Atualizar" por empresa (o cooldown sobrevive à troca de aba do módulo). */
const refreshUsedAt = new Map<string, number>()

/** Agora, re-renderizado a cada `ms` enquanto `active`. */
function useNow(ms: number, active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms, active])
  return now
}

export function CampaignsPage({ search, onSearch }: { search: CampaignsSearch; onSearch: (next: CampaignsSearch) => void }) {
  const t = useT(NS)
  const { locale } = useI18n()
  const qc = useQueryClient()
  const desktop = useIsDesktop()
  const session = useFacebookSession()
  const companyId = session?.company?.id ?? ''
  const canProfiles = !!session && hasAny(session, ['facebook.profiles'])

  const level: BundleLevel = search.fb_level ?? 'campaign'
  const fbStatus = search.fb_status ?? 'active'
  const period: Period = search.fb_period ?? 'today'

  // Moeda de exibição: escolha do cliente por empresa (não há coluna na empresa; T101), enviada em `display_currency`.
  const [currency, setCurrencyState] = useState(() => normalizeCurrency(readStorage(currencyKey(companyId))))
  useEffect(() => setCurrencyState(normalizeCurrency(readStorage(currencyKey(companyId)))), [companyId])
  const setCurrency = (c: string) => {
    setCurrencyState(c)
    writeStorage(currencyKey(companyId), c)
  }

  const [accounts, setAccounts] = useState<string[]>([])
  useEffect(() => setAccounts([]), [companyId])

  const periodQ = periodQuery(period, search.fb_since, search.fb_until)
  const bq: BundleQuery = {
    status_filter: serverStatusFilter(fbStatus),
    date_preset: periodQ?.date_preset ?? 'custom',
    ...(periodQ?.since ? { since: periodQ.since, until: periodQ.until } : {}),
    display_currency: currency,
    ad_account_ids: accounts,
  }
  const key = bundleQueryKey(companyId, bq)
  const keyStr = JSON.stringify(key)

  const modeRef = useRef<BundleMode>('async')
  const stall = useRef<{ sig: string | null; count: number }>({ sig: null, count: 0 })
  const bqRef = useRef(bq)
  bqRef.current = bq
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      let mode = modeRef.current
      modeRef.current = 'async'
      if (mode === 'async' && stall.current.count >= STALL_POLLS) mode = 'sync'
      const res = await fetchBundle(bqRef.current, mode)
      if (mode === 'async' && res.status !== 'ready') {
        const sig = `${res.bundle_key}:${res.status}:${res.targets_done}:${rowCount(res)}`
        stall.current = { sig, count: sig === stall.current.sig ? stall.current.count + 1 : 0 }
      } else stall.current = { sig: null, count: 0 }
      return res
    },
    enabled: !!companyId && !!periodQ,
    staleTime: (q) => (q.state.data && q.state.data.status === 'ready' && !isRateLimited(q.state.data) ? CACHE_MS : 0),
    gcTime: CACHE_MS,
    refetchInterval: (q) => {
      const d = q.state.data
      if (!d || d.status === 'ready') return false
      if (isRateLimited(d) && rowCount(d) === 0) return false
      return POLL_MS
    },
    refetchOnWindowFocus: false,
    retry: false,
  })
  useEffect(() => {
    stall.current = { sig: null, count: 0 }
  }, [keyStr])

  // Bundle exibido: um pronto não é trocado por um pendente (refresh mostra os dados atuais até o novo ficar pronto).
  const [shown, setShown] = useState<{ key: string; bundle: BundleEnvelope } | null>(null)
  useEffect(() => {
    const d = query.data
    if (!d) return
    setShown((cur) => (cur && cur.key === keyStr && !shouldReplace(cur.bundle, d) ? cur : { key: keyStr, bundle: d }))
  }, [query.data, keyStr])
  const bundle = shown?.key === keyStr ? shown.bundle : null
  // Refresh que caiu no limite da Meta para de consultar: some o "Atualizando" e fica o aviso do limite.
  const refreshing = !!bundle && bundle.status === 'ready' && !!query.data && query.data.status !== 'ready' && !isRateLimited(query.data)

  // SSE: parcial ou pronto → relê o estado em async (traz os erros de conta e o `rate_limited` do refresh; T129).
  useEffect(
    () =>
      onBundleProgress((p) => {
        const mode = progressReadMode(qc.getQueryData<BundleEnvelope>(key), p)
        if (!mode) return
        modeRef.current = mode
        void qc.refetchQueries({ queryKey: key, exact: true })
      }),
    [keyStr, qc],
  )

  const profiles = useQuery({ queryKey: profilesKey(companyId), queryFn: fetchProfiles, enabled: canProfiles && !!companyId })

  // Overrides otimistas de status (limpos quando chega um bundle pronto novo).
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [pendingId, setPendingId] = useState<string | null>(null)
  useEffect(() => setOverrides({}), [bundle?.generated_at])

  // Cooldown do "Atualizar" (30 s) e "Atualizado há X" (re-render a cada 15 s).
  const usedAt = refreshUsedAt.get(companyId) ?? null
  const [, bump] = useState(0)
  const nowCooldown = useNow(1000, cooldownLeft(usedAt, Date.now()) > 0)
  const left = cooldownLeft(usedAt, nowCooldown)
  const nowAgo = useNow(AGO_TICK_MS)

  const forceRefresh = useCallback(() => {
    modeRef.current = 'force'
    stall.current = { sig: null, count: 0 }
    void qc.refetchQueries({ queryKey: key, exact: true })
  }, [keyStr, qc])

  const onRefresh = () => {
    if (cooldownLeft(refreshUsedAt.get(companyId), Date.now()) > 0) return
    refreshUsedAt.set(companyId, Date.now())
    bump((n) => n + 1)
    forceRefresh()
    if (canProfiles) void profiles.refetch()
  }

  // Erros por conta: toast uma vez por bundle pronto (11 §5.2 nº 7).
  const accountLabel = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of profiles.data ?? []) for (const a of p.ad_accounts) map.set(a.id, a.name || a.fb_account_id)
    for (const r of bundle ? [...bundle.campaign, ...bundle.adset, ...bundle.ad] : []) if (!map.has(r.ad_account_id)) map.set(r.ad_account_id, r.ad_account_label)
    return (e: { ad_account_id: string; fb_ad_account_id: string }) => map.get(e.ad_account_id) ?? e.fb_ad_account_id
  }, [profiles.data, bundle])
  const errorsToasted = useRef<string | null>(null)
  useEffect(() => {
    if (!bundle || bundle.status !== 'ready' || !bundle.errors.length) return
    const id = `${bundle.bundle_key}:${bundle.generated_at}`
    if (errorsToasted.current === id) return
    errorsToasted.current = id
    const s = accountErrorsSummary(bundle.errors, accountLabel)
    if (s) notify('facebook-account-errors-toast', 'single' in s ? s.single : t('manager.accountErrorsMany', { count: s.count }))
  }, [bundle, accountLabel, t])

  // Colunas: ordem por empresa (chave versionada), arrastar no desktop e setas no toque.
  const [order, setOrder] = useState<MetricColumn[]>(() => parseColumnOrder(readStorage(columnOrderKey(companyId))))
  useEffect(() => setOrder(parseColumnOrder(readStorage(columnOrderKey(companyId)))), [companyId])
  const saveOrder = (next: MetricColumn[]) => {
    setOrder(next)
    writeStorage(columnOrderKey(companyId), JSON.stringify(next))
  }
  const [sort, setSort] = useState<SortState>({ key: 'default', dir: 'asc' })
  // Revisão 3: vendas de atribuição só provável ficam FORA das colunas <APP>/Meta; entram só com este filtro ligado.
  const [includeProbable, setIncludeProbable] = useState(false)

  const view = bundle ? managerView(bundle, canProfiles ? (profiles.data ?? null) : null, refreshing, query.data ?? null) : null
  const filtered = useMemo(() => {
    if (!bundle) return { campaign: [], adset: [], ad: [] } as Record<BundleLevel, BundleRow[]>
    // Filtra pelo status do servidor e mostra o otimista: a linha alternada não some antes do bundle novo.
    const pick = (rows: BundleRow[]) =>
      rows
        .filter((r) => matchesStatus(r, fbStatus) && matchesSearch(r, search.fb_q ?? ''))
        .map((r) => applyProbable(overrides[r.id] ? { ...r, status: overrides[r.id]! } : r, includeProbable))
    return { campaign: pick(bundle.campaign), adset: pick(bundle.adset), ad: pick(bundle.ad) }
  }, [bundle, overrides, fbStatus, search.fb_q, includeProbable])
  const probableCount = useMemo(() => probableSales(bundle?.campaign ?? []), [bundle])
  const rows = useMemo(() => sortRows(filtered[level], sort), [filtered, level, sort])
  const allRows = bundle ? [...bundle.campaign, ...bundle.adset, ...bundle.ad] : []

  const [editing, setEditing] = useState<BundleRow | null>(null)

  const onToggle = async (row: BundleRow) => {
    if (pendingId) return
    const body = togglePatch(row, level)
    setPendingId(row.id)
    setOverrides((o) => ({ ...o, [row.id]: body.status! }))
    try {
      const res = await patchEntity(row.id, body)
      if (!res?.success) throw new Error('not_success')
      notify('facebook-status-updated', t('manager.statusUpdated'))
      qc.removeQueries({ queryKey: bundleKeyPrefix, predicate: (q) => JSON.stringify(q.queryKey) !== keyStr })
      forceRefresh()
    } catch (err) {
      setOverrides((o) => {
        const next = { ...o }
        delete next[row.id]
        return next
      })
      notify('facebook-status-error', t('manager.updateError'), err instanceof HttpError ? (serverMessage(err) ?? undefined) : undefined)
    } finally {
      setPendingId(null)
    }
  }

  const onEdited = () => {
    notify('facebook-edit-saved', t('manager.edit.saved'))
    qc.removeQueries({ queryKey: bundleKeyPrefix, predicate: (q) => JSON.stringify(q.queryKey) !== keyStr })
    forceRefresh()
  }

  const ago = agoParts(bundle?.generated_at, nowAgo)
  const toolbar = (
    <>
      <AccountsFilter
        options={accountOptions(profiles.data, allRows, canProfiles)}
        applied={accounts}
        onApply={(ids) => setAccounts(ids)}
      />
      <select data-testid="facebook-period" aria-label={t('manager.period.label')} className={selectClass} value={period} onChange={(e) => onSearch({ ...search, fb_period: e.target.value as Period })}>
        {PERIODS.map((p) => (
          <option key={p} value={p}>
            {t(`manager.period.${p}`)}
          </option>
        ))}
      </select>
      {period === 'custom' ? (
        <>
          <input type="date" data-testid="facebook-since" aria-label={t('manager.period.since')} className={selectClass} value={search.fb_since ?? ''} onChange={(e) => onSearch({ ...search, fb_since: e.target.value || undefined })} />
          <input type="date" data-testid="facebook-until" aria-label={t('manager.period.until')} className={selectClass} value={search.fb_until ?? ''} onChange={(e) => onSearch({ ...search, fb_until: e.target.value || undefined })} />
        </>
      ) : null}
      <select data-testid="facebook-currency" aria-label={t('manager.currency')} className={cn(selectClass, 'w-24')} value={currency} onChange={(e) => setCurrency(e.target.value)}>
        {currencyList().map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-2">
        {ago ? (
          <span data-testid="facebook-updated-ago" className="text-xs whitespace-nowrap text-muted-foreground">
            {t(`manager.ago.${ago.unit}`, { n: ago.n })}
          </span>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          data-testid="facebook-refresh"
          disabled={left > 0 || !periodQ}
          title={left > 0 ? t('manager.cooldown', { s: Math.ceil(left / 1000) }) : undefined}
          onClick={onRefresh}
        >
          <RefreshCw className={cn((refreshing || query.isFetching) && 'animate-spin')} aria-hidden />
          {left > 0 ? t('manager.refreshIn', { s: Math.ceil(left / 1000) }) : t('manager.refresh')}
        </Button>
      </div>
    </>
  )

  const filters = (
    <StatusAndName
      level={level}
      status={fbStatus}
      q={search.fb_q ?? ''}
      options={statusOptions(allRows)}
      onStatus={(s) => onSearch({ ...search, fb_status: s === 'active' ? undefined : s })}
      onQ={(q) => onSearch({ ...search, fb_q: q || undefined })}
    />
  )

  return (
    <FacebookLayout active="campaigns" toolbar={toolbar}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label={t('manager.levels.label')} className="flex gap-1 rounded-lg bg-muted p-1">
            {LEVELS.map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={l === level}
                data-testid={`facebook-level-${l}`}
                className={cn('rounded-md px-3 py-1.5 text-sm font-medium', l === level ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                onClick={() => l !== level && onSearch({ ...search, fb_level: l === 'campaign' ? undefined : l, fb_status: undefined, fb_q: undefined })}
              >
                {t(`manager.levels.${l}`)}{' '}
                <span data-testid={`facebook-level-count-${l}`} className="text-xs text-muted-foreground tabular-nums">
                  {filtered[l].length}
                </span>
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {desktop ? filters : <MobileFilters>{filters}</MobileFilters>}
            <ColumnsMenu order={order} onChange={saveOrder} />
          </div>
        </div>

        <p data-testid="facebook-metrics-hint" className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('manager.metricsHint', { app: APP_NAME })}
        </p>
        <div data-testid="facebook-probable" className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 font-medium">
            <input type="checkbox" data-testid="facebook-probable-toggle" checked={includeProbable} onChange={(e) => setIncludeProbable(e.target.checked)} />
            {t('manager.probable.toggle')}
          </label>
          <span data-testid="facebook-probable-legend" className={includeProbable ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}>
            {includeProbable ? t('manager.probable.included', { n: probableCount, app: APP_NAME }) : t('manager.probable.excluded', { n: probableCount, app: APP_NAME })}
          </span>
        </div>

        {!periodQ ? (
          <Notice testId="facebook-period-invalid" tone="warning">
            {t('manager.period.invalid')}
          </Notice>
        ) : query.isError && !bundle ? (
          <div data-testid="facebook-error" className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 p-4 text-sm">
            <p className="text-destructive">{serverMessage(query.error) ?? t('common.loadError')}</p>
            <Button variant="outline" size="sm" data-testid="facebook-retry" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : !view ? (
          <LoadingState done={0} total={0} />
        ) : view.kind === 'no_accounts' ? (
          <EmptyCta testId="facebook-empty-profiles" title={t('manager.empty.noAccounts')} body={t('manager.empty.noAccountsHint')} canProfiles={canProfiles} />
        ) : view.kind === 'none_included' ? (
          <EmptyCta testId="facebook-empty-included" title={t('manager.empty.noneIncluded')} body={t('manager.empty.noneIncludedHint')} canProfiles={canProfiles} />
        ) : view.kind === 'rate_limited_error' ? (
          <Notice testId="facebook-rate-limited-error" tone="error">
            {t('manager.rateLimitedNoCache')}
          </Notice>
        ) : view.kind === 'loading' ? (
          <LoadingState done={view.done} total={view.total} />
        ) : (
          <>
            {view.partial ? (
              <Notice testId="facebook-partial" tone="info">
                {t('manager.partial', { done: view.done, total: view.total })}
              </Notice>
            ) : null}
            {refreshing ? (
              <Notice testId="facebook-refreshing" tone="info">
                {t('manager.refreshing')}
              </Notice>
            ) : null}
            {view.rateLimited ? (
              <Notice testId="facebook-rate-limited" tone="warning">
                {t('manager.rateLimited')}
              </Notice>
            ) : null}
            {bundle!.warnings.some((w) => w.startsWith('fx_rate_missing:')) ? (
              <Notice testId="facebook-fx-missing" tone="warning">
                {t('manager.fxMissing', { pairs: bundle!.warnings.filter((w) => w.startsWith('fx_rate_missing:')).map((w) => w.slice('fx_rate_missing:'.length)).join(', ') })}
              </Notice>
            ) : null}
            {bundle!.errors.length ? (
              <div data-testid="facebook-account-errors" role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="size-4" aria-hidden />
                  {t('manager.accountErrorsTitle', { count: bundle!.errors.length })}
                </p>
                <ul className="mt-1 list-disc pl-6">
                  {bundle!.errors.map((e) => (
                    <li key={e.ad_account_id} data-testid={`facebook-account-error-${e.ad_account_id}`}>
                      {accountLabel(e)}: {e.error}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {rows.length === 0 ? (
              <p data-testid="facebook-empty-results" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t('manager.empty.results')}
              </p>
            ) : desktop ? (
              <ManagerTable
                rows={rows}
                level={level}
                order={order}
                sort={sort}
                currency={bundle!.display_currency}
                locale={locale}
                pendingId={pendingId}
                onSort={(k) => setSort((s) => nextSort(s, k))}
                onDrop={(from, to) => saveOrder(dropColumn(order, from, to))}
                onToggle={(r) => void onToggle(r)}
                onEdit={setEditing}
              />
            ) : (
              <ManagerCards rows={rows} level={level} order={order} currency={bundle!.display_currency} locale={locale} pendingId={pendingId} onToggle={(r) => void onToggle(r)} onEdit={setEditing} />
            )}
          </>
        )}
      </div>
      {editing ? <EditDialog row={editing} level={level} onClose={() => setEditing(null)} onSaved={onEdited} /> : null}
    </FacebookLayout>
  )
}

// ---------------------------------------------------------------- toolbar e filtros

function accountOptions(profiles: { ad_accounts: { id: string; name: string | null; fb_account_id: string; included_in_dashboard: boolean }[] }[] | undefined, rows: BundleRow[], canProfiles: boolean) {
  if (canProfiles && profiles)
    return profiles.flatMap((p) => p.ad_accounts.filter((a) => a.included_in_dashboard).map((a) => ({ id: a.id, label: a.name || a.fb_account_id, sub: a.fb_account_id })))
  const map = new Map<string, { id: string; label: string; sub: string }>()
  for (const r of rows) if (!map.has(r.ad_account_id)) map.set(r.ad_account_id, { id: r.ad_account_id, label: r.ad_account_label, sub: r.fb_ad_account_id })
  return [...map.values()]
}

function AccountsFilter({ options, applied, onApply }: { options: { id: string; label: string; sub: string }[]; applied: string[]; onApply: (ids: string[]) => void }) {
  const t = useT(NS)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>(applied)
  const [q, setQ] = useState('')
  useEffect(() => {
    if (open) {
      setDraft(applied)
      setQ('')
    }
  }, [open, applied])
  const needle = q.trim().toLowerCase()
  const visible = options.filter((o) => !needle || o.label.toLowerCase().includes(needle) || o.sub.toLowerCase().includes(needle))
  const label = applied.length === 0 ? t('manager.accounts.all') : t('manager.accounts.some', { count: applied.length })
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger data-testid="facebook-accounts-filter" className={cn(selectClass, 'inline-flex items-center gap-1')}>
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-50">
          <Popover.Popup data-testid="facebook-accounts-popup" className="flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 rounded-lg border bg-popover p-3 shadow-lg outline-none">
            <input
              data-testid="facebook-accounts-search"
              className={inputClass}
              type="search"
              placeholder={t('manager.accounts.search')}
              aria-label={t('manager.accounts.search')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="flex gap-2 text-xs">
              <button type="button" data-testid="facebook-accounts-all" className="underline" onClick={() => setDraft(options.map((o) => o.id))}>
                {t('manager.accounts.selectAll')}
              </button>
              <button type="button" data-testid="facebook-accounts-clear" className="underline" onClick={() => setDraft([])}>
                {t('manager.accounts.clear')}
              </button>
            </div>
            <ul className="max-h-60 overflow-y-auto">
              {visible.length === 0 ? <li className="py-2 text-sm text-muted-foreground">{t('manager.accounts.none')}</li> : null}
              {visible.map((o) => (
                <li key={o.id}>
                  <label className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50">
                    <input
                      type="checkbox"
                      data-testid={`facebook-accounts-option-${o.id}`}
                      checked={draft.includes(o.id)}
                      onChange={(e) => setDraft((d) => (e.target.checked ? [...d, o.id] : d.filter((x) => x !== o.id)))}
                    />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    <span className="text-xs text-muted-foreground">{o.sub}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" data-testid="facebook-accounts-cancel" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                data-testid="facebook-accounts-apply"
                onClick={() => {
                  // Todas marcadas = sem filtro (todas as incluídas).
                  onApply(draft.length === options.length ? [] : [...draft].sort())
                  setOpen(false)
                }}
              >
                {t('manager.accounts.apply')}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function StatusAndName({ level, status, q, options, onStatus, onQ }: { level: BundleLevel; status: string; q: string; options: string[]; onStatus: (s: string) => void; onQ: (q: string) => void }) {
  const t = useT(NS)
  const [text, setText] = useState(q)
  useEffect(() => setText(q), [q, level])
  const debounced = useDebounced(text, 300)
  const onQRef = useRef(onQ)
  onQRef.current = onQ
  useEffect(() => {
    if (debounced !== q) onQRef.current(debounced)
  }, [debounced])
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
      <select data-testid="facebook-filter-status" aria-label={t('manager.filters.status')} className={selectClass} value={status} onChange={(e) => onStatus(e.target.value)}>
        {options.map((s) => (
          <option key={s} value={s}>
            {s === 'active' ? t('status.ACTIVE') : s === 'all' ? t('manager.filters.allStatuses') : statusKey(s) ? t(statusKey(s)!) : t('status.other', { code: s })}
          </option>
        ))}
      </select>
      <input
        data-testid="facebook-filter-name"
        type="search"
        className={cn(inputClass, 'lg:w-56')}
        placeholder={t('manager.filters.name')}
        aria-label={t('manager.filters.name')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  )
}

/** Mobile (< 1024 px): status e nome num painel "Filtros" (AC-T106-05). */
function MobileFilters({ children }: { children: ReactNode }) {
  const t = useT(NS)
  const [open, setOpen] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger data-testid="facebook-filters-open" className={cn(selectClass, 'inline-flex items-center gap-1')}>
        <Filter className="size-4" aria-hidden /> {t('manager.filters.title')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid="facebook-filters-panel" className="fixed inset-x-0 bottom-0 z-[70] flex max-h-[85dvh] flex-col gap-4 rounded-t-xl border bg-background p-4 shadow-xl outline-none">
          <Dialog.Title className="text-lg font-semibold">{t('manager.filters.title')}</Dialog.Title>
          {children}
          <Button data-testid="facebook-filters-close" onClick={() => setOpen(false)}>
            {t('manager.filters.done')}
          </Button>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ColumnsMenu({ order, onChange }: { order: MetricColumn[]; onChange: (o: MetricColumn[]) => void }) {
  const t = useT(NS)
  return (
    <Popover.Root>
      <Popover.Trigger data-testid="facebook-columns" aria-label={t('manager.columns.title')} className={cn(selectClass, 'inline-flex items-center gap-1')}>
        <Columns3 className="size-4" aria-hidden />
        <span className="hidden sm:inline">{t('manager.columns.title')}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={8} className="z-50">
          <Popover.Popup data-testid="facebook-columns-popup" className="flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-1 rounded-lg border bg-popover p-2 shadow-lg outline-none">
            <ol data-testid="facebook-columns-order">
              {order.map((c, i) => (
                <li key={c} data-testid={`facebook-column-${c}`} className="flex items-center gap-1 rounded px-1 py-0.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{columnLabel(t, c)}</span>
                  <Button variant="ghost" size="icon" className="size-7" data-testid={`facebook-column-up-${c}`} aria-label={t('manager.columns.up')} disabled={i === 0} onClick={() => onChange(moveColumn(order, c, -1))}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    data-testid={`facebook-column-down-${c}`}
                    aria-label={t('manager.columns.down')}
                    disabled={i === order.length - 1}
                    onClick={() => onChange(moveColumn(order, c, 1))}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                </li>
              ))}
            </ol>
            <Button variant="outline" size="sm" data-testid="facebook-columns-reset" disabled={isDefaultOrder(order)} onClick={() => onChange([...METRIC_COLUMNS])}>
              {t('manager.columns.reset')}
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Rótulo da coluna; as pareadas levam "<APP_NAME> / Meta" (ou "/ Pixel" nas compras). */
export function columnLabel(t: (k: string, v?: Record<string, string | number>) => string, c: MetricColumn): string {
  if (!(PAIR_COLUMNS as readonly string[]).includes(c)) return t(`manager.columns.${c}`)
  const other = c === 'purchases' ? 'Pixel' : 'Meta'
  return `${t(`manager.columns.${c}`)} (${APP_NAME} / ${other})`
}

// ---------------------------------------------------------------- estados

function Notice({ testId, tone, children }: { testId: string; tone: 'info' | 'warning' | 'error'; children: ReactNode }) {
  return (
    <p
      data-testid={testId}
      role={tone === 'info' ? 'status' : 'alert'}
      className={cn(
        'rounded-lg border p-3 text-sm',
        tone === 'info' && 'border-primary/30 bg-primary/5',
        tone === 'warning' && 'border-amber-500/40 bg-amber-500/10',
        tone === 'error' && 'border-destructive/40 bg-destructive/10 text-destructive',
      )}
    >
      {children}
    </p>
  )
}

function LoadingState({ done, total }: { done: number; total: number }) {
  const t = useT(NS)
  return (
    <div data-testid="facebook-loading" aria-busy="true" className="flex flex-col gap-2">
      <p data-testid="facebook-progress" className="text-sm text-muted-foreground">
        {total > 0 ? t('manager.loadingProgress', { done, total }) : t('manager.loading')}
      </p>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  )
}

function EmptyCta({ testId, title, body, canProfiles }: { testId: string; title: string; body: string; canProfiles: boolean }) {
  const t = useT(NS)
  return (
    <div data-testid={testId} className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center">
      <p className="font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {canProfiles ? (
        <Link to={'/facebook/profiles' as never} data-testid="facebook-cta-profiles" className="mt-2 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          {t('manager.empty.cta')}
        </Link>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------- tabela e cartões

function StatusCell({ row, pending, disabled, onToggle }: { row: BundleRow; pending: boolean; disabled: boolean; onToggle: () => void }) {
  const t = useT(NS)
  const key = statusKey(row.status)
  const label = key ? t(key) : t('status.other', { code: row.status })
  const tone = statusTone(row.status)
  const on = row.status === 'ACTIVE'
  return (
    <div className="flex items-center gap-2">
      {canToggle(row) ? (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t(on ? 'manager.pause' : 'manager.activate')}
          title={row.status === 'ARCHIVED' ? t('manager.archivedHint') : undefined}
          data-testid={`facebook-item-status-${row.id}`}
          disabled={disabled}
          aria-busy={pending || undefined}
          onClick={onToggle}
          className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', on ? 'bg-emerald-500' : 'bg-muted-foreground/30')}
        >
          <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', on ? 'translate-x-4' : 'translate-x-0.5')} />
        </button>
      ) : null}
      <span
        data-testid={`facebook-item-status-label-${row.id}`}
        data-status={row.status}
        className={cn(
          'rounded-full px-2 py-0.5 text-xs whitespace-nowrap',
          tone === 'success' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
          tone === 'warning' && 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
          tone === 'neutral' && 'bg-muted text-muted-foreground',
        )}
      >
        {label}
      </span>
    </div>
  )
}

function BudgetCell({ row, currency, locale }: { row: BundleRow; currency: string; locale: string }) {
  const t = useT(NS)
  const daily = row.daily_budget_display ?? row.daily_budget
  const lifetime = row.lifetime_budget_display ?? row.lifetime_budget
  const cur = row.daily_budget_display !== null || row.lifetime_budget_display !== null ? currency : (row.currency ?? currency)
  if (!daily && !lifetime) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-col text-xs">
      {daily ? <span>{t('manager.budget.daily', { value: formatMoney(daily, cur, locale) })}</span> : null}
      {lifetime ? <span>{t('manager.budget.lifetime', { value: formatMoney(lifetime, cur, locale) })}</span> : null}
    </div>
  )
}

function NameCell({ row, level }: { row: BundleRow; level: BundleLevel }) {
  const t = useT(NS)
  const context = level === 'ad' ? (row.adset_name ?? row.campaign_name) : level === 'adset' ? row.campaign_name : null
  return (
    <div className="min-w-0">
      <div data-testid={`facebook-item-name-${row.id}`} className="font-medium break-words">
        {row.name}
      </div>
      {context ? <div className="text-xs text-muted-foreground">{t(level === 'ad' && row.adset_name ? 'manager.contextAdset' : 'manager.contextCampaign', { name: context })}</div> : null}
      <div className="text-xs text-muted-foreground">{row.ad_account_label}</div>
    </div>
  )
}

interface RowsProps {
  rows: BundleRow[]
  level: BundleLevel
  order: MetricColumn[]
  currency: string
  locale: string
  pendingId: string | null
  onToggle: (r: BundleRow) => void
  onEdit: (r: BundleRow) => void
}

function EditButton({ row, disabled, onEdit }: { row: BundleRow; disabled: boolean; onEdit: () => void }) {
  const t = useT(NS)
  if (!row.fb_ad_account_id) return null
  return (
    <Button variant="ghost" size="icon" className="size-8" data-testid={`facebook-item-edit-${row.id}`} aria-label={t('manager.edit.open')} disabled={disabled} onClick={onEdit}>
      <Pencil aria-hidden />
    </Button>
  )
}

function ManagerTable({ rows, level, order, sort, currency, locale, pendingId, onSort, onDrop, onToggle, onEdit }: RowsProps & { sort: SortState; onSort: (k: SortKey) => void; onDrop: (from: MetricColumn, to: MetricColumn) => void }) {
  const t = useT(NS)
  const coarse = useMediaQuery('(pointer: coarse)')
  const [dragging, setDragging] = useState<MetricColumn | null>(null)
  const total = totals(rows)
  const sortHeader = (k: SortKey, label: string) => (
    <button type="button" data-testid={`facebook-sort-${k}`} className="inline-flex items-center gap-1 uppercase hover:text-foreground" onClick={() => onSort(k)}>
      {label}
      {sort.key === k ? <span aria-hidden>{sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
    </button>
  )
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table data-testid="facebook-table" className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {sortHeader('name', t(`manager.columns.name_${level}`))}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {sortHeader('status', t('manager.columns.status'))}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {sortHeader('budget', t('manager.columns.budget'))}
            </th>
            {order.map((c) => (
              <th
                key={c}
                scope="col"
                data-testid={`facebook-col-${c}`}
                draggable={!coarse}
                onDragStart={(e) => {
                  setDragging(c)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', c)
                }}
                onDragOver={(e) => {
                  if (dragging) e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const from = (dragging ?? e.dataTransfer.getData('text/plain')) as MetricColumn
                  if ((METRIC_COLUMNS as readonly string[]).includes(from)) onDrop(from, c)
                  setDragging(null)
                }}
                onDragEnd={() => setDragging(null)}
                className={cn('px-3 py-2 text-right font-medium whitespace-nowrap', !coarse && 'cursor-grab', dragging === c && 'opacity-50')}
              >
                <span className="inline-flex items-center gap-1">
                  {!coarse ? <GripVertical className="size-3 opacity-50" aria-hidden /> : null}
                  {sortHeader(c, columnLabel(t, c))}
                </span>
              </th>
            ))}
            <th scope="col" className="w-12 px-3 py-2">
              <span className="sr-only">{t('common.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.id} data-testid={`facebook-item-${r.id}`} className="align-top hover:bg-muted/30">
              <td className="max-w-72 px-3 py-2">
                <NameCell row={r} level={level} />
              </td>
              <td className="px-3 py-2">
                <StatusCell row={r} pending={pendingId === r.id} disabled={pendingId !== null} onToggle={() => onToggle(r)} />
              </td>
              <td data-testid={`facebook-item-budget-${r.id}`} className="px-3 py-2">
                <BudgetCell row={r} currency={currency} locale={locale} />
              </td>
              {order.map((c) => (
                <td key={c} data-testid={`facebook-item-${c}-${r.id}`} className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                  {formatCell(c, cellValue(r, c), currency, locale)}
                </td>
              ))}
              <td className="px-3 py-1">
                <EditButton row={r} disabled={pendingId !== null} onEdit={() => onEdit(r)} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t bg-muted/40 font-medium">
          <tr data-testid="facebook-totals">
            <td className="px-3 py-2" colSpan={3}>
              {t('manager.totals')}
            </td>
            {order.map((c) => (
              <td key={c} data-testid={`facebook-total-${c}`} className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                {formatCell(c, total[c], currency, locale)}
              </td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function ManagerCards({ rows, level, order, currency, locale, pendingId, onToggle, onEdit }: RowsProps) {
  const t = useT(NS)
  return (
    <ul data-testid="facebook-cards" className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.id} data-testid={`facebook-item-${r.id}`} className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3">
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <NameCell row={r} level={level} />
            </div>
            <EditButton row={r} disabled={pendingId !== null} onEdit={() => onEdit(r)} />
          </div>
          <StatusCell row={r} pending={pendingId === r.id} disabled={pendingId !== null} onToggle={() => onToggle(r)} />
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('manager.columns.budget')}</dt>
            <dd data-testid={`facebook-item-budget-${r.id}`} className="min-w-0">
              <BudgetCell row={r} currency={currency} locale={locale} />
            </dd>
            {order.map((c) => (
              <div key={c} className="contents">
                <dt className="text-muted-foreground">{columnLabel(t, c)}</dt>
                <dd data-testid={`facebook-item-${c}-${r.id}`} className="min-w-0 tabular-nums break-words">
                  {formatCell(c, cellValue(r, c), currency, locale)}
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------- modal de edição (11 §5.3)

function EditDialog({ row, level, onClose, onSaved }: { row: BundleRow; level: BundleLevel; onClose: () => void; onSaved: () => void }) {
  const t = useT(NS)
  const modes = editModes(row, level)
  const [mode, setMode] = useState<EditMode>(modes[0] ?? 'name')
  const [name, setName] = useState(row.name)
  const [daily, setDaily] = useState(budgetInitial(row.daily_budget))
  const [lifetime, setLifetime] = useState(budgetInitial(row.lifetime_budget))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const submit = async () => {
    const r = editPatch(row, level, mode, { name, daily, lifetime })
    if (!r.ok) {
      setError(t(`manager.edit.errors.${r.error}`))
      return
    }
    setPending(true)
    setError(null)
    try {
      const res = await patchEntity(row.id, r.body)
      if (!res?.success) throw new Error('not_success')
      onSaved()
      onClose()
    } catch (err) {
      setError(serverMessage(err) ?? t('manager.updateError'))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="facebook-edit-dialog"
          className="fixed top-1/2 left-1/2 z-[70] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background shadow-xl outline-none"
        >
          <form
            noValidate
            className="flex flex-col"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Dialog.Title className="border-b px-5 py-4 text-lg font-semibold">{t('manager.edit.title', { name: row.name })}</Dialog.Title>
            <div className="flex flex-col gap-4 px-5 py-4">
              {modes.length === 0 ? (
                <p data-testid="facebook-edit-ad-hint" className="text-sm text-muted-foreground">
                  {t('manager.edit.adHint')}
                </p>
              ) : (
                <>
                  {modes.length > 1 ? (
                    <div role="tablist" className="flex gap-1 rounded-lg bg-muted p-1">
                      {modes.map((m) => (
                        <button
                          key={m}
                          type="button"
                          role="tab"
                          aria-selected={m === mode}
                          data-testid={`facebook-edit-mode-${m}`}
                          className={cn('flex-1 rounded-md px-3 py-1.5 text-sm', m === mode ? 'bg-background shadow-sm' : 'text-muted-foreground')}
                          onClick={() => {
                            setMode(m)
                            setError(null)
                          }}
                        >
                          {t(`manager.edit.mode.${m}`)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {mode === 'name' ? (
                    <label className="flex flex-col gap-1.5 text-sm font-medium">
                      {t('manager.edit.name')}
                      <input data-testid="facebook-edit-name" className={inputClass} value={name} maxLength={1000} onChange={(e) => setName(e.target.value)} />
                      <span className="text-xs font-normal text-muted-foreground">{t('manager.edit.nameHint')}</span>
                    </label>
                  ) : (
                    <>
                      <label className="flex flex-col gap-1.5 text-sm font-medium">
                        {t('manager.edit.daily', { currency: row.currency ?? '' })}
                        <input data-testid="facebook-edit-daily" className={inputClass} inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
                      </label>
                      <label className="flex flex-col gap-1.5 text-sm font-medium">
                        {t('manager.edit.lifetime', { currency: row.currency ?? '' })}
                        <input data-testid="facebook-edit-lifetime" className={inputClass} inputMode="decimal" value={lifetime} onChange={(e) => setLifetime(e.target.value)} />
                      </label>
                      <span className="text-xs text-muted-foreground">{t('manager.edit.budgetHint')}</span>
                    </>
                  )}
                </>
              )}
              {error ? (
                <p data-testid="facebook-edit-error" role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <Button variant="outline" data-testid="facebook-edit-cancel" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" data-testid="facebook-edit-save" disabled={pending || modes.length === 0}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
