// `/connections` (08 §2; permissão connections.view): cards de contagem por status, busca, filtro de status, tabela
// (desktop) × cartões (mobile) com status, selos de aquecimento/saúde, criada em, desconectada em e o menu de ações.
// "Nova conexão" respeita o limite da empresa (AC-T71-05). Modo extensão: "Importar chips do ai-manager" e, nas
// conexões importadas, "Desvincular" no lugar de "Excluir". Os modais ficam em `dialogs.tsx`.
import { Menu } from '@base-ui/react/menu'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, MoreVertical, Plug, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Pager, serverMessage, useDebounced } from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { notify } from '@/lib/toast'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import {
  CONNECTION_STATUSES,
  CONNECTIONS_KEY,
  connectionsApi,
  connectionsListQuery,
  type ConnectionDto,
  type ConnectionStatus,
} from './api'
import {
  ConnectDialog,
  ImportDialog,
  InstanceDialog,
  NameDialog,
  PausedFlowsDialog,
  ProxyDialog,
  StopFlowsDialog,
} from './dialogs'
import {
  actionsFor,
  isImported,
  limitReached,
  slotsLeft,
  type ConnectionAction,
  type ConnectionPerms,
  type ConnectionsSearch,
} from './logic'
import { connectionsUi, useConnectionsUi } from './realtime'

const NS = 'connections'
const P = 'connections'

export function useConnectionPerms(): ConnectionPerms {
  const profile = useQuery(profileQuery()).data
  const s = profile ? sessionFrom(profile) : null
  return {
    canEdit: !!s && hasAny(s, ['connections.edit']),
    canDelete: !!s && hasAny(s, ['connections.delete']),
    canRunFlows: !!s && hasAny(s, ['flows.run']),
  }
}

const STATUS_TONE: Record<ConnectionStatus, string> = {
  connected: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  connecting: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  pending: 'bg-muted text-muted-foreground',
  paused: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  disconnected: 'bg-red-500/15 text-red-700 dark:text-red-300',
  banned: 'bg-red-700/20 text-red-800 dark:text-red-200',
}

