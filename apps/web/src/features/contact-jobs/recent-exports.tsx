// Painel "Exportações recentes" (05 §2, `n3t`; §4): as 3 últimas exportações do usuário (em andamento primeiro),
// com status, linhas, tamanho, data e download do arquivo pronto. Atualiza pelo `job.progress` e, enquanto houver
// exportação em andamento, consulta de novo a cada 10 s.
import { useQuery } from '@tanstack/react-query'
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react'
import { jobDone, jobFileUrl, jobPercent } from '@/features/contacts/api'
import { ModalShell } from '@/features/contacts/dialogs'
import { Button } from '@/components/ui/button'
import { useI18n, useT } from '@/i18n'
import { recentExportsQuery, type ExportJobDto } from './api'
import { EXPORTS_POLL_MS, formatBytes, sortRecentExports } from './jobs'
import { registerContactJobsRealtime } from './realtime'

registerContactJobsRealtime()

export function RecentExportsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT('contact-jobs')
  const q = useQuery({
    ...recentExportsQuery(),
    enabled: open,
    refetchInterval: (query) => (open && (query.state.data ?? []).some((j) => !jobDone(j)) ? EXPORTS_POLL_MS : false),
  })
  const items = sortRecentExports(q.data ?? [])

  return (
    <ModalShell open={open} onClose={onClose} testId="contact-exports-panel" title={t('exports.title')}>
      {q.isPending ? (
        <div data-testid="contact-exports-loading" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('exports.loading')}
        </div>
      ) : q.isError ? (
        <div data-testid="contact-exports-error" className="flex flex-wrap items-center gap-3 text-sm">
          <span className="flex-1">{t('exports.error')}</span>
          <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p data-testid="contact-exports-empty" className="text-sm text-muted-foreground">
          {t('exports.empty')}
        </p>
      ) : (
        <ul data-testid="contact-exports-list" className="flex flex-col gap-2">
          {items.map((j) => (
            <ExportItem key={j.id} job={j} />
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t('exports.hint')}</p>
      <div className="flex justify-end">
        <Button variant="outline" data-testid="contact-exports-close" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </ModalShell>
  )
}

function ExportItem({ job }: { job: ExportJobDto }) {
  const t = useT('contact-jobs')
  const { locale } = useI18n()
  const pct = jobPercent(job)
  const when = job.created_at ? new Date(job.created_at) : null
  const date =
    when && !Number.isNaN(when.getTime())
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(when)
      : ''
  const meta = [
    job.status === 'completed' && job.row_count !== null ? t('exports.rows', { n: job.row_count }) : null,
    job.status === 'completed' ? formatBytes(job.file_size, locale) : null,
    date,
  ].filter(Boolean)
  return (
    <li
      data-testid={`contact-exports-item-${job.id}`}
      data-status={job.status}
      className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
    >
      <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{job.file_name ?? t('exports.unnamed')}</span>
        <span className="truncate text-xs text-muted-foreground">
          <span data-testid={`contact-exports-status-${job.id}`}>
            {t(`exports.status.${job.status}`)}
            {!jobDone(job) && pct !== null ? ` · ${pct}%` : ''}
          </span>
          {meta.length ? ` · ${meta.join(' · ')}` : ''}
        </span>
        {job.status === 'failed' && job.error ? (
          <span className="truncate text-xs text-destructive">{job.error}</span>
        ) : null}
      </span>
      {job.status === 'completed' && job.download_url ? (
        <a
          data-testid={`contact-exports-download-${job.id}`}
          href={jobFileUrl(job)}
          download={job.file_name ?? undefined}
          aria-label={t('exports.download', { name: job.file_name ?? '' })}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border hover:bg-accent"
        >
          <Download className="size-4" aria-hidden />
        </a>
      ) : !jobDone(job) ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : null}
    </li>
  )
}
