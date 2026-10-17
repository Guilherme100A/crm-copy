// Lista de convites (16 §5 Equipe 8–9 e "Convites para Plataforma"; AC-T54-04): cards de contagem por status
// (clicáveis), filtro por status, busca, paginação e ações por convite pendente (copiar link, reenviar, cancelar).
// `kind="member"` + `compact` é a seção "Convites pendentes" da aba Equipe; `kind="platform"` é a aba própria.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Copy, RotateCw, UserPlus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, LoadError, Loading, useSession } from '@/features/settings-company/ui'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { hasAny } from '@/lib/session'
import { notify } from '@/lib/toast'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import {
  INVITATION_STATUSES,
  INVITATIONS_KEY,
  invitationsApi,
  invitationsQuery,
  type InvitationDto,
  type InvitationKind,
  type InvitationStatus,
  type PageMeta,
} from './api'
import { copyText, isEmail, MAX_RESENDS_PER_DAY, resendBlock, resendErrorKind, type ResendBlock } from './invitations'

const NS = 'settings-invitations'
const COUNT_KEYS = ['total', ...INVITATION_STATUSES] as const
const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

const pagesOf = (m: PageMeta | undefined) =>
  !m ? 1 : m.total_pages ? m.total_pages : m.total_count != null ? Math.max(1, Math.ceil(m.total_count / m.limit)) : m.page + (m.has_more ? 1 : 0)

