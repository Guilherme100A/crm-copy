// "Criar com IA" (07 §5 item 4; AC-T92-02): pitch (com ditado) e link do site → estimativa contra o saldo → run
// extract → compose → persist. Os estágios e avisos chegam pelo SSE `ai_agent.run.updated` (realtime.ts) e, como
// rede de segurança, por polling de `GET /api/ai-agents/runs/:id` a cada 1,2 s (07 §7). Ao concluir, abre o agente
// com o banner "revise antes de publicar" (estado no `history.state`, sem search param).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, type HistoryState } from '@tanstack/react-router'
import { AlertTriangle, Check, Circle, Loader2, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { AGENTS_KEY } from '@/features/agents/api'
import { inputClass, ModalShell, textareaClass } from '@/features/agents/ui'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import { labApi, RUN_STAGES, runKey, runQuery, type RunEstimate } from './api'
import { DictationButton } from './dictation'
import {
  appendDictation,
  canSubmitRun,
  firstFieldMessage,
  formatCredits,
  isTerminal,
  labErrorKey,
  REVIEW_STATE_KEY,
  runErrorKey,
  runInput,
  stageState,
  warningKey,
  type ReviewState,
} from './lab'

export const RUN_POLL_MS = 1200
/** Tempo com o run concluído na tela (estágios e avisos) antes de abrir o agente. */
const OPEN_DELAY_MS = 1500

export function AssistedCreateButton() {
  const t = useT('agent-lab')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" data-testid="agent-lab-assisted-open" onClick={() => setOpen(true)}>
        <Sparkles aria-hidden /> {t('assisted.open')}
      </Button>
      {open ? <AssistedCreateDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function AssistedCreateDialog({ onClose }: { onClose: () => void }) {
  const t = useT('agent-lab')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [pitch, setPitch] = useState('')
  const [site, setSite] = useState('')
  const [estimate, setEstimate] = useState<RunEstimate | null>(null)
  const [busy, setBusy] = useState<'estimate' | 'start' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const runQ = useQuery({
    ...runQuery(runId ?? ''),
    enabled: !!runId,
    refetchInterval: (q) => (isTerminal(q.state.data) ? false : RUN_POLL_MS),
  })
  const run = runQ.data ?? null

  // Concluído: mostra os estágios feitos e os avisos por um instante e abre o agente com o banner de revisão.
  const openRef = useRef({ navigate, onClose })
  openRef.current = { navigate, onClose }
  const doneAgent = run?.status === 'completed' ? run.agent_id : null
  useEffect(() => {
    if (!run || !doneAgent) return
    void qc.invalidateQueries({ queryKey: [...AGENTS_KEY, 'list'] })
    const review: ReviewState = { runId: run.id, warnings: run.warnings }
    const timer = setTimeout(() => {
      openRef.current.onClose()
      void openRef.current.navigate({
        to: '/agentes/$agentId',
        params: { agentId: doneAgent },
        state: { [REVIEW_STATE_KEY]: review } as HistoryState,
      })
    }, OPEN_DELAY_MS)
    return () => clearTimeout(timer)
    // Dispara uma vez quando o run conclui (o resto vem do ref).
  }, [doneAgent, qc])

  const errorText = (err: unknown) => {
    const key = labErrorKey(err)
    const detail = key === 'validation' ? firstFieldMessage(err) : null
    return [t(`errors.${key}`), detail].filter(Boolean).join(' — ')
  }

  const doEstimate = async (): Promise<RunEstimate | null> => {
    setError(null)
    try {
      const est = await labApi.estimate(runInput(pitch, site))
      setEstimate(est)
      return est
    } catch (err) {
      setError(errorText(err))
      return null
    }
  }

  const start = async () => {
    setBusy('start')
    try {
      const est = await doEstimate()
      if (!est || !est.enough) return
      const created = await labApi.createRun(runInput(pitch, site))
      qc.setQueryData(runKey(created.id), created)
      setRunId(created.id)
    } catch (err) {
      // Já existe uma montagem em andamento: acompanha a que está rodando.
      const current = err instanceof HttpError ? (err.details as { run_id?: unknown } | undefined)?.run_id : undefined
      if (labErrorKey(err) === 'inProgress' && typeof current === 'string') setRunId(current)
      else setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const running = !!run && !isTerminal(run)
  const valid = canSubmitRun(pitch, site)

  return (
    <ModalShell open onClose={() => !running && onClose()} testId="agent-lab-assisted-dialog" title={t('assisted.title')}>
      <p className="text-sm text-muted-foreground">{t('assisted.hint')}</p>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="agent-lab-pitch" className="text-sm font-medium">
            {t('assisted.pitch')}
          </label>
          <DictationButton
            testId="agent-lab-dictate-pitch"
            disabled={!!run}
            onText={(text) => setPitch((p) => appendDictation(p, text).slice(0, 8000))}
          />
        </div>
        <textarea
          id="agent-lab-pitch"
          data-testid="agent-lab-assisted-pitch"
          rows={4}
          maxLength={8000}
          className={textareaClass}
          disabled={!!run}
          value={pitch}
          placeholder={t('assisted.pitchPlaceholder')}
          onChange={(e) => {
            setPitch(e.target.value)
            setEstimate(null)
          }}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="agent-lab-site" className="text-sm font-medium">
          {t('assisted.site')}
        </label>
        <input
          id="agent-lab-site"
          data-testid="agent-lab-assisted-site"
          type="url"
          inputMode="url"
          placeholder="https://"
          className={inputClass}
          disabled={!!run}
          value={site}
          onChange={(e) => {
            setSite(e.target.value)
            setEstimate(null)
          }}
        />
      </div>

      {estimate ? (
        <p
          data-testid="agent-lab-assisted-estimate"
          data-enough={estimate.enough}
          className={cn('rounded-lg border px-3 py-2 text-sm', !estimate.enough && 'border-destructive/40 text-destructive')}
        >
          {estimate.estimated_credits === null
            ? t('assisted.estimateUnknown', { available: formatCredits(estimate.available_credits) })
            : t('assisted.estimate', {
                credits: formatCredits(estimate.estimated_credits),
                available: formatCredits(estimate.available_credits),
              })}
          {!estimate.enough ? (
            <span data-testid="agent-lab-assisted-insufficient" className="block font-medium">
              {t('assisted.insufficient')}
            </span>
          ) : null}
        </p>
      ) : null}

      {run ? (
        <section data-testid="agent-lab-assisted-run" data-status={run.status} className="flex flex-col gap-2">
          <ol data-testid="agent-lab-assisted-stages" className="flex flex-col gap-1">
            {RUN_STAGES.map((s) => {
              const st = stageState(run, s)
              return (
                <li
                  key={s}
                  data-testid={`agent-lab-assisted-stage-${s}`}
                  data-state={st}
                  className={cn(
                    'flex items-center gap-2 text-sm',
                    st === 'pending' && 'text-muted-foreground',
                    st === 'failed' && 'text-destructive',
                  )}
                >
                  {st === 'done' ? (
                    <Check className="size-4 text-emerald-600" aria-hidden />
                  ) : st === 'active' ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : st === 'failed' ? (
                    <X className="size-4" aria-hidden />
                  ) : (
                    <Circle className="size-4" aria-hidden />
                  )}
                  {t(`assisted.stages.${s}`)}
                </li>
              )
            })}
          </ol>
          {run.warnings.length ? (
            <ul data-testid="agent-lab-assisted-warnings" className="flex flex-col gap-1">
              {run.warnings.map((w) => (
                <li
                  key={w}
                  data-testid={`agent-lab-assisted-warning-${w}`}
                  className="flex items-start gap-2 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300"
                >
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden /> {t(`assisted.warnings.${warningKey(w)}`)}
                </li>
              ))}
            </ul>
          ) : null}
          {run.status === 'failed' ? (
            <p data-testid="agent-lab-assisted-error" role="alert" className="text-sm text-destructive">
              {t(`assisted.runErrors.${runErrorKey(run.error_message)}`)}
            </p>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <p data-testid="agent-lab-assisted-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" data-testid="agent-lab-assisted-cancel" disabled={running} onClick={onClose}>
          {run?.status === 'failed' ? t('assisted.close') : t('assisted.cancel')}
        </Button>
        {!run ? (
          <>
            <Button
              variant="outline"
              data-testid="agent-lab-assisted-estimate-btn"
              disabled={!valid || busy !== null}
              onClick={async () => {
                setBusy('estimate')
                await doEstimate()
                setBusy(null)
              }}
            >
              {busy === 'estimate' ? <Loader2 className="animate-spin" aria-hidden /> : null} {t('assisted.estimateBtn')}
            </Button>
            <Button
              data-testid="agent-lab-assisted-start"
              disabled={!valid || busy !== null || estimate?.enough === false}
              onClick={() => void start()}
            >
              {busy === 'start' ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}{' '}
              {t('assisted.start')}
            </Button>
          </>
        ) : null}
      </div>
    </ModalShell>
  )
}
