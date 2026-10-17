// Banner "revise antes de publicar" (07 §2: a criação assistida abre o agente com `state.review`; AC-T92-02). Lê o
// `history.state` gravado pela criação assistida; "Entendi" tira a marca do estado (sem search param).
import { useRouter, useRouterState, type HistoryState } from '@tanstack/react-router'
import { AlertTriangle, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { REVIEW_STATE_KEY, reviewStateOf, warningKey } from './lab'

export function ReviewBanner() {
  const t = useT('agent-lab')
  const router = useRouter()
  const state = useRouterState({ select: (s) => s.location.state })
  const review = reviewStateOf(state)
  if (!review) return null

  const dismiss = () => {
    const { [REVIEW_STATE_KEY]: _drop, ...rest } = (router.state.location.state ?? {}) as unknown as Record<string, unknown>
    router.history.replace(router.state.location.href, rest as HistoryState)
  }

  return (
    <div
      data-testid="agent-lab-review-banner"
      role="status"
      className="flex min-w-0 items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <Sparkles className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t('review.title')}</p>
        <p className="text-muted-foreground">{t('review.body')}</p>
        {review.warnings.length ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {review.warnings.map((w) => (
              <li key={w} data-testid={`agent-lab-review-warning-${w}`} className="flex items-start gap-1 text-xs">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden /> {t(`assisted.warnings.${warningKey(w)}`)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Button variant="ghost" size="icon" data-testid="agent-lab-review-dismiss" aria-label={t('review.dismiss')} onClick={dismiss}>
        <X aria-hidden />
      </Button>
    </div>
  )
}
