// Aba `/settings?tab=ai_usage` (AC-T59-02; 12 §3.10 adaptado, sem compra): cards (saldo, uso no período, última
// recarga), gráfico de créditos por dia ou por feature, extrato filtrável com "carregar mais" (cursor) e cotas com
// barra de progresso (o uso vem do resumo desde o início do dia/mês no fuso da empresa). Sem nenhum uso: estado vazio.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { useI18n, useT } from '@/i18n'
import { profileQuery, sessionFrom } from '@/lib/session'
import { cn } from '@/lib/utils'
import {
  anyUsageQuery,
  quotasQuery,
  summaryQuery,
  usageInfiniteQuery,
  walletQuery,
  type QuotaDto,
  type SummaryGroup,
  type UsageDto,
  type UsageFilters,
  type UsageStatus,
} from './api'
import { formatCredits, formatMicros, PERIODS, periodRange, quotaBars, startOfPeriod, sumSummary, walletTone, type Period } from './format'

const NS = 'settings-ai-usage'
const selectCls = 'h-9 min-w-0 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'
const STATUSES: UsageStatus[] = ['charged', 'refunded', 'error']
const BAR = 'var(--color-primary, #2563eb)'

/** Rótulo da feature: tradução conhecida ou o próprio código; sem feature = "Outros". */
function useFeatureLabel() {
  const t = useT(NS)
  return (key: string | null) => {
    if (!key) return t('features.none')
    const label = t(`features.${key}`)
    return label === `features.${key}` ? key : label
  }
}

export default function AiUsageTab() {
  const t = useT(NS)
  const { locale } = useI18n()
  const profile = useQuery(profileQuery()).data
  const companyId = (profile ? sessionFrom(profile).company?.id : null) ?? ''
  const [period, setPeriod] = useState<Period>('30d')
  // O período fica fixo enquanto a aba está aberta (a chave da query não muda a cada render).
  const range = useMemo(() => periodRange(period), [period])

  const wallet = useQuery({ ...walletQuery(companyId), enabled: !!companyId })
  const any = useQuery({ ...anyUsageQuery(companyId), enabled: !!companyId })
  const periodSummary = useQuery(summaryQuery(companyId, 'feature', range, !!companyId))
  const totals = sumSummary(periodSummary.data?.items)

  return (
    <section data-testid="ai-usage" className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('period.label')}</span>
          <select data-testid="ai-usage-period" value={period} onChange={(e) => setPeriod(e.target.value as Period)} className={selectCls}>
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {t(`period.${p}`)}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card testid="ai-usage-card-balance" label={t('cards.balance')}>
          {wallet.data ? (
            <>
              <p
                data-testid="ai-usage-balance"
                data-status={walletTone(wallet.data)}
                className={cn(
                  'text-2xl font-semibold tabular-nums',
                  walletTone(wallet.data) === 'low' && 'text-amber-700 dark:text-amber-300',
                  walletTone(wallet.data) === 'exhausted' && 'text-destructive',
                )}
              >
                {formatCredits(wallet.data.balance_credits, locale)}
              </p>
              <p className="text-xs text-muted-foreground">
                {walletTone(wallet.data) === 'ok' ? t('cards.balanceHint') : t(`chip.status.${walletTone(wallet.data)}`)}
              </p>
            </>
          ) : (
            <Placeholder failed={wallet.isError} />
          )}
        </Card>
        <Card testid="ai-usage-card-period" label={t('cards.period', { period: t(`period.${period}`) })}>
          {periodSummary.data ? (
            <>
              <p data-testid="ai-usage-period-credits" className="text-2xl font-semibold tabular-nums">
                {formatCredits(totals.credits, locale)}
              </p>
              <p data-testid="ai-usage-period-detail" className="text-xs text-muted-foreground">
                {t('cards.periodDetail', { count: totals.count.toLocaleString(locale), cost: formatMicros(totals.cost_micros, locale) })}
              </p>
            </>
          ) : (
            <Placeholder failed={periodSummary.isError} />
          )}
        </Card>
        <Card testid="ai-usage-card-last-topup" label={t('cards.lastTopup')}>
          {wallet.data ? (
            wallet.data.last_topup ? (
              <>
                <p data-testid="ai-usage-last-topup" className="text-2xl font-semibold tabular-nums">
                  +{formatCredits(wallet.data.last_topup.amount_credits, locale)}
                </p>
                <p data-testid="ai-usage-last-topup-date" className="text-xs text-muted-foreground">
                  {new Date(wallet.data.last_topup.created_at).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}
                </p>
              </>
            ) : (
              <p data-testid="ai-usage-last-topup-none" className="text-sm text-muted-foreground">
                {t('cards.noTopup')}
              </p>
            )
          ) : (
            <Placeholder failed={wallet.isError} />
          )}
        </Card>
      </div>

      {any.isPending ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : any.isError ? (
        <p className="text-sm text-destructive">{t('error')}</p>
      ) : !any.data ? (
        <p data-testid="ai-usage-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <>
          <UsageChart companyId={companyId} range={range} />
          <UsageStatement companyId={companyId} range={range} />
        </>
      )}

      <Quotas companyId={companyId} />
    </section>
  )
}

