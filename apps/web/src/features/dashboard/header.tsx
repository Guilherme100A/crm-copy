// Cabeçalho do dashboard (02 §2 e §5.1–5.3; 15 §2): saudação pelo horário no fuso da empresa, "Operação {empresa} •
// {N} leads acumulados" e a pílula do marco de faturamento, que abre o modal de progresso da trilha.
import { Dialog } from '@base-ui/react/dialog'
import { Award, Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { Bootstrap, MilestoneResult } from './api'
import { formatInt, formatMoney } from './format'
import { displayName, greetingKey, hourIn } from './search'

/** Re-renderiza a cada minuto (a saudação muda ao virar a hora). */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function DashboardHeader({
  user,
  companyName,
  tz,
  bootstrap,
}: {
  user: { name?: string | null; email?: string | null }
  companyName: string
  tz: string
  bootstrap: Bootstrap | undefined
}) {
  const t = useT('dashboard')
  const now = useNow()
  const [open, setOpen] = useState(false)
  const milestone = bootstrap?.lifetime_revenue?.milestone
  return (
    <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 data-testid="dashboard-greeting" className="text-2xl font-semibold break-words">
          {t(`greeting.${greetingKey(hourIn(tz, now))}`, { name: displayName(user) })}
        </h1>
        <p data-testid="dashboard-subline" className="text-sm text-muted-foreground">
          {t('subline', { company: companyName, n: formatInt(bootstrap?.leads_count ?? 0) })}
        </p>
      </div>
      {milestone ? (
        <>
          <button
            type="button"
            data-testid="dashboard-milestone"
            data-level={milestone.level}
            onClick={() => setOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-sm font-medium text-amber-800 outline-none hover:bg-amber-500/20 focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-300"
          >
            <Award className="size-4" aria-hidden />
            {milestone.current?.name ?? t('milestone.none')}
          </button>
          <MilestoneModal open={open} onClose={() => setOpen(false)} milestone={milestone} />
        </>
      ) : null}
    </header>
  )
}

const LEVELS = [1, 2, 3, 4, 5, 6] as const

function MilestoneModal({ open, onClose, milestone }: { open: boolean; onClose: () => void; milestone: MilestoneResult }) {
  const t = useT('dashboard')
  const progress = Math.max(0, Math.min(100, Math.round(milestone.progress_pct)))
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="dashboard-milestone-modal"
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[90dvh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{t('milestone.title')}</Dialog.Title>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">{t('milestone.current')}</p>
              <p data-testid="dashboard-milestone-current" className="font-semibold">
                {milestone.current?.name ?? t('milestone.none')}
              </p>
            </div>
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">{t('milestone.next')}</p>
              <p data-testid="dashboard-milestone-next" className="font-semibold">
                {milestone.next?.name ?? t('milestone.maxReached')}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t('milestone.progress')}</span>
              <span data-testid="dashboard-milestone-progress" data-progress={progress} className="font-semibold tabular-nums">
                {progress}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
              <span className="block h-full rounded-full bg-amber-500" style={{ width: `${progress}%` }} />
            </div>
            <p data-testid="dashboard-milestone-remaining" className="text-xs text-muted-foreground">
              {milestone.next ? t('milestone.remaining', { amount: formatMoney(milestone.remaining_cents), name: milestone.next.name }) : t('milestone.maxReached')}
            </p>
          </div>
          <ol className="flex flex-col gap-1.5">
            {LEVELS.map((level) => {
              const reached = milestone.level >= level
              const name = level === milestone.current?.level ? milestone.current.name : level === milestone.next?.level ? milestone.next.name : t(`milestone.levels.${level}`)
              return (
                <li
                  key={level}
                  data-testid={`dashboard-milestone-level-${level}`}
                  data-reached={reached ? 'true' : 'false'}
                  className={cn('flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm', reached ? 'border-amber-500/40 bg-amber-500/10' : 'opacity-70')}
                >
                  <span className={cn('flex size-5 items-center justify-center rounded-full text-[11px] font-bold', reached ? 'bg-amber-500 text-white' : 'bg-muted')}>
                    {reached ? <Check className="size-3" aria-hidden /> : level}
                  </span>
                  <span className="flex-1">{name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{t(`milestone.thresholds.${level}`)}</span>
                </li>
              )
            })}
          </ol>
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
