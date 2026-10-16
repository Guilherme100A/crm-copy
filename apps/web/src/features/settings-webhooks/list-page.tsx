// `/settings/inbound-webhooks` (09 §2): lista com busca local por nome, status, conexão, disparos no mês, consumo
// mensal da empresa e ações (editar/excluir com confirmação).
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { connectionsQuery, WEBHOOKS_KEY, webhooksApi, webhooksQuery, type WebhookDto } from './api'

const normalize = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

export const filterWebhooks = (items: readonly WebhookDto[], q: string) => {
  const n = normalize(q.trim())
  return n ? items.filter((w) => normalize(w.name).includes(n)) : [...items]
}

export function useWebhookPerms() {
  const profile = useQuery(profileQuery()).data
  const s = profile ? sessionFrom(profile) : null
  return { canEdit: !!s && hasAny(s, ['webhooks.edit']), canDelete: !!s && hasAny(s, ['webhooks.delete']) }
}

export function WebhooksListPage() {
  const t = useT('settings-webhooks')
  const qc = useQueryClient()
  const q = useQuery(webhooksQuery())
  const conns = useQuery(connectionsQuery())
  const { canEdit, canDelete } = useWebhookPerms()
  const [search, setSearch] = useState('')
  const [deleting, setDeleting] = useState<WebhookDto | null>(null)
  const items = useMemo(() => filterWebhooks(q.data?.items ?? [], search), [q.data, search])
  const connName = (id: string | null) => (id ? (conns.data?.find((c) => c.id === id)?.name ?? t('list.connectionUnknown')) : t('list.noConnection'))
  const usage = q.data?.usage

  return (
    <section data-testid="page-inbound-webhooks" className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{t('list.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('list.subtitle')}</p>
        </div>
        {canEdit ? (
          <Link
            to="/settings/inbound-webhooks/new"
            data-testid="webhooks-new"
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-4" aria-hidden /> {t('list.new')}
          </Link>
        ) : null}
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative block w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            data-testid="webhooks-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('list.search')}
            aria-label={t('list.search')}
            className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        {usage ? (
          <div data-testid="webhooks-usage" className="flex min-w-48 flex-1 flex-col gap-1 text-xs sm:max-w-xs">
            <span className="text-muted-foreground">{t('list.usage', { used: usage.used.toLocaleString('pt-BR'), limit: usage.limit.toLocaleString('pt-BR') })}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (usage.used / Math.max(1, usage.limit)) * 100)}%` }} />
            </span>
          </div>
        ) : null}
      </div>

      {q.isPending ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : q.isError ? (
        <p className="text-sm text-destructive">{t('common.error')}</p>
      ) : items.length === 0 ? (
        <p data-testid="webhooks-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {search.trim() ? t('list.noResults') : t('list.empty')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {items.map((w) => (
            <li key={w.id} data-testid={`webhooks-item-${w.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 sm:flex-nowrap">
              <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                <Link
                  to="/settings/inbound-webhooks/$webhookId/edit"
                  params={{ webhookId: w.id }}
                  data-testid={`webhooks-item-name-${w.id}`}
                  className="block truncate font-medium hover:underline"
                >
                  {w.name}
                </Link>
                <p className="truncate text-xs text-muted-foreground">{connName(w.connection_id)}</p>
              </div>
              <span
                data-testid={`webhooks-item-status-${w.id}`}
                data-active={w.active ? 'true' : 'false'}
                className={cn('rounded-full px-2 py-0.5 text-xs font-medium', w.active ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}
              >
                {w.active ? t('status.active') : t('status.inactive')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('list.month')}{' '}
                <span data-testid={`webhooks-item-month-${w.id}`} className="font-semibold text-foreground tabular-nums">
                  {w.month_count}
                </span>
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Link
                  to="/settings/inbound-webhooks/$webhookId/edit"
                  params={{ webhookId: w.id }}
                  data-testid={`webhooks-item-edit-${w.id}`}
                  aria-label={t('list.edit')}
                  className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                >
                  <Pencil className="size-4" aria-hidden />
                </Link>
                {canDelete ? (
                  <Button variant="ghost" size="icon" className="size-8 text-destructive" data-testid={`webhooks-item-delete-${w.id}`} aria-label={t('list.delete')} onClick={() => setDeleting(w)}>
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!deleting}
        title={t('list.deleteTitle')}
        body={deleting ? t('list.deleteBody', { name: deleting.name }) : ''}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await webhooksApi.remove(deleting.id)
            await qc.invalidateQueries({ queryKey: WEBHOOKS_KEY })
          } catch {
            notify('webhooks-error', t('common.error'))
          }
          setDeleting(null)
        }}
      />
    </section>
  )
}

export function ConfirmDialog({ open, title, body, onCancel, onConfirm, children }: { open: boolean; title: string; body: string; onCancel: () => void; onConfirm: () => Promise<void>; children?: ReactNode }) {
  const t = useT('settings-webhooks')
  const [pending, setPending] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="webhooks-confirm"
          className="fixed top-1/2 left-1/2 z-[70] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <p className="text-sm text-muted-foreground">{body}</p>
          {children}
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="webhooks-confirm-cancel" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              data-testid="webhooks-confirm-ok"
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
              {t('list.delete')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
