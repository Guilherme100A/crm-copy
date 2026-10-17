// Peças visuais dos agentes: modal (Base UI Dialog), campo com rótulo e erro do servidor, interruptor, avatar
// pré-definido (`leo-1`…`leo-10`) ou enviado, e o selo de status.
import { Dialog } from '@base-ui/react/dialog'
import { useId, type ReactNode } from 'react'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { AgentStatus } from './api'
import { apiUrl } from '@/lib/base'

export const inputClass =
  'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive disabled:opacity-50'
export const textareaClass =
  'min-h-20 w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive'

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

/** Rótulo + controle + erro do servidor (`agent-field-error-<path>`). O controle recebe `id` e `aria-invalid`. */
export function Field({
  label,
  hint,
  error,
  path,
  children,
  className,
}: {
  label: string
  hint?: string
  error?: string
  path: string
  children: (props: {
    id: string
    'aria-invalid': boolean | undefined
    'aria-describedby': string | undefined
  }) => ReactNode
  className?: string
}) {
  const id = useId()
  const errId = `${id}-err`
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error !== undefined ? true : undefined,
        'aria-describedby': error !== undefined ? errId : undefined,
      })}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error !== undefined ? <FieldError id={errId} path={path} message={error} /> : null}
    </div>
  )
}

export function FieldError({ path, message, id }: { path: string; message: string; id?: string }) {
  return (
    <p id={id} data-testid={`agent-field-error-${path}`} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  testId,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  testId?: string
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'flex min-w-0 cursor-pointer items-start justify-between gap-3 rounded-lg border p-3',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        data-testid={testId}
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

const AVATAR_COLORS = [
  '#f97316',
  '#0ea5e9',
  '#22c55e',
  '#a855f7',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#6366f1',
  '#ec4899',
  '#64748b',
]

export function AgentAvatar({
  name,
  avatarKey,
  avatarUrl,
  size = 'md',
}: {
  name: string
  avatarKey: string
  avatarUrl?: string | null
  size?: 'sm' | 'md' | 'lg'
}) {
  const n = Number(/^leo-(\d+)$/.exec(avatarKey)?.[1] ?? 1)
  const dim = size === 'lg' ? 'size-20 text-2xl' : size === 'sm' ? 'size-8 text-xs' : 'size-11 text-base'
  if (avatarUrl) return <img src={apiUrl(avatarUrl)} alt="" className={cn('shrink-0 rounded-full object-cover', dim)} />
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', dim)}
      style={{ backgroundColor: AVATAR_COLORS[(n - 1) % AVATAR_COLORS.length] }}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

export function StatusBadge({ status, testId }: { status: AgentStatus; testId?: string }) {
  const t = useT('agents')
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
        status === 'active' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
        status === 'paused' && 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
        status === 'draft' && 'bg-muted text-muted-foreground',
      )}
    >
      {t(`status.${status}`)}
    </span>
  )
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <header>
        <h3 className="font-semibold">{title}</h3>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </header>
      {children}
    </section>
  )
}
