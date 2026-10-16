// "Exportar leads em planilha" (04 §5.26): cria o job `kanban_cards` (T27) com os filtros atuais, mostra o progresso
// (`job.progress` no SSE + consulta a cada 2 s até terminar) e oferece o download quando `completed`.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { exportApi, fileUrl, type JobDto } from './api'
import type { ApiFilters } from './filters'
import { jobKey } from './realtime'

const POLL_MS = 2_000

const done = (j: JobDto | undefined) => j?.status === 'completed' || j?.status === 'failed'

export function progressLabel(job: JobDto, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (job.status === 'queued') return t('export.queued')
  if (job.status === 'completed') return t('export.completed', { n: job.row_count ?? 0 })
  if (job.status === 'failed') return t('export.failed')
  return job.progress.percent !== null ? `${Math.round(job.progress.percent)}%` : t('export.processing')
}

export function ExportButton({ crmId, filters, onStarted }: { crmId: string; filters: ApiFilters; onStarted: (jobId: string) => void }) {
  const t = useT('kanban-tools')
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="crms-tools-export"
      disabled={pending}
      onClick={async () => {
        setPending(true)
        try {
          const job = await exportApi.start(crmId, filters)
          qc.setQueryData(jobKey(job.id), job)
          onStarted(job.id)
        } catch {
          notify('kt-export-start-error', t('export.startError'))
        } finally {
          setPending(false)
        }
      }}
    >
      <FileSpreadsheet aria-hidden /> <span className="max-sm:sr-only">{t('export.button')}</span>
    </Button>
  )
}

export function ExportStatus({ jobId, onDismiss }: { jobId: string; onDismiss: () => void }) {
  const t = useT('kanban-tools')
  const q = useQuery({
    queryKey: jobKey(jobId),
    queryFn: () => exportApi.get(jobId),
    refetchInterval: (query) => (done(query.state.data) ? false : POLL_MS),
  })
  const job = q.data
  if (!job) return null
  return (
    <div data-testid="kt-export" data-status={job.status} role="status" className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
      {!done(job) ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : null}
      <span className="font-medium">{t('export.title')}</span>
      <span data-testid="kt-export-progress" className="tabular-nums text-muted-foreground">
        {progressLabel(job, t)}
      </span>
      {job.status === 'completed' ? (
        <a
          data-testid="kt-export-download"
          href={fileUrl(job.id)}
          download={job.file_name ?? undefined}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Download className="size-3.5" aria-hidden /> {t('export.download')}
        </a>
      ) : null}
      {job.status === 'failed' ? (
        <span data-testid="kt-export-error" className="text-destructive">
          {job.error ?? t('export.failed')}
        </span>
      ) : null}
      {done(job) ? (
        <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={onDismiss}>
          {t('common.close')}
        </Button>
      ) : null}
    </div>
  )
}