export function InvitationsPanel({
  kind,
  compact = false,
  inviteOpen,
  onInviteClose,
}: {
  kind: InvitationKind
  /** Só pendentes, sem cards nem filtros (seção da Equipe). */
  compact?: boolean
  /** Diálogo de convite controlado por fora (botão "Convidar membro" da Equipe). */
  inviteOpen?: boolean
  onInviteClose?: () => void
}) {
  const t = useT(NS)
  const session = useSession()
  const qc = useQueryClient()
  const desktop = useIsDesktop()
  const [status, setStatus] = useState<InvitationStatus | 'all'>(compact ? 'pending' : 'all')
  const [searchText, setSearchText] = useState('')
  const search = useDebounced(searchText, 400)
  const [page, setPage] = useState(1)
  const [errors, setErrors] = useState<Record<string, ResendBlock>>({})
  /** Último link gerado por convite (fica visível na linha para copiar à mão se o navegador recusar). */
  const [links, setLinks] = useState<Record<string, string>>({})
  const [cancelling, setCancelling] = useState<InvitationDto | null>(null)
  const [ownInvite, setOwnInvite] = useState(false)
  const q = useQuery(invitationsQuery(kind, { status: status === 'all' ? undefined : status, search, page }))

  useEffect(() => setPage(1), [status, search])

  const editKey = kind === 'member' ? 'team.edit' : 'settings.platform_invitations.edit'
  const canEdit = !!session && hasAny(session, [editKey])
  const refresh = () => qc.invalidateQueries({ queryKey: [...INVITATIONS_KEY, kind] })
  const p = compact ? 'team-invitations' : 'invitations'

  if (q.error instanceof HttpError && q.error.status === 403)
    return compact ? null : (
      <div data-testid="invitations-denied" className="rounded-lg border border-dashed p-6 text-center">
        <p className="font-medium">{t('denied.title')}</p>
        <p className="text-sm text-muted-foreground">{t('denied.body')}</p>
      </div>
    )

  const copy = async (inv: InvitationDto) => {
    try {
      const link = await invitationsApi.link(inv.id)
      setLinks((l) => ({ ...l, [inv.id]: link }))
      notify('invitations-link-copied', (await copyText(link)) ? t('link.copied') : t('link.copyFailed'))
    } catch (err) {
      notify('invitations-error', err instanceof HttpError ? err.message : t('common.error'))
    }
  }

  const resend = async (inv: InvitationDto) => {
    try {
      const r = await invitationsApi.resend(inv.id)
      setErrors((e) => ({ ...e, [inv.id]: null }))
      notify('invitations-resent', t('resend.done', { n: r.invitation.resends_remaining_today }))
      await refresh()
    } catch (err) {
      const kindOf = resendErrorKind(err)
      if (kindOf) setErrors((e) => ({ ...e, [inv.id]: kindOf }))
      else notify('invitations-error', err instanceof HttpError ? err.message : t('common.error'))
      if (kindOf === 'limit') await refresh()
    }
  }

  const blockText = (b: ResendBlock) =>
    b === 'limit' ? t('resend.limit', { n: MAX_RESENDS_PER_DAY }) : b === 'cooldown' ? t('resend.cooldown') : null

  const items = q.data?.items ?? []
  const counts = q.data?.status_counts
  const dateFmt = (iso: string) => new Date(iso).toLocaleDateString()

  const rowActions = (inv: InvitationDto) => {
    if (inv.status !== 'pending' || !canEdit) return null
    const block = errors[inv.id] ?? resendBlock(inv)
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex flex-wrap justify-end gap-1">
          <Button variant="ghost" size="sm" data-testid={`invitations-copy-${inv.id}`} onClick={() => void copy(inv)}>
            <Copy aria-hidden /> {t('actions.copy')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`invitations-resend-${inv.id}`}
            disabled={resendBlock(inv) === 'limit'}
            title={blockText(block) ?? undefined}
            onClick={() => void resend(inv)}
          >
            <RotateCw aria-hidden /> {t('actions.resend')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive"
            data-testid={`invitations-cancel-${inv.id}`}
            aria-label={t('actions.cancel')}
            onClick={() => setCancelling(inv)}
          >
            <X aria-hidden />
          </Button>
        </div>
        {links[inv.id] ? (
          <input
            readOnly
            data-testid={`invitations-link-${inv.id}`}
            value={links[inv.id]}
            aria-label={t('actions.copy')}
            onFocus={(e) => e.currentTarget.select()}
            className="h-7 w-full max-w-64 min-w-0 rounded-md border bg-muted px-2 text-xs"
          />
        ) : null}
        {block ? (
          <p data-testid={`invitations-resend-error-${inv.id}`} data-reason={block} role="status" className="text-xs text-destructive">
            {blockText(block)}
          </p>
        ) : null}
      </div>
    )
  }

  const statusBadge = (s: InvitationStatus) => (
    <span
      className={cn(
        'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
        s === 'pending' && 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
        s === 'accepted' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        (s === 'declined' || s === 'expired') && 'bg-muted text-muted-foreground',
      )}
    >
      {t(`status.${s}`)}
    </span>
  )

  const list = q.isPending ? (
    <Loading />
  ) : q.isError ? (
    <LoadError testId={`${p}-error`} onRetry={() => void q.refetch()} />
  ) : items.length === 0 ? (
    <p data-testid={`${p}-empty`} className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      {compact ? t('emptyPending') : t('empty')}
    </p>
  ) : desktop ? (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table data-testid={`${p}-table`} className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground uppercase">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">{t('columns.email')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('columns.role')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('columns.status')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('columns.invitedBy')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('columns.sentAt')}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">{t('columns.actions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((inv) => (
            <tr key={inv.id} data-testid={`invitations-item-${inv.id}`} data-status={inv.status} className="align-top">
              <td className="px-3 py-2 break-all">{inv.email}</td>
              <td className="px-3 py-2">{t(`roles.${inv.role}`)}</td>
              <td className="px-3 py-2">{statusBadge(inv.status)}</td>
              <td className="px-3 py-2">{inv.invited_by?.name ?? '—'}</td>
              <td className="px-3 py-2 tabular-nums">{dateFmt(inv.created_at)}</td>
              <td className="px-3 py-1">{rowActions(inv)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <ul data-testid={`${p}-cards`} className="flex flex-col gap-2">
      {items.map((inv) => (
        <li key={inv.id} data-testid={`invitations-item-${inv.id}`} data-status={inv.status} className="flex flex-col gap-2 rounded-xl border bg-card p-3">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 font-medium break-all">{inv.email}</span>
            {statusBadge(inv.status)}
          </div>
          <p className="text-xs text-muted-foreground">
            {t(`roles.${inv.role}`)} · {inv.invited_by?.name ?? '—'} · {dateFmt(inv.created_at)}
          </p>
          {rowActions(inv)}
        </li>
      ))}
    </ul>
  )

  const pages = pagesOf(q.data?.page)

  return (
    <section data-testid={compact ? 'team-invitations' : 'invitations-settings'} className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className={compact ? 'text-base font-semibold' : 'text-xl font-semibold'}>
            {compact ? t('pendingTitle') : t('title')}
          </h2>
          {compact ? null : <p className="text-sm text-muted-foreground">{t('subtitle')}</p>}
        </div>
        {!compact && canEdit ? (
          <Button data-testid="invitations-new" onClick={() => setOwnInvite(true)}>
            <UserPlus aria-hidden /> {t('actions.invite')}
          </Button>
        ) : null}
      </header>

      {!compact ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {COUNT_KEYS.map((k) => {
              const active = (k === 'total' && status === 'all') || k === status
              return (
                <button
                  key={k}
                  type="button"
                  data-testid={`invitations-count-${k}`}
                  aria-pressed={active}
                  onClick={() => setStatus(k === 'total' ? 'all' : k)}
                  className={cn('flex flex-col items-start rounded-xl border bg-card p-3 text-left hover:bg-accent', active && 'ring-2 ring-primary')}
                >
                  <span className="text-xs text-muted-foreground">{t(`counts.${k}`)}</span>
                  <span data-testid={`invitations-count-${k}-value`} className="text-2xl font-semibold tabular-nums">
                    {counts?.[k] ?? 0}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              data-testid="invitations-search"
              type="search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder={t('filters.search')}
              aria-label={t('filters.search')}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-xs"
            />
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t('filters.status')}</span>
              <select
                data-testid="invitations-filter-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as InvitationStatus | 'all')}
                className={selectClass}
              >
                <option value="all">{t('filters.all')}</option>
                {INVITATION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`status.${s}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      ) : null}

      {list}

      {pages > 1 ? (
        <nav aria-label={t('pagination')} className="flex items-center justify-end gap-2 text-sm">
          <Button variant="outline" size="sm" data-testid={`${p}-prev`} disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('prev')}>
            <ChevronLeft aria-hidden />
          </Button>
          <span className="tabular-nums text-muted-foreground">{t('pageOf', { page, pages })}</span>
          <Button variant="outline" size="sm" data-testid={`${p}-next`} disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label={t('next')}>
            <ChevronRight aria-hidden />
          </Button>
        </nav>
      ) : null}

      <InviteDialog
        kind={kind}
        open={compact ? !!inviteOpen : ownInvite}
        onClose={() => (compact ? onInviteClose?.() : setOwnInvite(false))}
        onCreated={() => void refresh()}
      />
      <ConfirmDialog
        open={!!cancelling}
        testId="invitations-cancel-confirm"
        title={t('cancel.title')}
        body={cancelling ? t('cancel.body', { email: cancelling.email }) : ''}
        confirmLabel={t('actions.cancel')}
        onCancel={() => setCancelling(null)}
        onConfirm={async () => {
          if (!cancelling) return
          try {
            await invitationsApi.cancel(cancelling.id)
            notify('invitations-cancelled', t('cancel.done'))
            setCancelling(null)
            await refresh()
          } catch (err) {
            notify('invitations-error', err instanceof HttpError ? err.message : t('common.error'))
          }
        }}
      />
    </section>
  )
}

/** Convidar (membro ou plataforma): e-mail + papel; na plataforma mostra o link gerado com "Copiar". */
function InviteDialog({
  kind,
  open,
  onClose,
  onCreated,
}: {
  kind: InvitationKind
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const t = useT(NS)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setEmail('')
      setRole('member')
      setError(null)
      setLink(null)
    }
  }, [open])

  const submit = async () => {
    if (!isEmail(email)) return setError(t('invite.invalidEmail'))
    setPending(true)
    setError(null)
    try {
      const r = await invitationsApi.create({ kind, email: email.trim(), role })
      onCreated()
      notify('invitations-created', t('invite.sentNeutral'))
      if (kind === 'platform') setLink(r.invitation_link)
      else onClose()
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t('common.error'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="invitations-invite-dialog"
          className="fixed top-1/2 left-1/2 z-[70] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">
            {kind === 'platform' ? t('invite.titlePlatform') : t('invite.titleMember')}
          </Dialog.Title>
          {link ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{t('invite.linkGenerated')}</p>
              <div className="flex gap-2">
                <input
                  readOnly
                  data-testid="invitations-link-value"
                  value={link}
                  aria-label={t('invite.linkGenerated')}
                  className="h-9 min-w-0 flex-1 rounded-md border bg-muted px-2 text-xs"
                />
                <Button
                  variant="outline"
                  data-testid="invitations-link-copy"
                  onClick={async () => notify('invitations-link-copied', (await copyText(link)) ? t('link.copied') : t('link.copyFailed'))}
                >
                  <Copy aria-hidden /> {t('actions.copy')}
                </Button>
              </div>
              <div className="flex justify-end">
                <Button data-testid="invitations-invite-close" onClick={onClose}>
                  {t('common.close')}
                </Button>
              </div>
            </div>
          ) : (
            <form
              noValidate
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('invite.email')}</span>
                <input
                  data-testid="invitations-invite-email"
                  type="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{t('invite.role')}</span>
                <select
                  data-testid="invitations-invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
                  className={selectClass}
                >
                  <option value="member">{t('invite.roleMember')}</option>
                  <option value="admin">{t('invite.roleAdmin')}</option>
                </select>
              </label>
              {error ? (
                <p data-testid="invitations-invite-error" role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button variant="outline" data-testid="invitations-invite-cancel" disabled={pending} onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" data-testid="invitations-invite-submit" disabled={pending}>
                  {t('invite.submit')}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
