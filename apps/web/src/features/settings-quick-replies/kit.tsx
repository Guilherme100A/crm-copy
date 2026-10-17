// Peças comuns às cinco abas de conteúdo da T58 (respostas rápidas, modelos, variáveis, campos e etiquetas):
// permissões da sessão, cabeçalho com busca, paginação, tabela (desktop) × cartões (mobile), diálogos de edição e de
// confirmação e a mensagem de erro do servidor. Testids no padrão `<prefixo>-<coisa>` (docs/licoes.md).
import { Dialog } from '@base-ui/react/dialog'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'

const NS = 'settings-quick-replies'

export interface PageMeta {
  page: number
  limit: number
  total_count: number | null
  total_pages?: number | null
  has_more: boolean
}

/** Permissões de edição/exclusão da aba (owner sempre pode; `hasAny`). */
export function usePerms(edit: readonly string[], del: readonly string[]) {
  const profile = useQuery(profileQuery()).data
  const s = profile ? sessionFrom(profile) : null
  return { canEdit: !!s && hasAny(s, edit), canDelete: !!s && hasAny(s, del) }
}

/** Texto digitado → valor aplicado depois de `ms` sem digitar. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

/** Mensagem do servidor (SPEC 3.5): o campo pedido em `details.fields`, senão a mensagem geral. */
export function serverMessage(err: unknown, path?: string): string | null {
  if (!(err instanceof HttpError)) return null
  const fields = (err.details as { fields?: { path: string; message: string }[] } | undefined)?.fields ?? []
  const f = path ? fields.find((x) => x.path === path) : undefined
  return f?.message ?? (err.message || null)
}

/** Erro que pertence ao campo `path` (por `details.fields` ou `details.field`). */
export function isFieldError(err: unknown, path: string): boolean {
  if (!(err instanceof HttpError)) return false
  const d = err.details as { fields?: { path: string }[]; field?: string } | undefined
  return d?.field === path || !!d?.fields?.some((x) => x.path === path)
}

export const totalPages = (meta: PageMeta | undefined) => {
  if (!meta) return 1
  if (meta.total_pages) return Math.max(1, meta.total_pages)
  if (meta.total_count !== null && meta.total_count !== undefined)
    return Math.max(1, Math.ceil(meta.total_count / Math.max(1, meta.limit)))
  return meta.page + (meta.has_more ? 1 : 0)
}

export function TabHeader({
  prefix,
  title,
  subtitle,
  canCreate,
  newLabel,
  onNew,
}: {
  prefix: string
  title: string
  subtitle?: string
  canCreate: boolean
  newLabel: string
  onNew: () => void
}) {
  return (
    <header className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold">{title}</h2>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {canCreate ? (
        <Button data-testid={`${prefix}-new`} onClick={onNew}>
          <Plus aria-hidden /> {newLabel}
        </Button>
      ) : null}
    </header>
  )
}

export function SearchBox({
  prefix,
  value,
  onChange,
  placeholder,
}: {
  prefix: string
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <label className="relative block w-full sm:max-w-sm">
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        data-testid={`${prefix}-search`}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  )
}

export function Pager({
  prefix,
  meta,
  onPage,
}: {
  prefix: string
  meta: PageMeta | undefined
  onPage: (p: number) => void
}) {
  const t = useT(NS)
  if (!meta) return null
  const pages = totalPages(meta)
  if (pages <= 1 && meta.page <= 1) return null
  return (
    <nav aria-label={t('common.pagination')} className="flex items-center justify-end gap-2 text-sm">
      <Button
        variant="outline"
        size="sm"
        data-testid={`${prefix}-prev`}
        disabled={meta.page <= 1}
        onClick={() => onPage(meta.page - 1)}
        aria-label={t('common.prev')}
      >
        <ChevronLeft aria-hidden />
      </Button>
      <span data-testid={`${prefix}-page`} className="tabular-nums text-muted-foreground">
        {t('common.pageOf', { page: meta.page, pages })}
      </span>
      <Button
        variant="outline"
        size="sm"
        data-testid={`${prefix}-next`}
        disabled={!meta.has_more && meta.page >= pages}
        onClick={() => onPage(meta.page + 1)}
        aria-label={t('common.next')}
      >
        <ChevronRight aria-hidden />
      </Button>
    </nav>
  )
}

export interface Column<T> {
  id: string
  header: string
  cell: (row: T) => ReactNode
  className?: string
}

/**
 * Lista responsiva (AC-T58-05): tabela no desktop (`<prefixo>-table`) e cartões no mobile (`<prefixo>-cards`). A linha
 * e o cartão têm o mesmo testid `<prefixo>-item-<id>`; as ações só aparecem com permissão.
 */