function useDate() {
  const { locale } = useI18n()
  return (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '—'
}

export function ConnectionsPage({
  search,
  onSearch,
}: {
  search: ConnectionsSearch
  onSearch: (s: ConnectionsSearch) => void
}) {
  const t = useT(NS)
  const qc = useQueryClient()
  const desktop = useIsDesktop()
  const perms = useConnectionPerms()
  const [text, setText] = useState(search.search ?? '')
  const term = useDebounced(text.trim())
  useEffect(() => {
    if ((search.search ?? '') !== term) onSearch({ ...search, search: term || undefined, page: undefined })
  }, [term])
  const q = useQuery(connectionsListQuery({ search: search.search, status: search.filter, page: search.page }))
  const ui = useConnectionsUi()

  const [naming, setNaming] = useState<ConnectionDto | 'new' | null>(null)
  const [connecting, setConnecting] = useState<ConnectionDto | null>(null)
  const [proxy, setProxy] = useState<ConnectionDto | null>(null)
  const [instance, setInstance] = useState<ConnectionDto | null>(null)
  const [stopping, setStopping] = useState<ConnectionDto | null>(null)
  const [deleting, setDeleting] = useState<ConnectionDto | null>(null)
  const [unlinking, setUnlinking] = useState<ConnectionDto | null>(null)
  const [importing, setImporting] = useState(false)
  const [pausedFromMenu, setPausedFromMenu] = useState<ConnectionDto | null>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: [...CONNECTIONS_KEY, 'list'] })
  const quick = useMutation({
    mutationFn: ({ action, c }: { action: 'resume' | 'disconnect' | 'restart'; c: ConnectionDto }) =>
      action === 'resume'
        ? connectionsApi.connect(c.id)
        : action === 'disconnect'
          ? connectionsApi.disconnect(c.id)
          : connectionsApi.restart(c.id),
    onSuccess: (_r, v) => notify(`connections-${v.action}-ok`, t(`toast.${v.action}`, { name: v.c.name })),
    onError: (err) => notify('connections-action-error', t('common.error'), serverMessage(err) ?? undefined),
    onSettled: () => void refresh(),
  })

  const onAction = (action: ConnectionAction, c: ConnectionDto) => {
    if (action === 'connect') setConnecting(c)
    else if (action === 'resume' || action === 'disconnect' || action === 'restart') quick.mutate({ action, c })
    else if (action === 'rename') setNaming(c)
    else if (action === 'proxy') setProxy(c)
    else if (action === 'instance') setInstance(c)
    else if (action === 'stop-flows') setStopping(c)
    else if (action === 'paused-flows') setPausedFromMenu(c)
    else if (action === 'delete') setDeleting(c)
    else if (action === 'unlink') setUnlinking(c)
  }

  const data = q.data
  const limits = data?.limits
  const blocked = limitReached(limits)
  const counts = data?.status_counts
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0
  const rows = data?.items ?? []
  const filtered = !!(search.search || search.filter)
  const canImport = perms.canEdit && !!data?.features?.import_ai_manager
  const importButton = canImport ? (
    <Button
      variant="outline"
      data-testid="connections-import-open"
      disabled={blocked}
      data-disabled-reason={blocked ? 'limit_reached' : undefined}
      onClick={() => setImporting(true)}
    >
      <Download aria-hidden /> {t('import.open')}
    </Button>
  ) : null

  const pausedTarget = ui.pausedPrompt
    ? { connection_id: ui.pausedPrompt.connection_id, name: ui.pausedPrompt.name, counts: ui.pausedPrompt }
    : pausedFromMenu
      ? { connection_id: pausedFromMenu.id, name: pausedFromMenu.name }
      : null

  return (
    <section data-testid="page-connections" className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {perms.canEdit ? (
          <div className="flex min-w-0 flex-col items-end gap-1">
            <div className="flex flex-wrap justify-end gap-2">
              {importButton}
              <Button
                data-testid="connections-new"
                disabled={blocked}
                data-disabled-reason={blocked ? 'limit_reached' : undefined}
                aria-describedby={blocked ? 'connections-limit-reason' : undefined}
                onClick={() => setNaming('new')}
              >
                <Plus aria-hidden /> {t('new')}
              </Button>
            </div>
            {limits ? (
              <span
                data-testid="connections-usage"
                className={cn(
                  'text-xs tabular-nums',
                  blocked ? 'font-medium text-destructive' : 'text-muted-foreground',
                )}
              >
                {limits.connections === null
                  ? t('limit.unlimited', { used: limits.used })
                  : t('limit.usage', { used: limits.used, limit: limits.connections })}
              </span>
            ) : null}
          </div>
        ) : null}
      </header>
      {perms.canEdit && blocked && limits ? (
        <p
          id="connections-limit-reason"
          data-testid="connections-limit-reason"
          role="status"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          {t('limit.reached', { limit: limits.connections ?? 0, used: limits.used })}
        </p>
      ) : null}

      <div data-testid="connections-counts" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <CountCard
          id="total"
          label={t('counts.total')}
          value={counts ? total : null}
          active={!search.filter}
          onClick={() => onSearch({ ...search, filter: undefined, page: undefined })}
        />
        {CONNECTION_STATUSES.map((s) => (
          <CountCard
            key={s}
            id={s}
            label={t(`status.${s}`)}
            value={counts ? (counts[s] ?? 0) : null}
            active={search.filter === s}
            onClick={() => onSearch({ ...search, filter: search.filter === s ? undefined : s, page: undefined })}
          />
        ))}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <label className="relative block w-full min-w-0 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            data-testid="connections-search"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('search')}
            aria-label={t('search')}
            className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <select
          data-testid="connections-status-filter"
          aria-label={t('filter')}
          value={search.filter ?? ''}
          onChange={(e) =>
            onSearch({
              ...search,
              filter: (e.target.value || undefined) as ConnectionStatus | undefined,
              page: undefined,
            })
          }
          className="h-9 w-full rounded-md border bg-background px-3 text-sm sm:w-56"
        >
          <option value="">{t('allStatuses')}</option>
          {CONNECTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
      </div>

      {q.isPending ? (
        <div data-testid="connections-loading" className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl border bg-muted/40" />
          ))}
        </div>
      ) : q.isError ? (
        <div
          data-testid="connections-error"
          className="flex flex-wrap items-center gap-3 rounded-lg border p-4 text-sm"
        >
          <span className="flex-1">{t('common.error')}</span>
          <Button variant="outline" size="sm" data-testid="connections-retry" onClick={() => void q.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid="connections-empty"
          className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"
        >
          <Plug className="size-8" aria-hidden />
          <p>{filtered ? t('noResults') : t('empty')}</p>
          {!filtered && perms.canEdit && !blocked ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" size="sm" data-testid="connections-empty-new" onClick={() => setNaming('new')}>
                {t('createFirst')}
              </Button>
              {canImport ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="connections-empty-import"
                  onClick={() => setImporting(true)}
                >
                  <Download aria-hidden /> {t('import.open')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : desktop ? (
        <ConnectionsTable rows={rows} perms={perms} onAction={onAction} />
      ) : (
        <ConnectionsCards rows={rows} perms={perms} onAction={onAction} />
      )}
      <Pager
        prefix={P}
        meta={data?.page}
        onPage={(page) => onSearch({ ...search, page: page > 1 ? page : undefined })}
      />

      <NameDialog editing={naming} onClose={() => setNaming(null)} />
      <ImportDialog open={importing} slotsLeft={slotsLeft(limits)} onClose={() => setImporting(false)} />
      <ConnectDialog connection={connecting} onClose={() => setConnecting(null)} />
      <ProxyDialog connection={proxy} onClose={() => setProxy(null)} />
      <InstanceDialog connection={instance} onClose={() => setInstance(null)} />
      <StopFlowsDialog connection={stopping} onClose={() => setStopping(null)} />
      <PausedFlowsDialog
        target={pausedTarget}
        canRunFlows={perms.canRunFlows}
        onClose={() => {
          connectionsUi.closePausedPrompt()
          setPausedFromMenu(null)
        }}
      />
      <ConfirmDialog
        prefix="connections-delete"
        open={deleting !== null}
        title={t('delete.title', { name: deleting?.name ?? '' })}
        body={t('delete.body')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await connectionsApi.scheduleDeletion(deleting!.id)
            notify('connections-deleted', t('toast.deletionScheduled'))
            setDeleting(null)
            await refresh()
          } catch (err) {
            notify('connections-action-error', t('common.error'), serverMessage(err) ?? undefined)
          }
        }}
      />
      <ConfirmDialog
        prefix="connections-unlink"
        open={unlinking !== null}
        title={t('unlink.title', { name: unlinking?.name ?? '' })}
        body={t('unlink.body')}
        confirmLabel={t('unlink.confirm')}
        onCancel={() => setUnlinking(null)}
        onConfirm={async () => {
          try {
            await connectionsApi.unlink(unlinking!.id)
            notify('connections-unlinked', t('toast.unlinked', { name: unlinking!.name }))
            setUnlinking(null)
            await refresh()
          } catch (err) {
            notify('connections-action-error', t('common.error'), serverMessage(err) ?? undefined)
          }
        }}
      />
    </section>
  )
}

