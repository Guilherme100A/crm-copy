// Peças de UI compartilhadas pelas sub-abas da Empresa (dados, departamentos, horários).
import { Dialog } from '@base-ui/react/dialog'
import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom, type Session } from '@/lib/session'
import { cn } from '@/lib/utils'

/** Sessão atual (do cache do perfil). */
export function useSession(): Session | null {
  const profile = useQuery(profileQuery()).data
  return profile ? sessionFrom(profile) : null
}

export const can = (s: Session | null, key: string) => !!s && hasAny(s, [key])

export const inputClass =
  'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60'

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  testId,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
  testId: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
      )}
    >
      <span
        className={cn(
          'inline-block size-4 rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-4.5' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

/** Diálogo de confirmação (SPEC 3.11: nunca `window.confirm`). `tone="critical"` para ações destrutivas. */
export function ConfirmDialog({
  open,
  testId,
  title,
  body,
  confirmLabel,
  tone = 'critical',
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean
  testId: string
  title: string
  body?: string
  confirmLabel: string
  tone?: 'critical' | 'default'
  onCancel: () => void
  onConfirm: () => Promise<void>
  children?: ReactNode
}) {
  const t = useT('settings-company')
  const [pending, setPending] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !pending && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid={testId}
          role={tone === 'critical' ? 'alertdialog' : 'dialog'}
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          {body ? <Dialog.Description className="text-sm text-muted-foreground">{body}</Dialog.Description> : null}
          {children}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" data-testid={`${testId}-cancel`} disabled={pending} onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={tone === 'critical' ? 'destructive' : 'default'}
              data-testid={`${testId}-ok`}
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

/** Estados obrigatórios (SPEC 3.11): carregando, erro com "Tentar novamente". */
export function Loading() {
  return <div className="h-32 animate-pulse rounded-lg bg-muted" aria-busy="true" />
}

export function LoadError({ onRetry, testId }: { onRetry: () => void; testId: string }) {
  const t = useT('settings-company')
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 p-4 text-sm"
    >
      <p className="text-destructive">{t('common.loadError')}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  )
}