export function DataList<T>({
  prefix,
  rows,
  rowId,
  columns,
  title,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
  status,
  empty,
}: {
  prefix: string
  rows: readonly T[]
  rowId: (row: T) => string
  columns: Column<T>[]
  /** Coluna principal do cartão mobile. */
  title: (row: T) => ReactNode
  canEdit: (row: T) => boolean
  canDelete: (row: T) => boolean
  onEdit: (row: T) => void
  onDelete?: (row: T) => void
  status: 'pending' | 'error' | 'success'
  empty: string
}) {
  const t = useT(NS)
  const desktop = useIsDesktop()
  if (status === 'pending') return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  if (status === 'error') return <p className="text-sm text-destructive">{t('common.error')}</p>
  if (rows.length === 0)
    return (
      <p
        data-testid={`${prefix}-empty`}
        className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
      >
        {empty}
      </p>
    )
  const actions = (row: T) => {
    const id = rowId(row)
    return (
      <div className="flex items-center justify-end gap-1">
        {canEdit(row) ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            data-testid={`${prefix}-item-edit-${id}`}
            aria-label={t('common.edit')}
            onClick={() => onEdit(row)}
          >
            <Pencil aria-hidden />
          </Button>
        ) : null}
        {onDelete && canDelete(row) ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive"
            data-testid={`${prefix}-item-delete-${id}`}
            aria-label={t('common.delete')}
            onClick={() => onDelete(row)}
          >
            <Trash2 aria-hidden />
          </Button>
        ) : null}
      </div>
    )
  }
  if (!desktop)
    return (
      <ul data-testid={`${prefix}-cards`} className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={rowId(row)}
            data-testid={`${prefix}-item-${rowId(row)}`}
            className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3"
          >
            <div className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1 font-medium break-words">{title(row)}</div>
              {actions(row)}
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              {columns.slice(1).map((c) => (
                <div key={c.id} className="contents">
                  <dt className="text-muted-foreground">{c.header}</dt>
                  <dd className="min-w-0 break-words">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    )
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table data-testid={`${prefix}-table`} className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground uppercase">
          <tr>
            {columns.map((c) => (
              <th key={c.id} scope="col" className={cn('px-3 py-2 font-medium', c.className)}>
                {c.header}
              </th>
            ))}
            <th scope="col" className="w-24 px-3 py-2">
              <span className="sr-only">{t('common.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={rowId(row)} data-testid={`${prefix}-item-${rowId(row)}`} className="align-top hover:bg-muted/30">
              {columns.map((c) => (
                <td key={c.id} className={cn('px-3 py-2', c.className)}>
                  {c.cell(row)}
                </td>
              ))}
              <td className="px-3 py-1">{actions(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Diálogo de formulário (criar/editar). `onSubmit` recebe o evento já com `preventDefault`. */
export function FormDialog({
  prefix,
  open,
  title,
  onClose,
  onSubmit,
  pending,
  error,
  wide,
  children,
}: {
  prefix: string
  open: boolean
  title: string
  onClose: () => void
  onSubmit: () => void
  pending: boolean
  error?: string | null
  wide?: boolean
  children: ReactNode
}) {
  const t = useT(NS)
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid={`${prefix}-editor`}
          className={cn(
            'fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background shadow-xl outline-none',
            wide ? 'w-[min(56rem,calc(100vw-2rem))]' : 'w-[min(32rem,calc(100vw-2rem))]',
          )}
        >
          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              onSubmit()
            }}
          >
            <Dialog.Title className="border-b px-5 py-4 text-lg font-semibold">{title}</Dialog.Title>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
            {error ? (
              <p data-testid={`${prefix}-error`} role="alert" className="px-5 pb-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <Button variant="outline" data-testid={`${prefix}-cancel`} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" data-testid={`${prefix}-save`} disabled={pending}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function ConfirmDialog({
  prefix,
  open,
  title,
  body,
  onCancel,
  onConfirm,
  confirmLabel,
}: {
  prefix: string
  open: boolean
  title: string
  body: string
  onCancel: () => void
  onConfirm: () => Promise<void>
  /** Rótulo do botão de confirmar (default: Excluir). */
  confirmLabel?: string
}) {
  const t = useT(NS)
  const [pending, setPending] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid={`${prefix}-confirm`}
          className="fixed top-1/2 left-1/2 z-[70] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <p className="text-sm text-muted-foreground">{body}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid={`${prefix}-confirm-cancel`} onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
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
              {confirmLabel ?? t('common.delete')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Field({
  label,
  htmlFor,
  error,
  errorTestId,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  error?: string | null
  errorTestId?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p data-testid={errorTestId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export const inputClass =
  'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'
export const textareaClass =
  'min-h-24 w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'
