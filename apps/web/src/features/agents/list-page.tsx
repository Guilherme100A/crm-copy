// `/agentes` (07 §2): abas Agentes | Vozes, filtro por status (servidor), busca local por nome, cota "N de M agentes",
// "Novo agente" (limite atingido abre o modal "Limite de agentes" sem navegar) e cartões com duplicar/excluir.
// A aba Vozes aqui é só a lista; enviar amostras, ouvir e excluir vozes ficam na T92.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Bot, Copy, Mic, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { AssistedCreateButton } from '@/features/agent-lab/assisted-create'
import { VoiceActions, VoiceCreate } from '@/features/agent-voices/voices'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { AGENT_STATUSES, AGENTS_KEY, agentsApi, agentsListQuery, voicesQuery, type AgentDto } from './api'
import { filterAgents, limitReached } from './form'
import { AgentAvatar, ModalShell, StatusBadge } from './ui'

export const agentsSearchSchema = z.object({
  tab: z.enum(['agents', 'voices']).optional().catch(undefined),
  filter: z.enum(AGENT_STATUSES).optional().catch(undefined),
})
export type AgentsSearch = z.infer<typeof agentsSearchSchema>

export function useAgentPerms() {
  const profile = useQuery(profileQuery()).data
  const s = profile ? sessionFrom(profile) : null
  return { canEdit: !!s && hasAny(s, ['flows.edit']) }
}

