// Peças comuns das abas do admin (T100): cabeçalho "Só visualização · atualizado às HH:MM" com Atualizar (20 §1, §5
// item 11), confirmação genérica, campo de imagem com upload e prévia (20 §3.6/§3.7) e selos de status.
import { Dialog } from '@base-ui/react/dialog'
import { ImageUp, RefreshCw, X } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Field, inputClass, serverMessage } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { adminApi } from './api'
import { formatHHMM, isHttpUrl, uploadIssue } from './rules'

export const NS = 'admin'

/** Título da aba + "atualizado às HH:MM" + Atualizar (`admin-<prefix>-updated-at`, `admin-<prefix>-refresh`). */
export function ReadOnlyHeader({
  prefix,
  title,
  subtitle,
  updatedAt,
  refreshing,
  onRefresh,
  readOnly = true,
  children,
}: {
  prefix: string
  title: string
  subtitle?: string
  updatedAt: string | number | null | undefined
  refreshing: boolean
  onRefresh: () => void
  /** Prefixo "Só visualização" (abas sem escrita). */
  readOnly?: boolean
  children?: ReactNode
}) {
  const t = useT(NS)
  const hhmm = formatHHMM(updatedAt)
  return (
    <header className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold">{title}</h2>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        <p data-testid={`admin-${prefix}-updated-at`} className="text-xs text-muted-foreground">
          {[readOnly ? t('common.readOnly') : null, hhmm ? t('common.updatedAt', { time: hhmm }) : null].filter(Boolean).join(' · ')}
        </p>
      </div>
      {children}
      <Button variant="outline" size="sm" data-testid={`admin-${prefix}-refresh`} disabled={refreshing} onClick={onRefresh}>
        <RefreshCw aria-hidden className={cn(refreshing && 'animate-spin')} /> {t('common.refresh')}
      </Button>
    </header>
  )
}

/** Diálogo de confirmação com rótulo próprio (nunca `window.confirm`). */
export function ConfirmAction({
  prefix,
  open,
  title,
  body,
  confirmLabel,
  destructive,
  onCancel,
  onConfirm,
}: {
  prefix: string
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => Promise<void>
}) {
  const t = useT(NS)
  const [pending, setPending] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !pending && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[80] bg-black/40" />
        <Dialog.Popup
          data-testid={`${prefix}-confirm`}
          className="fixed top-1/2 left-1/2 z-[80] flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <div className="text-sm text-muted-foreground">{body}</div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid={`${prefix}-confirm-cancel`} disabled={pending} onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={destructive ? 'destructive' : 'default'}
              data-testid={`${prefix}-confirm-ok`}
              disabled={pending}
              onClick={async () => {
                setPending(true)
                try {
                  await onConfirm()
                } finally {
                  setPending(false)
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Imagem do aviso/banner: enviar arquivo (`POST /api/admin/uploads` → URL pública) ou colar uma URL http(s); prévia
 * quando houver URL válida. Testids: `<prefix>-image-file`, `<prefix>-image-url`, `<prefix>-image-preview`,
 * `<prefix>-image-remove`, `<prefix>-image-error`.
 */
export function ImageField({
  prefix,
  label,
  value,
  onChange,
  onUploading,
  error,
  required,
}: {
  prefix: string
  label: string
  value: string
  onChange: (url: string) => void
  onUploading: (busy: boolean) => void
  error?: string | null
  required?: boolean
}) {
  const t = useT(NS)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)

  const pick = async (file: File | undefined) => {
    if (!file) return
    const issue = uploadIssue(file)
    if (issue) {
      setUploadError(t(`errors.upload_${issue}`))
      return
    }
    setUploadError(null)
    setBusy(true)
    onUploading(true)
    try {
      onChange(await adminApi.upload(file))
      setBroken(false)
    } catch (err) {
      setUploadError(serverMessage(err, 'file') ?? t('errors.uploadFailed'))
    } finally {
      setBusy(false)
      onUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const shown = value.trim() && isHttpUrl(value) ? value.trim() : null
  const message = uploadError ?? error ?? null
  return (
    <Field label={`${label}${required ? ' *' : ''}`} htmlFor={`${prefix}-image-url`} error={message} errorTestId={`${prefix}-image-error`} hint={t('common.imageHint')}>
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            id={`${prefix}-image-url`}
            data-testid={`${prefix}-image-url`}
            className={inputClass}
            value={value}
            placeholder="https://"
            onChange={(e) => {
              setBroken(false)
              onChange(e.target.value)
            }}
          />
          <Button variant="outline" data-testid={`${prefix}-image-upload`} disabled={busy} onClick={() => fileRef.current?.click()}>
            <ImageUp aria-hidden /> {busy ? t('common.uploading') : t('common.upload')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            data-testid={`${prefix}-image-file`}
            className="sr-only"
            tabIndex={-1}
            aria-label={t('common.upload')}
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </div>
        {shown ? (
          <div className="relative w-fit">
            {broken ? (
              <p data-testid={`${prefix}-image-broken`} className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                {t('common.imageBroken')}
              </p>
            ) : (
              <img
                data-testid={`${prefix}-image-preview`}
                src={shown}
                alt={t('common.preview')}
                className="max-h-40 max-w-full rounded-md border object-contain"
                onError={() => setBroken(true)}
              />
            )}
            <button
              type="button"
              data-testid={`${prefix}-image-remove`}
              aria-label={t('common.removeImage')}
              onClick={() => onChange('')}
              className="absolute -top-2 -right-2 rounded-full border bg-background p-1 shadow"
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
    </Field>
  )
}

export function StatusBadge({ ok, label, testId }: { ok: boolean; label: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      data-status={ok ? 'ok' : 'down'}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        ok ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-destructive/15 text-destructive',
      )}
    >
      {label}
    </span>
  )
}

/** Data curta no idioma da tela. */
export const fmtDate = (iso: string | null | undefined, locale: string) =>
  iso ? new Date(iso).toLocaleDateString(locale) : '—'
export const fmtDateTime = (iso: string | null | undefined, locale: string) =>
  iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : '—'
export const fmtNumber = (n: number | null | undefined, locale: string) => (n === null || n === undefined ? '—' : n.toLocaleString(locale))