function CountCard({
  id,
  label,
  value,
  active,
  onClick,
}: {
  id: string
  label: string
  value: number | null
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={`connections-count-${id}`}
      data-count={value ?? undefined}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-col items-start rounded-xl border bg-card p-3 text-left',
        active && 'border-primary ring-1 ring-primary',
      )}
    >
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value ?? '—'}</span>
    </button>
  )
}

function StatusCell({ c }: { c: ConnectionDto }) {
  const t = useT(NS)
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span
        data-testid={`${P}-item-status-${c.id}`}
        data-status={c.status}
        className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[c.status])}
      >
        {t(`status.${c.status}`)}
      </span>
      {c.badges.map((b) => (
        <span
          key={b}
          data-testid={`${P}-item-badge-${b}-${c.id}`}
          data-badge={b}
          className={cn(
            'rounded-full border px-2 py-0.5 text-xs',
            b === 'degraded' || b === 'scheduled_deletion'
              ? 'border-destructive/40 text-destructive'
              : 'text-muted-foreground',
          )}
        >
          {t(`badges.${b}`)}
        </span>
      ))}
      {isImported(c) ? (
        <span
          data-testid={`${P}-item-badge-ai-manager-${c.id}`}
          title={t('badges.aiManagerHint')}
          className="rounded-full border border-primary/40 px-2 py-0.5 text-xs text-primary"
        >
          {t('badges.ai_manager')}
        </span>
      ) : null}
      {c.proxy ? (
        <span
          data-testid={`${P}-item-badge-proxy-${c.id}`}
          className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
        >
          {t('badges.proxy')}
        </span>
      ) : null}
    </div>
  )
}

