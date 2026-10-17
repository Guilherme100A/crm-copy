// Chip "Créditos de IA" da sidebar (AC-T59-01; 12 §2 adaptado: sem compra nem modal de tokens): saldo formatado,
// destaque baixo/esgotado e atalho para `/settings?tab=ai_usage`. Atualiza com `ai_wallet.updated` e ao focar a janela.
// O shell importa este módulo de forma eager: o handler realtime abaixo precisa estar registrado antes de o SSE abrir.
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { useEffect } from 'react'
import { useI18n, useT } from '@/i18n'
import { onRealtime } from '@/lib/realtime'
import { hasAny, type Session } from '@/lib/session'
import { cn } from '@/lib/utils'
import { walletKey, walletQuery, type WalletDto } from './api'
import { applyWalletEvent, formatCredits, walletTone, type WalletEventData } from './format'

export const AI_USAGE_PERMS = ['ai_usage.view'] as const

onRealtime('ai_wallet.updated', (e, qc) => {
  qc.setQueryData<WalletDto>(walletKey(e.company_id), (prev) => applyWalletEvent(prev, e.data as WalletEventData))
})
// Aviso de saldo/cota: relê a carteira (o evento traz só parte dos campos).
onRealtime('ai_wallet.low', (e, qc) => void qc.invalidateQueries({ queryKey: walletKey(e.company_id) }))

const TONE_CLASS = {
  ok: 'border-border bg-background/60',
  low: 'border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  exhausted: 'border-destructive/60 bg-destructive/10 text-destructive',
} as const

export function WalletChip({ session, collapsed = false }: { session: Session; collapsed?: boolean }) {
  const t = useT('settings-ai-usage')
  const { locale } = useI18n()
  const allowed = !!session.company && hasAny(session, AI_USAGE_PERMS)
  const q = useQuery({ ...walletQuery(session.company?.id), enabled: allowed })
  const { refetch } = q

  // O focusManager do TanStack Query só ouve `visibilitychange`; o foco da janela também atualiza (12 §3.10).
  useEffect(() => {
    if (!allowed) return
    const onFocus = () => void refetch()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [allowed, refetch])

  if (!allowed) return null
  const w = q.data
  const tone = w ? walletTone(w) : 'ok'
  const balance = w ? formatCredits(w.balance_credits, locale) : '—'
  const label = t('chip.label')
  const statusText = tone === 'ok' ? '' : t(`chip.status.${tone}`)

  return (
    <Link
      to={'/settings' as never}
      search={{ tab: 'ai_usage' } as never}
      data-testid="ai-wallet-chip"
      data-status={w ? tone : 'loading'}
      title={`${label}: ${balance}${statusText ? ` · ${statusText}` : ''}`}
      aria-label={`${label}: ${balance}${statusText ? `, ${statusText}` : ''}`}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors hover:bg-accent',
        TONE_CLASS[tone],
        collapsed && 'flex-col justify-center gap-0.5 px-1 py-1.5',
      )}
    >
      <Sparkles className="size-4 shrink-0" aria-hidden />
      {collapsed ? (
        <span data-testid="ai-wallet-chip-balance" className="text-[10px] font-semibold tabular-nums">
          {balance}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-xs text-muted-foreground">{label}</span>
          <span className="flex items-baseline gap-1.5">
            <span data-testid="ai-wallet-chip-balance" className="font-semibold tabular-nums">
              {balance}
            </span>
            {statusText ? (
              <span data-testid="ai-wallet-chip-status" className="truncate text-xs font-medium">
                {statusText}
              </span>
            ) : null}
          </span>
        </span>
      )}
    </Link>
  )
}
