// Aba `team` do hub (16 §2.1, §3.4, §5 Equipe): lista de membros com busca e filtros de papel e departamento
// ("Sem departamento"), ordem owner < admin < member, menu por membro (permissões, papel, transferir, remover),
// convite de membro e convites pendentes. 403 em `GET /api/team` → "Acesso negado" (AC-T54-01).
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Crown, KeyRound, Trash2, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CompanyRole } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, LoadError, Loading, useSession } from '@/features/settings-company/ui'
import { InvitationsPanel } from '@/features/settings-invitations/panel'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { hasAny, profileQueryKey } from '@/lib/session'
import { notify } from '@/lib/toast'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { departmentsAllQuery, TEAM_KEY, teamApi, teamQuery, type DepartmentDto, type MemberDto } from './api'
import { PermissionsModal } from './permissions-modal'
import { filterMembers, memberActions, ROLE_FILTERS, type Actor, type DepartmentFilter, type RoleFilter } from './team'
import { TransferDialog } from './transfer-dialog'

const NS = 'settings-team'
const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'

export default function TeamTab() {
  const t = useT(NS)
  const session = useSession()
  const qc = useQueryClient()
  const desktop = useIsDesktop()
  const team = useQuery(teamQuery())
  const depts = useQuery(departmentsAllQuery())
  const [role, setRole] = useState<RoleFilter>('all')
  const [department, setDepartment] = useState<DepartmentFilter>('all')
  const [search, setSearch] = useState('')
  const [permsOf, setPermsOf] = useState<MemberDto | null>(null)
  const [transferTo, setTransferTo] = useState<MemberDto | null>(null)
  const [removing, setRemoving] = useState<MemberDto | null>(null)
  const [inviting, setInviting] = useState(false)

  const roleLabel = (r: CompanyRole) => t(`roles.${r}`)
  const rows = useMemo(
    () => filterMembers(team.data ?? [], { role, department, search, roleLabel: (r) => t(`roles.${r}`) }),
    [team.data, role, department, search, t],
  )
  const deptById = useMemo(() => new Map((depts.data ?? []).map((d) => [d.id, d])), [depts.data])

  if (!session) return <Loading />
  const denied =
    (team.error instanceof HttpError && team.error.status === 403) || !hasAny(session, ['team.view'])
  if (denied)
    return (
      <div data-testid="team-denied" className="rounded-lg border border-dashed p-6 text-center">
        <p className="font-medium">{t('denied.title')}</p>
        <p className="text-sm text-muted-foreground">{t('denied.body')}</p>
      </div>
    )

  const actor: Actor = {
    userId: session.user.id,
    role: session.role,
    isOwner: session.isOwner,
    can: (k) => hasAny(session, [k]),
  }
  const refresh = () => qc.invalidateQueries({ queryKey: [...TEAM_KEY, 'members'] })

  const changeRole = async (m: MemberDto, next: 'admin' | 'member') => {
    try {
      const updated = await teamApi.update(m.user_id, { role: next })
      qc.setQueryData<MemberDto[]>(teamQuery().queryKey, (old) =>
        old?.map((x) => (x.user_id === updated.user_id ? { ...x, ...updated } : x)),
      )
      notify('team-role-changed', t('role.changed'), t('role.warning'))
    } catch (err) {
      notify('team-error', err instanceof HttpError ? err.message : t('common.error'))
    }
  }

  const deptNames = (m: MemberDto) => {
    const list = (m.department_ids ?? []).map((id) => deptById.get(id)).filter((d): d is DepartmentDto => !!d)
    if (list.length === 0) return <span className="text-muted-foreground">{t('departments.none')}</span>
    return (
      <span className="flex flex-wrap gap-1">
        {list.map((d) => (
          <span key={d.id} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
            <span className="size-2 rounded-full" style={{ backgroundColor: d.color }} aria-hidden />
            {d.name}
          </span>
        ))}
      </span>
    )
  }

  const roleCell = (m: MemberDto) => {
    const a = memberActions(actor, m)
    if (a.changeRole && m.user_id !== actor.userId)
      return (
        <select
          data-testid={`team-role-select-${m.user_id}`}
          aria-label={t('role.label')}
          value={m.role}
          onChange={(e) => void changeRole(m, e.target.value as 'admin' | 'member')}
          className={selectClass}
        >
          <option value="admin">{roleLabel('admin')}</option>
          <option value="member">{roleLabel('member')}</option>
        </select>
      )
    return (
      <span
        data-testid={`team-item-role-${m.user_id}`}
        data-role={m.role}
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
          m.role === 'owner' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-muted',
        )}
      >
        {m.role === 'owner' ? <Crown className="size-3" aria-hidden /> : null}
        {roleLabel(m.role)}
      </span>
    )
  }

  const actions = (m: MemberDto) => {
    const a = memberActions(actor, m)
    return (
      <div className="flex flex-wrap items-center justify-end gap-1">
        {a.permissions ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid={`team-permissions-${m.user_id}`}
            onClick={() => setPermsOf(m)}
          >
            <KeyRound aria-hidden /> {t('actions.permissions')}
          </Button>
        ) : null}
        {a.transfer ? (
          <Button variant="ghost" size="sm" data-testid={`team-transfer-${m.user_id}`} onClick={() => setTransferTo(m)}>
            <Crown aria-hidden /> {t('actions.transfer')}
          </Button>
        ) : null}
        {a.remove ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive"
            data-testid={`team-remove-${m.user_id}`}
            aria-label={t('actions.remove')}
            onClick={() => setRemoving(m)}
          >
            <Trash2 aria-hidden />
          </Button>
        ) : null}
      </div>
    )
  }

  // O papel aparece como texto (testid `team-item-role-*`) também quando há o select, para o Tester ler a troca.
  const roleBadge = (m: MemberDto) =>
    memberActions(actor, m).changeRole && m.user_id !== actor.userId ? (
      <span data-testid={`team-item-role-${m.user_id}`} data-role={m.role} className="sr-only">
        {roleLabel(m.role)}
      </span>
    ) : null

  const canInvite = hasAny(session, ['team.edit'])

  return (
    <section data-testid="team-settings" className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{t('title')}</h2>
          <p data-testid="team-count" className="text-sm text-muted-foreground">
            {t('count', { n: team.data?.length ?? 0 })}
          </p>
        </div>
        {canInvite ? (
          <Button data-testid="team-invite" onClick={() => setInviting(true)}>
            <UserPlus aria-hidden /> {t('actions.invite')}
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <input
          data-testid="team-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('filters.search')}
          aria-label={t('filters.search')}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-xs"
        />
        <select
          data-testid="team-filter-role"
          aria-label={t('filters.role')}
          value={role}
          onChange={(e) => setRole(e.target.value as RoleFilter)}
          className={selectClass}
        >
          {ROLE_FILTERS.map((r) => (
            <option key={r} value={r}>
              {r === 'all' ? t('filters.allRoles') : roleLabel(r)}
            </option>
          ))}
        </select>
        <select
          data-testid="team-filter-department"
          aria-label={t('filters.department')}
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          className={selectClass}
        >
          <option value="all">{t('filters.allDepartments')}</option>
          <option value="none">{t('departments.none')}</option>
          {(depts.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {team.isPending ? (
        <Loading />
      ) : team.isError ? (
        <LoadError testId="team-error" onRetry={() => void team.refetch()} />
      ) : rows.length === 0 ? (
        <p data-testid="team-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : desktop ? (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table data-testid="team-table" className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{t('columns.member')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('columns.role')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('columns.department')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('columns.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((m) => (
                <tr key={m.id} data-testid={`team-item-${m.user_id}`} className="align-middle hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <div className="font-medium">{m.user.name}</div>
                    <div className="text-xs text-muted-foreground">{m.user.email}</div>
                  </td>
                  <td className="px-3 py-2">
                    {roleCell(m)}
                    {roleBadge(m)}
                  </td>
                  <td className="px-3 py-2">{deptNames(m)}</td>
                  <td className="px-3 py-1">{actions(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul data-testid="team-cards" className="flex flex-col gap-2">
          {rows.map((m) => (
            <li key={m.id} data-testid={`team-item-${m.user_id}`} className="flex flex-col gap-2 rounded-xl border bg-card p-3">
              <div className="min-w-0">
                <div className="font-medium break-words">{m.user.name}</div>
                <div className="text-xs break-all text-muted-foreground">{m.user.email}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {roleCell(m)}
                {roleBadge(m)}
                {deptNames(m)}
              </div>
              {actions(m)}
            </li>
          ))}
        </ul>
      )}

      <InvitationsPanel kind="member" compact inviteOpen={inviting} onInviteClose={() => setInviting(false)} />

      {permsOf ? <PermissionsModal member={permsOf} actor={actor} onClose={() => setPermsOf(null)} /> : null}
      {transferTo ? (
        <TransferDialog
          member={transferTo}
          onClose={() => setTransferTo(null)}
          onDone={async (r) => {
            qc.setQueryData<MemberDto[]>(teamQuery().queryKey, (old) =>
              old?.map((x) =>
                x.user_id === r.owner.user_id
                  ? { ...x, ...r.owner }
                  : x.user_id === r.previous_owner.user_id
                    ? { ...x, ...r.previous_owner }
                    : x,
              ),
            )
            setTransferTo(null)
            notify('team-transferred', t('transfer.done'))
            // O ator deixou de ser owner: o perfil (papel e permissões) muda.
            await qc.invalidateQueries({ queryKey: profileQueryKey })
            void refresh()
          }}
        />
      ) : null}
      <ConfirmDialog
        open={!!removing}
        testId="team-remove-confirm"
        title={t('remove.title')}
        body={removing ? t('remove.body', { name: removing.user.name }) : ''}
        confirmLabel={t('actions.remove')}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return
          try {
            await teamApi.remove(removing.user_id)
            qc.setQueryData<MemberDto[]>(teamQuery().queryKey, (old) => old?.filter((x) => x.user_id !== removing.user_id))
            notify('team-removed', t('remove.done'))
            setRemoving(null)
          } catch (err) {
            notify('team-error', err instanceof HttpError ? err.message : t('common.error'))
          }
        }}
      />
    </section>
  )
}