function NameCell({ c }: { c: ConnectionDto }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span data-testid={`${P}-item-name-${c.id}`} className="truncate font-medium">
        {c.name}
      </span>
      <span data-testid={`${P}-item-phone-${c.id}`} className="truncate text-xs text-muted-foreground">
        {c.phone_number ?? '—'}
      </span>
    </div>
  )
}

function ActionsMenu({
  c,
  perms,
  onAction,
}: {
  c: ConnectionDto
  perms: ConnectionPerms
  onAction: (a: ConnectionAction, c: ConnectionDto) => void
}) {
  const t = useT(NS)
  const actions = actionsFor(c, perms)
  if (!actions.length) return null
  const itemClass =
    'flex w-full cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent'
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid={`${P}-item-actions-${c.id}`}
        aria-label={t('actions.menu', { name: c.name })}
        className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreVertical className="size-4" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup
            data-testid={`${P}-actions-menu`}
            className="min-w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
          >
            {actions.map((a) => (
              <Menu.Item
                key={a}
                data-testid={`${P}-action-${a}-${c.id}`}
                onClick={() => onAction(a, c)}
                className={cn(
                  itemClass,
                  (a === 'delete' || a === 'stop-flows' || a === 'unlink') && 'text-destructive',
                )}
              >
                {t(`actions.${a}`)}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

interface ListProps {
  rows: ConnectionDto[]
  perms: ConnectionPerms
  onAction: (a: ConnectionAction, c: ConnectionDto) => void
}

function ConnectionsTable({ rows, perms, onAction }: ListProps) {
  const t = useT(NS)
  const date = useDate()
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table data-testid={`${P}-table`} className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground uppercase">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('cols.connection')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('cols.status')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('cols.createdAt')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('cols.disconnectedAt')}
            </th>
            <th scope="col" className="w-16 px-3 py-2 text-right font-medium">
              {t('cols.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((c) => (
            <tr
              key={c.id}
              data-testid={`${P}-item-${c.id}`}
              data-status={c.status}
              className="align-middle hover:bg-muted/30"
            >
              <td className="max-w-64 px-3 py-2">
                <NameCell c={c} />
              </td>
              <td className="px-3 py-2">
                <StatusCell c={c} />
              </td>
              <td
                data-testid={`${P}-item-created-${c.id}`}
                className="px-3 py-2 whitespace-nowrap text-muted-foreground"
              >
                {date(c.created_at)}
              </td>
              <td
                data-testid={`${P}-item-disconnected-${c.id}`}
                className="px-3 py-2 whitespace-nowrap text-muted-foreground"
              >
                {date(c.disconnected_at)}
              </td>
              <td className="px-3 py-1 text-right">
                <ActionsMenu c={c} perms={perms} onAction={onAction} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ConnectionsCards({ rows, perms, onAction }: ListProps) {
  const t = useT(NS)
  const date = useDate()
  return (
    <ul data-testid={`${P}-cards`} className="flex min-w-0 flex-col gap-2">
      {rows.map((c) => (
        <li
          key={c.id}
          data-testid={`${P}-item-${c.id}`}
          data-status={c.status}
          className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3"
        >
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <NameCell c={c} />
            </div>
            <ActionsMenu c={c} perms={perms} onAction={onAction} />
          </div>
          <StatusCell c={c} />
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('cols.createdAt')}</dt>
            <dd data-testid={`${P}-item-created-${c.id}`} className="min-w-0 break-words">
              {date(c.created_at)}
            </dd>
            <dt className="text-muted-foreground">{t('cols.disconnectedAt')}</dt>
            <dd data-testid={`${P}-item-disconnected-${c.id}`} className="min-w-0 break-words">
              {date(c.disconnected_at)}
            </dd>
          </dl>
        </li>
      ))}
    </ul>
  )
}