function Card({ testid, label, children }: { testid: string; label: string; children: ReactNode }) {
  return (
    <div data-testid={testid} className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-4">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}

function Placeholder({ failed }: { failed: boolean }) {
  const t = useT(NS)
  return failed ? <p className="text-sm text-destructive">{t('error')}</p> : <div className="h-8 w-24 animate-pulse rounded bg-muted" />
}

function UsageChart({ companyId, range }: { companyId: string; range: { from: string; to: string } }) {
  const t = useT(NS)
  const { locale } = useI18n()
  const featureLabel = useFeatureLabel()
  const [group, setGroup] = useState<Extract<SummaryGroup, 'day' | 'feature'>>('day')
  const q = useQuery(summaryQuery(companyId, group, range, !!companyId))
  const rows = (q.data?.items ?? []).map((i) => ({
    label: group === 'feature' ? featureLabel(i.key) : (i.key ?? ''),
    credits: i.credits,
    count: i.count,
  }))

  return (
    <div data-testid="ai-usage-chart" data-group={group} className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-sm font-medium">{t('chart.title')}</h3>
        <div role="group" aria-label={t('chart.groupBy')} className="inline-flex rounded-md border p-0.5">
          {(['day', 'feature'] as const).map((g) => (
            <button
              key={g}
              type="button"
              data-testid={`ai-usage-chart-group-${g}`}
              aria-pressed={group === g}
              onClick={() => setGroup(g)}
              className={cn('rounded px-2.5 py-1 text-xs', group === g ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60')}
            >
              {t(`chart.${g}`)}
            </button>
          ))}
        </div>
      </div>
      {q.isPending ? (
        <div className="h-56 animate-pulse rounded bg-muted" />
      ) : rows.length === 0 ? (
        <p data-testid="ai-usage-chart-empty" className="py-10 text-center text-sm text-muted-foreground">
          {t('chart.empty')}
        </p>
      ) : (
        <div className="h-56 w-full" data-testid="ai-usage-chart-bars" data-count={rows.length}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.4} />
              <XAxis dataKey="label" fontSize={11} interval="preserveStartEnd" />
              <YAxis width={56} fontSize={11} tickFormatter={(v: number) => formatCredits(v, locale)} />
              <Tooltip formatter={(v) => [formatCredits(Number(v), locale), t('chart.credits')]} />
              <Bar dataKey="credits" name={t('chart.credits')} fill={BAR} radius={3} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function UsageStatement({ companyId, range }: { companyId: string; range: { from: string; to: string } }) {
  const t = useT(NS)
  const { locale } = useI18n()
  const featureLabel = useFeatureLabel()
  const [feature, setFeature] = useState('')
  const [provider, setProvider] = useState('')
  const [status, setStatus] = useState<UsageStatus | ''>('')
  // Opções dos filtros a partir do resumo do período (só valores que existem).
  const features = useQuery(summaryQuery(companyId, 'feature', range, !!companyId)).data?.items ?? []
  const models = useQuery(summaryQuery(companyId, 'model', range, !!companyId)).data?.items ?? []
  const providers = [...new Set(models.map((m) => (m.key ?? '').split('/')[0]!).filter(Boolean))].sort()
  const filters: UsageFilters = { ...range, ...(feature ? { feature } : {}), ...(provider ? { provider } : {}), ...(status ? { status } : {}) }
  const q = useInfiniteQuery({ ...usageInfiniteQuery(companyId, filters), enabled: !!companyId })
  const items = q.data?.pages.flatMap((p) => p.items) ?? []
  const fmtDate = (iso: string) => new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

  return (
    <div data-testid="ai-usage-statement" className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <h3 className="text-sm font-medium">{t('statement.title')}</h3>
      <div className="flex flex-wrap gap-2">
        <select data-testid="ai-usage-filter-feature" aria-label={t('statement.feature')} value={feature} onChange={(e) => setFeature(e.target.value)} className={selectCls}>
          <option value="">{t('statement.allFeatures')}</option>
          {features
            .filter((f) => f.key)
            .map((f) => (
              <option key={f.key} value={f.key!}>
                {featureLabel(f.key)}
              </option>
            ))}
          {feature && !features.some((f) => f.key === feature) ? <option value={feature}>{featureLabel(feature)}</option> : null}
        </select>
        <select data-testid="ai-usage-filter-provider" aria-label={t('statement.provider')} value={provider} onChange={(e) => setProvider(e.target.value)} className={selectCls}>
          <option value="">{t('statement.allProviders')}</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          {provider && !providers.includes(provider) ? <option value={provider}>{provider}</option> : null}
        </select>
        <select data-testid="ai-usage-filter-status" aria-label={t('statement.status')} value={status} onChange={(e) => setStatus(e.target.value as UsageStatus | '')} className={selectCls}>
          <option value="">{t('statement.allStatuses')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
      </div>

      {q.isPending ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : q.isError ? (
        <p className="text-sm text-destructive">{t('error')}</p>
      ) : items.length === 0 ? (
        <p data-testid="ai-usage-list-empty" className="py-6 text-center text-sm text-muted-foreground">
          {t('statement.empty')}
        </p>
      ) : (
        <ul data-testid="ai-usage-list" className="flex flex-col divide-y text-sm">
          {items.map((u: UsageDto) => (
            <li key={u.id} data-testid={`ai-usage-item-${u.id}`} data-status={u.status} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)_6rem_6rem] sm:items-center">
              <span className="text-xs text-muted-foreground tabular-nums sm:text-sm">{fmtDate(u.created_at)}</span>
              <span data-testid={`ai-usage-item-feature-${u.id}`} className="truncate sm:order-none">
                {featureLabel(u.feature)}
              </span>
              <span data-testid={`ai-usage-item-model-${u.id}`} className="truncate text-xs text-muted-foreground sm:text-sm">
                {u.provider}/{u.model} · {t('statement.tokens', { n: (u.input_tokens + u.output_tokens).toLocaleString(locale) })}
              </span>
              <span
                data-testid={`ai-usage-item-status-${u.id}`}
                className={cn(
                  'justify-self-end rounded-full px-2 py-0.5 text-xs font-medium sm:justify-self-start',
                  u.status === 'charged' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
                  u.status === 'refunded' && 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
                  u.status === 'error' && 'bg-destructive/10 text-destructive',
                )}
              >
                {t(`status.${u.status}`)}
              </span>
              <span data-testid={`ai-usage-item-credits-${u.id}`} className="justify-self-end font-medium tabular-nums">
                {formatCredits(u.credits, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage ? (
        <Button variant="outline" size="sm" data-testid="ai-usage-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} className="self-center">
          {t('statement.more')}
        </Button>
      ) : null}
    </div>
  )
}

function Quotas({ companyId }: { companyId: string }) {
  const t = useT(NS)
  const q = useQuery({ ...quotasQuery(companyId), enabled: !!companyId })
  // O fuso da empresa vem no próprio resumo (sem filtro de data: barato e cacheado por chave).
  const tz = useQuery(summaryQuery(companyId, 'feature', {}, !!companyId && !!q.data?.length)).data?.time_zone
  const quotas = q.data ?? []

  return (
    <div data-testid="ai-usage-quotas" className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <h3 className="text-sm font-medium">{t('quotas.title')}</h3>
      {q.isPending ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : q.isError ? (
        <p className="text-sm text-destructive">{t('error')}</p>
      ) : quotas.length === 0 ? (
        <p data-testid="ai-usage-quotas-empty" className="text-sm text-muted-foreground">
          {t('quotas.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {quotas.map((quota) => (
            <QuotaRow key={quota.period} companyId={companyId} quota={quota} timeZone={tz} />
          ))}
        </ul>
      )}
    </div>
  )
}

function QuotaRow({ companyId, quota, timeZone }: { companyId: string; quota: QuotaDto; timeZone: string | undefined }) {
  const t = useT(NS)
  const { locale } = useI18n()
  const from = useMemo(() => (timeZone ? startOfPeriod(quota.period, timeZone) : undefined), [quota.period, timeZone])
  const used = useQuery(summaryQuery(companyId, 'feature', { from }, !!from))
  const bars = quotaBars(quota, sumSummary(used.data?.items))
  const fmt = (metric: string, v: number) =>
    metric === 'cost' ? formatMicros(v, locale) : metric === 'tokens' ? v.toLocaleString(locale) : formatCredits(v, locale)

  return (
    <li data-testid={`ai-usage-quota-${quota.period}`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{t(`quotas.period.${quota.period}`)}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{quota.hard ? t('quotas.hard') : t('quotas.soft')}</span>
      </div>
      {bars.length === 0 ? <p className="text-xs text-muted-foreground">{t('quotas.noLimits')}</p> : null}
      {bars.map((b) => (
        <div key={b.metric} className="flex flex-col gap-1">
          <div className="flex justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{t(`quotas.metric.${b.metric}`)}</span>
            <span data-testid={`ai-usage-quota-${quota.period}-${b.metric}-text`} className="tabular-nums">
              {used.data ? `${fmt(b.metric, b.used)} / ${fmt(b.metric, b.max)}` : `… / ${fmt(b.metric, b.max)}`}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={`${t(`quotas.period.${quota.period}`)} · ${t(`quotas.metric.${b.metric}`)}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(b.pct)}
            data-testid={`ai-usage-quota-${quota.period}-${b.metric}`}
            data-pct={Math.round(b.pct)}
            data-over={b.over ? 'true' : 'false'}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn('h-full rounded-full transition-[width]', b.over ? 'bg-destructive' : b.pct >= 80 ? 'bg-amber-500' : 'bg-primary')}
              style={{ width: `${b.pct}%` }}
            />
          </div>
        </div>
      ))}
    </li>
  )
}
