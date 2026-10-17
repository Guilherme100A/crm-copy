// `/mass-dispatches` (10 §2; permissão contacts.view; AC-T83-01): cards de visão geral (Restantes, Usados no
// ciclo, Em andamento, Concluídos), barra "Cota do ciclo", busca no cliente (nome, fluxo ou número) e tabela
// (desktop) × cartões (mobile) com status, progresso, agenda e ações. "Novo disparo" e "Cancelar" exigem
// `mass_dispatch.create`. Com disparo em andamento, lista e cota recarregam a cada 5 s (10 §5 nº 4), além do SSE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HelpCircle, Plus, Search, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { MassDispatchDraft } from '@/features/contacts/selection'
import { Pager, serverMessage } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { notify } from '@/lib/toast'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import {
  MASS_DISPATCH_KEY,
  detailKey,
  massDispatchApi,
  massDispatchListQuery,
  quotaKey,
  quotaQuery,
  type CreateResult,
  type CreateWarning,
  type MassDispatchDto,
} from './api'
import { CancelConfirm, DetailsDialog, NS, P, PreparingDialog, ProgressBar, StatusBadge, useFormat } from './dialogs'
import { canCancel, isActive, matchesSearch, overview, quotaPercent } from './logic'
import { Wizard } from './wizard'

export const ACTIVE_REFRESH_MS = 5_000

export function useMassDispatchPerms() {
  const profile = useQuery(profileQuery()).data
  const s = profile ? sessionFrom(profile) : null
  return { canManage: !!s && hasAny(s, ['mass_dispatch.create']) }
}

