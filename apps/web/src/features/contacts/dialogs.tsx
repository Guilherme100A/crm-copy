// Diálogos das ações da página de contatos (05 §2): exclusão em massa (confirmação → progresso → fim), exportação CSV
// (pergunta + "Incluir campos personalizados" → progresso → download) e "Importar do WhatsApp" (confirmação → resultado).
// Progresso dos jobs: `job.progress` no SSE + consulta a cada 2 s até terminar (reserva).
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, Loader2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import {
  CONTACTS_KEY,
  contactsApi,
  jobDone,
  jobFileUrl,
  jobKey,
  jobPercent,
  type ConnectionDto,
  type JobDto,
  type WhatsAppImportResult,
} from './api'

const POLL_MS = 2_000

const popupClass =
  'fixed top-1/2 left-1/2 z-[70] flex max-h-[90dvh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none'

export function ModalShell({
  open,
  onClose,
  testId,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  testId: string
  title: string
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid={testId} className={popupClass}>
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function useJob(kind: 'export' | 'bulk-delete', id: string | null) {
  return useQuery({
    queryKey: jobKey(kind, id ?? ''),
    queryFn: () => (kind === 'export' ? contactsApi.getExport(id!) : contactsApi.getBulkDelete(id!)),
    enabled: !!id,
    refetchInterval: (q) => (jobDone(q.state.data) ? false : POLL_MS),
  })
}

function ProgressBar({ job, testId }: { job: JobDto; testId: string }) {
  const t = useT('contacts')
  const pct = jobPercent(job)
  return (
    <div data-testid={testId} data-status={job.status} role="status" className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        {!jobDone(job) ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : null}
        <span className="flex-1">{job.status === 'queued' ? t('jobs.queued') : t('jobs.processing')}</span>
        <span className="tabular-nums text-muted-foreground">
          {pct !== null ? `${pct}%` : t('jobs.processed', { n: job.progress.processed })}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct ?? 5}%` }} />
      </div>
    </div>
  )
}

/** Exclusão em massa: confirma, envia o manifesto e acompanha o job até o fim. */
export function BulkDeleteDialog({
  open,
  count,
  manifest,
  onClose,
  onDone,
}: {
  open: boolean
  count: string
  manifest: () => Record<string, unknown>
  onClose: () => void
  onDone: () => void
}) {
  const t = useT('contacts')
  const qc = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const job = useJob('bulk-delete', jobId).data
  const finished = jobDone(job)

  const close = () => {
    if (jobId && !finished) return // em andamento: o diálogo fica aberto até o fim
    if (jobId) onDone()
    setJobId(null)
    onClose()
  }

  return (
    <ModalShell open={open} onClose={close} testId="contacts-bulk-delete-dialog" title={t('bulkDelete.title')}>
      {!jobId ? (
        <>
          <p className="text-sm text-muted-foreground">{t('bulkDelete.body', { n: count })}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="contacts-bulk-delete-cancel" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              data-testid="contacts-bulk-delete-confirm"
              disabled={pending}
              onClick={async () => {
                setPending(true)
                try {
                  const created = await contactsApi.startBulkDelete(manifest())
                  qc.setQueryData(jobKey('bulk-delete', created.id), created)
                  setJobId(created.id)
                } catch {
                  notify('contacts-bulk-delete-error', t('bulkDelete.startError'))
                } finally {
                  setPending(false)
                }
              }}
            >
              {t('bulkDelete.confirm')}
            </Button>
          </div>
        </>
      ) : job ? (
        <>
          <ProgressBar job={job} testId="contacts-bulk-delete-progress" />
          {job.status === 'completed' ? (
            <p data-testid="contacts-bulk-delete-done" className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
              {t('bulkDelete.done', {
                n: Number(job.counters.deleted_count ?? job.row_count ?? job.progress.processed ?? 0),
              })}
            </p>
          ) : null}
          {job.status === 'failed' ? (
            <p data-testid="contacts-bulk-delete-failed" className="text-sm text-destructive">
              {job.error ?? t('bulkDelete.failed')}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button variant="outline" data-testid="contacts-bulk-delete-close" disabled={!finished} onClick={close}>
              {t('common.close')}
            </Button>
          </div>
        </>
      ) : null}
    </ModalShell>
  )
}

/** Exportação CSV (05 §3.5): `ids`, `all_except` ou `filtered` (sem seleção). */
export function ExportDialog({
  open,
  count,
  body,
  onClose,
}: {
  open: boolean
  count: string
  body: (includeCustomFields: boolean) => Record<string, unknown>
  onClose: () => void
}) {
  const t = useT('contacts')
  const qc = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(null)
  const [custom, setCustom] = useState(false)
  const [pending, setPending] = useState(false)
  const job = useJob('export', jobId).data

  const close = () => {
    setJobId(null)
    setCustom(false)
    onClose()
  }

  return (
    <ModalShell open={open} onClose={close} testId="contacts-export-dialog" title={t('export.title')}>
      {!jobId ? (
        <>
          <p className="text-sm">{t('export.body', { n: count })}</p>
          <label className="flex items-start gap-2 text-sm">
            <input
              data-testid="contacts-export-custom-fields"
              type="checkbox"
              className="mt-0.5 size-4"
              checked={custom}
              onChange={(e) => setCustom(e.target.checked)}
            />
            <span>{t('export.customFields')}</span>
          </label>
          <p className="text-xs text-muted-foreground">{t('export.hint')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="contacts-export-cancel" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="contacts-export-confirm"
              disabled={pending}
              onClick={async () => {
                setPending(true)
                try {
                  const created = await contactsApi.startExport(body(custom))
                  qc.setQueryData(jobKey('export', created.id), created)
                  setJobId(created.id)
                } catch {
                  notify('contacts-export-error', t('export.startError'))
                } finally {
                  setPending(false)
                }
              }}
            >
              {t('export.confirm')}
            </Button>
          </div>
        </>
      ) : job ? (
        <>
          <ProgressBar job={job} testId="contacts-export-progress" />
          {job.status === 'completed' ? (
            <a
              data-testid="contacts-export-download"
              href={jobFileUrl(job)}
              download={job.file_name ?? undefined}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Download className="size-4" aria-hidden /> {t('export.download', { n: job.row_count ?? 0 })}
            </a>
          ) : null}
          {job.status === 'failed' ? (
            <p data-testid="contacts-export-failed" className="text-sm text-destructive">
              {job.error ?? t('export.failed')}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button variant="outline" data-testid="contacts-export-close" onClick={close}>
              {t('common.close')}
            </Button>
          </div>
        </>
      ) : null}
    </ModalShell>
  )
}

/** "Importar do WhatsApp" da primeira conexão conectada (05 §5 nº 20). */
export function ImportWhatsAppDialog({
  open,
  connection,
  onClose,
}: {
  open: boolean
  connection: ConnectionDto | null
  onClose: () => void
}) {
  const t = useT('contacts')
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<WhatsAppImportResult | null>(null)

  const close = () => {
    setResult(null)
    onClose()
  }

  return (
    <ModalShell open={open} onClose={close} testId="contacts-import-whatsapp-dialog" title={t('importWhatsapp.title')}>
      {!result ? (
        <>
          <p className="text-sm">{t('importWhatsapp.body', { name: connection?.name ?? '' })}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="contacts-import-whatsapp-cancel" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="contacts-import-whatsapp-confirm"
              disabled={pending || !connection}
              onClick={async () => {
                if (!connection) return
                setPending(true)
                try {
                  setResult(await contactsApi.importFromWhatsApp(connection.id))
                  void qc.invalidateQueries({ queryKey: [...CONTACTS_KEY, 'list'] })
                } catch (err) {
                  notify(
                    'contacts-import-whatsapp-error',
                    err instanceof HttpError && err.status === 409
                      ? t('importWhatsapp.notConnected')
                      : t('importWhatsapp.error'),
                  )
                  void qc.invalidateQueries({ queryKey: [...CONTACTS_KEY, 'connections'] })
                } finally {
                  setPending(false)
                }
              }}
            >
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t('importWhatsapp.confirm')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p data-testid="contacts-import-whatsapp-result" className="text-sm font-medium">
            {t('importWhatsapp.result', {
              imported: result.imported,
              updated: result.updated,
              skipped: result.skipped,
            })}
          </p>
          {Array.isArray(result.warnings) && result.warnings.length ? (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {(result.warnings as unknown[]).slice(0, 8).map((w, i) => (
                <li key={i}>{String(w)}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex justify-end">
            <Button variant="outline" data-testid="contacts-import-whatsapp-close" onClick={close}>
              {t('common.close')}
            </Button>
          </div>
        </>
      )}
    </ModalShell>
  )
}