export function AgentsListPage({ search, onSearch }: { search: AgentsSearch; onSearch: (s: AgentsSearch) => void }) {
  const t = useT('agents')
  const tab = search.tab ?? 'agents'
  return (
    <section data-testid="page-agents" className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('list.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('list.subtitle')}</p>
      </header>
      <div role="tablist" className="flex gap-1 border-b">
        {(['agents', 'voices'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-testid={`agents-tab-${id}`}
            aria-selected={tab === id}
            onClick={() => onSearch({ ...search, tab: id === 'agents' ? undefined : id })}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium',
              tab === id ? 'border-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {id === 'agents' ? <Bot className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
            {t(`tabs.${id}`)}
          </button>
        ))}
      </div>
      {tab === 'agents' ? <AgentsTab search={search} onSearch={onSearch} /> : <VoicesPanel />}
    </section>
  )
}

function AgentsTab({ search, onSearch }: { search: AgentsSearch; onSearch: (s: AgentsSearch) => void }) {
  const t = useT('agents')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { canEdit } = useAgentPerms()
  const q = useQuery(agentsListQuery(search.filter))
  const [text, setText] = useState('')
  const [limitOpen, setLimitOpen] = useState(false)
  const [deleting, setDeleting] = useState<{ agent: AgentDto; inUse: boolean } | null>(null)
  const items = useMemo(() => filterAgents(q.data?.items ?? [], text), [q.data, text])
  const quota = q.data?.quota

  const onNew = () => {
    if (limitReached(quota)) setLimitOpen(true)
    else void navigate({ to: '/agentes/novo' })
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label={t('list.filter')} className="flex flex-wrap gap-1 rounded-lg border p-1">
          {(['all', ...AGENT_STATUSES] as const).map((f) => {
            const on = (search.filter ?? 'all') === f
            return (
              <button
                key={f}
                type="button"
                data-testid={`agents-filter-${f}`}
                aria-pressed={on}
                onClick={() => onSearch({ ...search, filter: f === 'all' ? undefined : f })}
                className={cn(
                  'rounded-md px-3 py-1 text-sm',
                  on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {t(`filters.${f}`)}
              </button>
            )
          })}
        </div>
        <label className="relative block w-full min-w-0 sm:w-64">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            data-testid="agents-search"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('list.search')}
            aria-label={t('list.search')}
            className="h-9 w-full rounded-md border bg-background pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {quota ? (
            <span
              data-testid="agents-quota"
              className={cn(
                'text-sm tabular-nums',
                limitReached(quota) ? 'font-medium text-destructive' : 'text-muted-foreground',
              )}
            >
              {quota.limit === null
                ? t('list.quotaUnlimited', { used: quota.used })
                : t('list.quota', { used: quota.used, limit: quota.limit })}
            </span>
          ) : null}
          {/* T92: criação assistida. */}
          {canEdit ? <AssistedCreateButton /> : null}
          {canEdit ? (
            <Button data-testid="agents-new" onClick={onNew}>
              <Plus aria-hidden /> {t('list.new')}
            </Button>
          ) : null}
        </div>
      </div>

      {q.isPending ? (
        <div data-testid="agents-loading" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl border bg-muted/40" />
          ))}
        </div>
      ) : q.isError ? (
        <div data-testid="agents-error" className="flex flex-wrap items-center gap-3 rounded-lg border p-4 text-sm">
          <span className="flex-1">{t('common.error')}</span>
          <Button variant="outline" size="sm" data-testid="agents-retry" onClick={() => void q.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div
          data-testid="agents-empty"
          className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"
        >
          <Bot className="size-8" aria-hidden />
          <p>{text.trim() || search.filter ? t('list.noResults') : t('list.empty')}</p>
          {!text.trim() && !search.filter && canEdit ? (
            <Button variant="outline" size="sm" data-testid="agents-empty-new" onClick={onNew}>
              {t('list.createFirst')}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((a) => (
            <li
              key={a.id}
              data-testid={`agents-card-${a.id}`}
              data-status={a.status}
              className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4"
            >
              <div className="flex min-w-0 items-start gap-3">
                <AgentAvatar name={a.name} avatarKey={a.avatar_key} avatarUrl={a.avatar_url} />
                <div className="min-w-0 flex-1">
                  <Link
                    to="/agentes/$agentId"
                    params={{ agentId: a.id }}
                    data-testid={`agents-open-${a.id}`}
                    className="block truncate font-semibold hover:underline"
                  >
                    {a.name}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">{a.role || t(`goals.${a.primary_goal}`)}</p>
                </div>
                <StatusBadge status={a.status} />
              </div>
              <p className="text-xs text-muted-foreground">{t('list.skills', { n: a.skills_count })}</p>
              {canEdit ? (
                <div className="mt-auto flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`agents-duplicate-${a.id}`}
                    onClick={async () => {
                      if (limitReached(quota)) return setLimitOpen(true)
                      try {
                        await agentsApi.duplicate(a.id)
                        await qc.invalidateQueries({ queryKey: [...AGENTS_KEY, 'list'] })
                      } catch (err) {
                        if (err instanceof HttpError && err.code === 'LIMIT_REACHED') setLimitOpen(true)
                        else notify('agents-error', t('common.error'))
                      }
                    }}
                  >
                    <Copy aria-hidden /> <span className="max-sm:sr-only">{t('list.duplicate')}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    data-testid={`agents-delete-${a.id}`}
                    onClick={() => setDeleting({ agent: a, inUse: false })}
                  >
                    <Trash2 aria-hidden /> <span className="max-sm:sr-only">{t('list.delete')}</span>
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <ModalShell
        open={limitOpen}
        onClose={() => setLimitOpen(false)}
        testId="agents-limit-modal"
        title={t('limit.title')}
      >
        <p className="text-sm text-muted-foreground">
          {quota?.limit !== null && quota ? t('limit.body', { limit: quota.limit }) : t('limit.bodyGeneric')}
        </p>
        <div className="flex justify-end">
          <Button data-testid="agents-limit-close" onClick={() => setLimitOpen(false)}>
            {t('common.ok')}
          </Button>
        </div>
      </ModalShell>

      <ModalShell
        open={!!deleting}
        onClose={() => setDeleting(null)}
        testId="agents-delete-dialog"
        title={t('delete.title')}
      >
        <p className="text-sm text-muted-foreground">
          {deleting ? t(deleting.inUse ? 'delete.inUse' : 'delete.body', { name: deleting.agent.name }) : ''}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" data-testid="agents-delete-cancel" onClick={() => setDeleting(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="agents-delete-confirm"
            onClick={async () => {
              if (!deleting) return
              try {
                await agentsApi.remove(deleting.agent.id, deleting.inUse)
                setDeleting(null)
                await qc.invalidateQueries({ queryKey: [...AGENTS_KEY, 'list'] })
              } catch (err) {
                // Em uso por fluxos/conversas (409): avisa e pede a confirmação de novo, agora forçando.
                if (err instanceof HttpError && err.code === 'CONFLICT') setDeleting({ ...deleting, inUse: true })
                else notify('agents-error', t('common.error'))
              }
            }}
          >
            {t('list.delete')}
          </Button>
        </div>
      </ModalShell>
    </div>
  )
}

function VoicesPanel() {
  const t = useT('agents')
  const q = useQuery(voicesQuery())
  const voices = q.data ?? []
  const { canEdit } = useAgentPerms()
  return (
    <div data-testid="agents-voices-panel" className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('voices.hint')}</p>
      {/* T92: enviar amostras; prévia, manter e excluir em cada voz. */}
      {canEdit ? <VoiceCreate /> : null}
      {q.isPending ? (
        <div className="h-24 animate-pulse rounded-xl border bg-muted/40" aria-busy />
      ) : voices.length === 0 ? (
        <p
          data-testid="agents-voices-empty"
          className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground"
        >
          {t('voices.empty')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {voices.map((v) => (
            <li
              key={v.id}
              data-testid={`agents-voice-${v.id}`}
              data-status={v.status}
              className="flex min-w-0 items-center gap-3 p-3"
            >
              <Mic className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{v.name}</span>
              <span className="text-xs text-muted-foreground uppercase">{v.language}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {t(v.status === 'kept' ? 'voices.kept' : 'voices.pending')}
              </span>
              {canEdit ? <VoiceActions voice={v} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