export function MassDispatchPage({
  draft,
  onDraftConsumed,
}: {
  /** Rascunho vindo de Contatos (abre o wizard já com o público). */
  draft: MassDispatchDraft | null
  onDraftConsumed: () => void
}) {
  const t = useT(NS)
  const qc = useQueryClient()
  const desktop = useIsDesktop()
  const fmt = useFormat()
  const { canManage } = useMassDispatchPerms()
  const [page, setPage] = useState(1)
  const [text, setText] = useState('')

  const list = useQuery({
    ...massDispatchListQuery(page),
    refetchInterval: (query) => (query.state.data?.items.some((d) => isActive(d.status)) ? ACTIVE_REFRESH_MS : false),
  })
  const items = list.data?.items ?? []
  const anyActive = items.some((d) => isActive(d.status))
  const quota = useQuery({ ...quotaQuery(), refetchInterval: anyActive ? ACTIVE_REFRESH_MS : false })

  const [wizardDraft, setWizardDraft] = useState<MassDispatchDraft | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [preparing, setPreparing] = useState<{ id: string; warnings: CreateWarning[] } | null>(null)
  const [details, setDetails] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<MassDispatchDto | null>(null)

  // Atalho de Contatos: abre o wizard com a seleção uma vez e limpa o state (recarregar não reabre).
  useEffect(() => {
    if (!draft) return
    if (canManage) {
      setWizardDraft(draft)
      setWizardOpen(true)
    }
    onDraftConsumed()
  }, [draft, canManage])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [...MASS_DISPATCH_KEY, 'list'] })
    void qc.invalidateQueries({ queryKey: quotaKey })
  }

  const cancel = useMutation({
    mutationFn: (d: MassDispatchDto) => massDispatchApi.cancel(d.id),
    onSuccess: (r) => {
      notify('mass-dispatch-cancelled', t('toast.cancelled'), t('toast.released', { n: r.released_count }))
      setCancelling(null)
    },
    onError: (err) => notify('mass-dispatch-error', t('common.error'), serverMessage(err) ?? undefined),
    onSettled: refresh,
  })

  const onCreated = (r: CreateResult) => {
    setWizardOpen(false)
    setWizardDraft(null)
    notify('mass-dispatch-created', t('toast.created'))
    qc.setQueryData(detailKey(r.mass_dispatch.id), r.mass_dispatch)
    setPreparing({ id: r.mass_dispatch.id, warnings: r.warnings ?? [] })
    refresh()
  }

  const ov = overview(items, quota.data)
  const pct = quotaPercent(quota.data)
  const term = text.trim()
  const rows = items.filter((d) => matchesSearch(d, term, fmt.name(d)))
  const noQuota = !!quota.data && quota.data.remaining <= 0

  return (
    <section data-testid="page-mass-dispatch" className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canManage ? (
          <Button
            data-testid={`${P}-new`}
            onClick={() => {
              setWizardDraft(null)
              setWizardOpen(true)
            }}
          >
            <Plus aria-hidden /> {t('new')}
          </Button>
        ) : null}
      </header>

      <div data-testid={`${P}-overview`} className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <OverviewCard id="remaining" label={t('cards.remaining')} value={ov.remaining} />
        <OverviewCard
          id="used"
          label={t('cards.used')}
          value={ov.used}
          suffix={ov.limit !== null ? ` / ${ov.limit}` : undefined}
        />
        <OverviewCard id="running" label={t('cards.running')} value={list.data ? ov.running : null} />
        <OverviewCard id="completed" label={t('cards.completed')} value={list.data ? ov.completed : null} />
      </div>

      <div data-testid={`${P}-quota`} className="flex flex-col gap-2 rounded-xl border bg-card p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t('quota.title')}</span>
          <span title={t('quota.help')} aria-label={t('quota.help')} className="text-muted-foreground">
            <HelpCircle className="size-4" aria-hidden />
          </span>
        </div>
        <div
          data-testid={`${P}-quota-bar`}
          data-percent={pct}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t('quota.title')}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn('h-full rounded-full transition-[width]', pct >= 100 ? 'bg-destructive' : 'bg-primary')}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p data-testid={`${P}-quota-text`} className="text-xs text-muted-foreground tabular-nums">
          {quota.data
            ? t('quota.text', {
                used: quota.data.used,
                limit: quota.data.limit,
                remaining: quota.data.remaining,
                slots: quota.data.billable_slots,
                rate: quota.data.per_instance_limit,
              })
            : quota.isError
              ? t('common.error')
              : '…'}
        </p>
        {noQuota ? (
          <p data-testid={`${P}-quota-exhausted`} role="status" className="text-xs font-medium text-destructive">
            {t('quota.exhausted')}
          </p>
        ) : null}
      </div>

      <label className="relative block w-full min-w-0 sm:max-w-sm">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          data-testid={`${P}-search`}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('search')}
          aria-label={t('search')}
          className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      {list.isPending ? (
        <div data-testid={`${P}-loading`} className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl border bg-muted/40" />
          ))}
        </div>
      ) : list.isError ? (
        <div data-testid={`${P}-error`} className="flex flex-wrap items-center gap-3 rounded-lg border p-4 text-sm">
          <span className="flex-1">{t('common.error')}</span>
          <Button variant="outline" size="sm" data-testid={`${P}-retry`} onClick={() => void list.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid={`${P}-empty`}
          className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"
        >
          <Send className="size-8" aria-hidden />
          <p>{term ? t('noResults') : t('empty')}</p>
        </div>
      ) : desktop ? (
        <Table rows={rows} canManage={canManage} onDetails={setDetails} onCancel={setCancelling} />
      ) : (
        <Cards rows={rows} canManage={canManage} onDetails={setDetails} onCancel={setCancelling} />
      )}
      <Pager prefix={P} meta={list.data?.page} onPage={setPage} />

      <Wizard
        open={wizardOpen}
        draft={wizardDraft}
        quota={quota.data}
        onClose={() => {
          setWizardOpen(false)
          setWizardDraft(null)
        }}
        onCreated={onCreated}
      />
      <PreparingDialog
        id={preparing?.id ?? null}
        warnings={preparing?.warnings ?? []}
        onClose={() => setPreparing(null)}
        onDetails={(id) => {
          setPreparing(null)
          setDetails(id)
        }}
      />
      <DetailsDialog id={details} canManage={canManage} onClose={() => setDetails(null)} />
      <CancelConfirm
        open={cancelling !== null}
        name={cancelling ? fmt.name(cancelling) : ''}
        pending={cancel.isPending}
        onBack={() => setCancelling(null)}
        onConfirm={() => cancelling && cancel.mutate(cancelling)}
      />
    </section>
  )
}

function OverviewCard({
  id,
  label,
  value,
  suffix,
}: {
  id: string
  label: string
  value: number | null
  suffix?: string
}) {
  return (
    <div
      data-testid={`${P}-card-${id}`}
      data-count={value ?? undefined}
      className="flex min-w-0 flex-col rounded-xl border bg-card p-3"
    >
      <span className="truncate text-xs font-medium text-muted-foreground uppercase">{label}</span>
      <span className="text-xl font-semibold tabular-nums">
        {value ?? '—'}
        {value !== null && suffix ? <span className="text-sm font-normal text-muted-foreground">{suffix}</span> : null}
      </span>
    </div>
  )
}

