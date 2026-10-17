// Modal "Importar contatos via CSV" (05 §2; §3.6): passo configurar (baixar o modelo, etiquetas padrão aplicadas às
// linhas sem etiqueta, selecionar o .csv) → enviar → progresso (fase + contadores; `job.progress` no SSE com consulta
// a cada 2 s de reserva) → relatório (criados/atualizados/ignorados/erros, etiquetas criadas, avisos e erros agrupados
// com as linhas). Fechar durante o processamento não cancela: o job segue em segundo plano (também se ficar `queued`).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Download, FileUp, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CONTACTS_KEY, jobDone, jobPercent, labelsQuery, type JobDto } from '@/features/contacts/api'
import { ModalShell } from '@/features/contacts/dialogs'
import { useI18n, useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import { contactJobsApi, IMPORT_TEMPLATE_FILE_NAME, IMPORT_TEMPLATE_URL, importJobKey } from './api'
import { formatBytes, IMPORT_POLL_MS, importCounts, importFileError, importPhase, importReport } from './jobs'
import { registerContactJobsRealtime } from './realtime'

registerContactJobsRealtime()

function useImportJob(id: string | null) {
  return useQuery({
    queryKey: importJobKey(id ?? ''),
    queryFn: () => contactJobsApi.getImport(id!),
    enabled: !!id,
    refetchInterval: (q) => (jobDone(q.state.data) ? false : IMPORT_POLL_MS),
  })
}

export function ImportCsvDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT('contact-jobs')
  const { locale } = useI18n()
  const qc = useQueryClient()
  const labelsQ = useQuery({ ...labelsQuery(), enabled: open })
  const labels = labelsQ.data ?? []
  const [file, setFile] = useState<File | null>(null)
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const job = useImportJob(jobId).data

  const close = () => {
    setFile(null)
    setLabelIds([])
    setError(null)
    setJobId(null)
    onClose()
  }

  const pick = (f: File | null) => {
    setError(null)
    if (!f) return setFile(null)
    const bad = importFileError(f)
    if (bad) {
      setFile(null)
      setError(t(bad === 'type' ? 'import.errors.type' : 'import.errors.size'))
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    setFile(f)
  }

  const submit = async () => {
    if (!file) return
    setPending(true)
    setError(null)
    try {
      const created = await contactJobsApi.startImport(file, labelIds)
      qc.setQueryData(importJobKey(created.id), created)
      setJobId(created.id)
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) setError(t('import.errors.size'))
      else if (err instanceof HttpError && err.status === 422) {
        const fields = (err.details as { fields?: { message?: string }[] } | undefined)?.fields
        setError(fields?.[0]?.message ?? err.message)
      } else if (err instanceof HttpError && err.status === 403) setError(t('import.errors.forbidden'))
      else setError(t('import.errors.start'))
    } finally {
      setPending(false)
    }
  }

  return (
    <ModalShell open={open} onClose={close} testId="contact-import-dialog" title={t('import.title')}>
      {!jobId ? (
        <div className="flex min-w-0 flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t('import.intro')}</p>
          <a
            data-testid="contact-import-template"
            href={IMPORT_TEMPLATE_URL}
            download={IMPORT_TEMPLATE_FILE_NAME}
            className="inline-flex items-center gap-2 self-start rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            <Download className="size-4" aria-hidden /> {t('import.template')}
          </a>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('import.defaultLabels')}</legend>
            <p className="text-xs text-muted-foreground">{t('import.defaultLabelsHint')}</p>
            <div data-testid="contact-import-labels" className="flex flex-wrap gap-2">
              {labelsQ.isSuccess && labels.length === 0 ? (
                <span className="text-xs text-muted-foreground">{t('import.noLabels')}</span>
              ) : null}
              {labels.map((l) => {
                const on = labelIds.includes(l.id)
                return (
                  <button
                    key={l.id}
                    type="button"
                    data-testid={`contact-import-label-${l.id}`}
                    aria-pressed={on}
                    onClick={() => setLabelIds((ids) => (on ? ids.filter((x) => x !== l.id) : [...ids, l.id]))}
                    className={cn(
                      'inline-flex max-w-48 items-center gap-1 rounded-full border px-2.5 py-1 text-xs hover:bg-accent',
                      on && 'border-primary bg-primary/10 font-medium',
                    )}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: l.color ?? 'currentColor' }}
                      aria-hidden
                    />
                    <span className="truncate">{l.name}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>
          <label className="flex min-w-0 cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed p-4 text-center text-sm hover:bg-accent/40">
            <FileUp className="size-6 text-muted-foreground" aria-hidden />
            <span className="font-medium">{t('import.select')}</span>
            <input
              ref={inputRef}
              data-testid="contact-import-file"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <span
                data-testid="contact-import-file-name"
                className="max-w-full truncate text-xs text-muted-foreground"
              >
                {file.name} · {formatBytes(file.size, locale)}
              </span>
            ) : null}
          </label>
          <p className="text-xs text-muted-foreground">{t('import.labelsNote')}</p>
          {error ? (
            <p data-testid="contact-import-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="contact-import-cancel" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button data-testid="contact-import-submit" disabled={!file || pending} onClick={() => void submit()}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t('import.submit')}
            </Button>
          </div>
        </div>
      ) : job ? (
        <div className="flex min-w-0 flex-col gap-4">
          <ImportProgress job={job} />
          {job.status === 'completed' ? <ImportReportView job={job} /> : null}
          {job.status === 'failed' ? (
            <p data-testid="contact-import-failed" role="alert" className="text-sm text-destructive">
              {job.error ?? t('import.failed')}
            </p>
          ) : null}
          {!jobDone(job) ? <p className="text-xs text-muted-foreground">{t('import.background')}</p> : null}
          <div className="flex justify-end">
            <Button
              variant="outline"
              data-testid="contact-import-close"
              onClick={() => {
                if (jobDone(job)) void qc.invalidateQueries({ queryKey: [...CONTACTS_KEY, 'list'] })
                close()
              }}
            >
              {t('common.close')}
            </Button>
          </div>
        </div>
      ) : null}
    </ModalShell>
  )
}

function ImportProgress({ job }: { job: JobDto }) {
  const t = useT('contact-jobs')
  const phase = importPhase(job)
  const pct = jobPercent(job)
  const counts = importCounts(job)
  const total = job.progress.total
  return (
    <div
      data-testid="contact-import-progress"
      data-status={job.status}
      data-phase={phase}
      role="status"
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2 text-sm">
        {!jobDone(job) ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : null}
        <span className="flex-1">{t(`import.phase.${phase}`)}</span>
        <span className="tabular-nums text-muted-foreground">{pct !== null ? `${pct}%` : ''}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            job.status === 'failed' ? 'bg-destructive' : 'bg-primary',
          )}
          style={{ width: `${pct ?? 5}%` }}
        />
      </div>
      {total ? (
        <p data-testid="contact-import-processed" className="text-xs text-muted-foreground tabular-nums">
          {t('import.processed', { n: job.status === 'completed' ? total : job.progress.processed, total })}
        </p>
      ) : null}
      {!jobDone(job) && phase === 'importing' ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('import.partial', {
            created: counts.created,
            updated: counts.updated,
            skipped: counts.skipped,
            errors: counts.errors,
          })}
        </p>
      ) : null}
    </div>
  )
}

