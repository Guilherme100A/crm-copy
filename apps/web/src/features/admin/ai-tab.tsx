// Aba IA (20 §3.9; AC-T100-04): uso por empresa × provedor × modelo no período e carteiras de créditos, com
// "atualizado às HH:MM" (última leitura) e Atualizar; recarga/ajuste por empresa com nota obrigatória e confirmação.
import { useQuery } from '@tanstack/react-query'
import { Coins } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { inputClass } from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { adminAiUsageQuery, adminAiWalletsQuery } from './api'
import { CreditsDialog, type CreditsTarget } from './credits-dialog'
import { localInputToIso } from './rules'
import { fmtNumber, NS, ReadOnlyHeader } from './ui'

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Período padrão: últimos 30 dias (inclui hoje). */
function defaultRange() {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 29)
  return { from: day(start), to: day(end) }
}

/** Datas (dia local) → `[from 00:00, to+1 00:00)` em ISO. */
function rangeIso(from: string, to: string): { from: string | null; to: string | null } {
  const f = from ? localInputToIso(`${from}T00:00`) : null
  let t: string | null = null
  if (to) {
    const d = new Date(`${to}T00:00`)
    if (!Number.isNaN(d.getTime())) {
      d.setDate(d.getDate() + 1)
      t = d.toISOString()
    }
  }
  return { from: f, to: t }
}

const usd = (micros: number, locale: string) =>
  (micros / 1_000_000).toLocaleString(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })

export function AiTab() {
  const t = useT(NS)
  const { locale } = useI18n()
  const [range, setRange] = useState(defaultRange)
  const iso = useMemo(() => rangeIso(range.from, range.to), [range])
  const usage = useQuery(adminAiUsageQuery(iso.from, iso.to))
  const wallets = useQuery(adminAiWalletsQuery())
  const [credits, setCredits] = useState<CreditsTarget | null>(null)
  const updatedAt = Math.max(usage.dataUpdatedAt, wallets.dataUpdatedAt) || null

  return (
    <div data-testid="admin-panel-ai" className="flex flex-col gap-4">
      <ReadOnlyHeader
        prefix="ai"
        title={t('tabs.ai')}
        subtitle={t('ai.subtitle')}
        readOnly={false}
        updatedAt={updatedAt}
        refreshing={usage.isFetching || wallets.isFetching}
        onRefresh={() => {
          void usage.refetch()
          void wallets.refetch()
        }}
      />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <h3 className="mr-auto font-medium">{t('ai.usage')}</h3>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('ai.from')}
            <input type="date" data-testid="admin-ai-from" className={inputClass} value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('ai.to')}
            <input type="date" data-testid="admin-ai-to" className={inputClass} value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
          </label>
        </div>
        {usage.isPending ? (
          <div className="h-24 animate-pulse rounded-lg bg-muted" />
        ) : usage.isError ? (
          <p data-testid="admin-ai-usage-error" className="text-sm text-destructive">
            {t('common.error')}
          </p>
        ) : usage.data.items.length === 0 ? (
          <p data-testid="admin-ai-usage-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('ai.usageEmpty')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table data-testid="admin-ai-usage" className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground uppercase">
                <tr>
                  {['company', 'provider', 'model', 'count', 'tokens', 'cost', 'credits'].map((c) => (
                    <th key={c} scope="col" className="px-3 py-2 font-medium">
                      {t(`ai.col.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {usage.data.items.map((i) => (
                  <tr key={`${i.company_id}:${i.provider}:${i.model}`}>
                    <td className="px-3 py-2">{i.company_name}</td>
                    <td className="px-3 py-2">{i.provider}</td>
                    <td className="px-3 py-2 font-mono text-xs">{i.model}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtNumber(i.count, locale)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtNumber(i.input_tokens + i.output_tokens, locale)}</td>
                    <td className="px-3 py-2 tabular-nums">{usd(i.cost_micros, locale)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtNumber(i.credits, locale)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t font-medium">
                <tr data-testid="admin-ai-usage-totals">
                  <td className="px-3 py-2" colSpan={3}>
                    {t('ai.totals')}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{fmtNumber(usage.data.totals.count, locale)}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtNumber(usage.data.totals.input_tokens + usage.data.totals.output_tokens, locale)}</td>
                  <td className="px-3 py-2 tabular-nums">{usd(usage.data.totals.cost_micros, locale)}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtNumber(usage.data.totals.credits, locale)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="font-medium">{t('ai.wallets')}</h3>
          <p className="text-sm text-muted-foreground">{t('ai.walletsHint')}</p>
        </div>
        {wallets.isPending ? (
          <div className="h-24 animate-pulse rounded-lg bg-muted" />
        ) : wallets.isError ? (
          <p className="text-sm text-destructive">{t('common.error')}</p>
        ) : wallets.data.length === 0 ? (
          <p data-testid="admin-ai-wallets-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('ai.walletsEmpty')}
          </p>
        ) : (
          <ul data-testid="admin-ai-wallets" className="flex flex-col divide-y rounded-xl border bg-card">
            {wallets.data.map((w) => (
              <li key={w.company_id} data-testid={`admin-ai-item-${w.company_id}`} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{w.company_name}</span>
                <span data-testid={`admin-ai-item-balance-${w.company_id}`} className={w.balance_credits < 0 ? 'text-destructive tabular-nums' : 'tabular-nums'}>
                  {t('ai.balance', { credits: fmtNumber(w.balance_credits, locale) })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={`admin-ai-item-topup-${w.company_id}`}
                  onClick={() => setCredits({ companyId: w.company_id, companyName: w.company_name, mode: 'topup' })}
                >
                  <Coins aria-hidden /> {t('credits.topup')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`admin-ai-item-adjust-${w.company_id}`}
                  onClick={() => setCredits({ companyId: w.company_id, companyName: w.company_name, mode: 'adjust' })}
                >
                  {t('credits.adjust')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {credits ? <CreditsDialog target={credits} onClose={() => setCredits(null)} /> : null}
    </div>
  )
}