interface ListProps {
  rows: MassDispatchDto[]
  canManage: boolean
  onDetails: (id: string) => void
  onCancel: (d: MassDispatchDto) => void
}

function flowsOf(d: MassDispatchDto): string {
  return [...new Set(d.targets.map((x) => x.flow_name ?? '—'))].join(', ') || '—'
}

function connectionsOf(d: MassDispatchDto): string {
  return [...new Set(d.targets.map((x) => x.connection_name ?? '—'))].join(', ')
}

function Actions({ d, canManage, onDetails, onCancel }: Omit<ListProps, 'rows'> & { d: MassDispatchDto }) {
  const t = useT(NS)
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <Button variant="outline" size="sm" data-testid={`${P}-item-details-${d.id}`} onClick={() => onDetails(d.id)}>
        {t('actions.details')}
      </Button>
      {canManage && canCancel(d.status) ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          data-testid={`${P}-item-cancel-${d.id}`}
          onClick={() => onCancel(d)}
        >
          {t('actions.cancel')}
        </Button>
      ) : null}
    </div>
  )
}

function Table({ rows, canManage, onDetails, onCancel }: ListProps) {
  const t = useT(NS)
  const fmt = useFormat()
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table data-testid={`${P}-table`} className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground uppercase">
          <tr>
            {(['name', 'flow', 'status', 'progress', 'schedule'] as const).map((c) => (
              <th key={c} scope="col" className="px-3 py-2 font-medium">
                {t(`cols.${c}`)}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t('cols.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((d) => (
            <tr
              key={d.id}
              data-testid={`${P}-item-${d.id}`}
              data-status={d.status}
              className="align-middle hover:bg-muted/30"
            >
              <td className="max-w-64 px-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span data-testid={`${P}-item-name-${d.id}`} className="truncate font-medium">
                    {fmt.name(d)}
                  </span>
                  <span data-testid={`${P}-item-connection-${d.id}`} className="truncate text-xs text-muted-foreground">
                    {connectionsOf(d)}
                  </span>
                </div>
              </td>
              <td data-testid={`${P}-item-flow-${d.id}`} className="max-w-48 truncate px-3 py-2">
                {flowsOf(d)}
              </td>
              <td className="px-3 py-2">
                <StatusBadge d={d} testId={`${P}-item-status-${d.id}`} />
              </td>
              <td className="px-3 py-2">
                <ProgressBar d={d} testId={`${P}-item-progress-${d.id}`} />
              </td>
              <td data-testid={`${P}-item-schedule-${d.id}`} className="px-3 py-2 text-xs text-muted-foreground">
                {fmt.schedule(d)}
              </td>
              <td className="px-3 py-2 text-right">
                <Actions d={d} canManage={canManage} onDetails={onDetails} onCancel={onCancel} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Cards({ rows, canManage, onDetails, onCancel }: ListProps) {
  const t = useT(NS)
  const fmt = useFormat()
  return (
    <ul data-testid={`${P}-cards`} className="flex min-w-0 flex-col gap-2">
      {rows.map((d) => (
        <li
          key={d.id}
          data-testid={`${P}-item-${d.id}`}
          data-status={d.status}
          className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3"
        >
          <div className="flex min-w-0 items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <span data-testid={`${P}-item-name-${d.id}`} className="truncate font-medium">
                {fmt.name(d)}
              </span>
              <span data-testid={`${P}-item-connection-${d.id}`} className="truncate text-xs text-muted-foreground">
                {connectionsOf(d)}
              </span>
            </div>
            <StatusBadge d={d} testId={`${P}-item-status-${d.id}`} />
          </div>
          <ProgressBar d={d} testId={`${P}-item-progress-${d.id}`} />
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('cols.flow')}</dt>
            <dd data-testid={`${P}-item-flow-${d.id}`} className="min-w-0 break-words">
              {flowsOf(d)}
            </dd>
            <dt className="text-muted-foreground">{t('cols.schedule')}</dt>
            <dd data-testid={`${P}-item-schedule-${d.id}`} className="min-w-0 break-words">
              {fmt.schedule(d)}
            </dd>
          </dl>
          <Actions d={d} canManage={canManage} onDetails={onDetails} onCancel={onCancel} />
        </li>
      ))}
    </ul>
  )
}