function ImportReportView({ job }: { job: JobDto }) {
  const t = useT('contact-jobs')
  const r = importReport(job)
  const stats = [
    ['created', r.created],
    ['updated', r.updated],
    ['skipped', r.skipped],
    ['errors', r.errors],
  ] as const
  return (
    <div data-testid="contact-import-report" className="flex min-w-0 flex-col gap-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <CheckCircle2 className="size-4 text-emerald-600" aria-hidden /> {t('import.done')}
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map(([k, n]) => (
          <div
            key={k}
            className={cn(
              'rounded-lg border p-2 text-center',
              k === 'errors' && n > 0 && 'border-destructive/40 bg-destructive/5',
            )}
          >
            <dt className="text-xs text-muted-foreground">{t(`import.counts.${k}`)}</dt>
            <dd data-testid={`contact-import-count-${k}`} className="text-lg font-semibold tabular-nums">
              {n}
            </dd>
          </div>
        ))}
      </dl>
      {r.labelsCreated.length ? (
        <p data-testid="contact-import-labels-created" className="text-xs text-muted-foreground">
          {t('import.labelsCreated', { names: r.labelsCreated.join(', ') })}
        </p>
      ) : null}
      {r.warningGroups.length ? (
        <div data-testid="contact-import-warnings" className="flex flex-col gap-1">
          <p className="flex items-center gap-1 text-sm font-medium">
            <AlertTriangle className="size-4 text-amber-500" aria-hidden /> {t('import.warnings')}
          </p>
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {r.warningGroups.map((w, i) => (
              <li key={i} data-testid={`contact-import-warning-group-${i}`}>
                {t('import.warningItem', { message: w.message, n: w.count })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.errorGroups.length ? (
        <div data-testid="contact-import-errors" className="flex flex-col gap-2">
          <p className="text-sm font-medium text-destructive">{t('import.errorsTitle')}</p>
          <ul className="flex flex-col gap-2">
            {r.errorGroups.map((g, i) => (
              <li
                key={i}
                data-testid={`contact-import-error-group-${i}`}
                className="rounded-md border border-destructive/30 p-2 text-xs"
              >
                <p className="font-medium">
                  <span data-testid={`contact-import-error-group-${i}-message`}>{g.message}</span>{' '}
                  <span
                    className="text-muted-foreground tabular-nums"
                    data-testid={`contact-import-error-group-${i}-count`}
                  >
                    ({t('import.errorCount', { n: g.count })})
                  </span>
                </p>
                {g.lines.length ? (
                  <p
                    className="text-muted-foreground tabular-nums"
                    data-testid={`contact-import-error-group-${i}-lines`}
                  >
                    {t('import.errorLines', { lines: g.lines.join(', ') })}
                    {g.count > g.lines.length ? '…' : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {r.extraErrors > 0 ? (
            <p className="text-xs text-muted-foreground">{t('import.extraErrors', { n: r.extraErrors })}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
