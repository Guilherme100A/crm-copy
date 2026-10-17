// Modal "Permissões do membro" (16 §5 Equipe 10; AC-T54-02): grupos colapsáveis com "N ativa(s)", matriz
// área × (ver, editar, excluir) das configurações com cabeçalho de coluna, dependências ao marcar, owner travado,
// seções sempre concedidas / só do proprietário e o escopo de chat (departamentos e conexões) só com `chat.view`.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Lock } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { connectionsQuery, departmentsAllQuery, scopeQuery, TEAM_KEY, teamApi, teamQuery, type MemberDto } from './api'
import {
  ACTIONS,
  activeCount,
  cellKey,
  columnChecked,
  initialSelection,
  isAlwaysGranted,
  isLocked,
  isOwnerOnly,
  PERMISSION_GROUPS,
  permissionPayload,
  roleDefaults,
  scopeEnabled,
  toggleColumn,
  toggleKey,
  type Actor,
  type PermissionGroupView,
} from './team'

const NS = 'settings-team'
const keyLabel = (key: string) => `perm.keys.${key.replace(/\./g, '_')}`

export function PermissionsModal({ member, actor, onClose }: { member: MemberDto; actor: Actor; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const locked = member.role === 'owner'
  const [selected, setSelected] = useState<Set<string>>(() => initialSelection(member))
  const [open, setOpen] = useState<Record<string, boolean>>({ settings: true })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canScope = actor.can('team.edit') && !locked
  const scope = useQuery({ ...scopeQuery(member.id), enabled: !locked })
  const depts = useQuery({ ...departmentsAllQuery(), enabled: !locked })
  const conns = useQuery({ ...connectionsQuery(), enabled: !locked && actor.can('connections.view') })
  const [deptIds, setDeptIds] = useState<string[] | null>(null)
  const [connIds, setConnIds] = useState<string[] | null>(null)

  useEffect(() => {
    if (scope.data && deptIds === null) setDeptIds(scope.data.department_ids)
    if (scope.data && connIds === null) setConnIds(scope.data.connection_ids)
  }, [scope.data, deptIds, connIds])

  const chatOn = scopeEnabled(selected)
  const set = (key: string, on: boolean) => setSelected((s) => toggleKey(s, key, on))

  const save = async () => {
    setPending(true)
    setError(null)
    try {
      const updated = await teamApi.update(member.user_id, { permission_keys: permissionPayload(member.role, selected) })
      const scopeChanged =
        canScope &&
        scope.data &&
        deptIds &&
        connIds &&
        (JSON.stringify([...deptIds].sort()) !== JSON.stringify([...scope.data.department_ids].sort()) ||
          JSON.stringify([...connIds].sort()) !== JSON.stringify([...scope.data.connection_ids].sort()))
      let department_ids = member.department_ids
      if (scopeChanged) {
        const s = await teamApi.saveScope(member.id, { department_ids: deptIds, connection_ids: connIds })
        department_ids = s.department_ids
        qc.setQueryData(scopeQuery(member.id).queryKey, s)
      }
      qc.setQueryData<MemberDto[]>(teamQuery().queryKey, (old) =>
        old?.map((x) => (x.user_id === updated.user_id ? { ...x, ...updated, department_ids } : x)),
      )
      void qc.invalidateQueries({ queryKey: [...TEAM_KEY, 'members'] })
      notify('permissions-saved', t('perm.saved'), t('perm.reloginHint'))
      onClose()
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t('common.error'))
    } finally {
      setPending(false)
    }
  }

  const checkbox = (key: string, label: string, testId: string, disabledExtra = false) => {
    const disabled = locked || isLocked(key) || disabledExtra
    return (
      <label className={cn('flex items-center gap-2 text-sm', disabled && 'opacity-70')}>
        <input
          type="checkbox"
          data-testid={testId}
          checked={locked || selected.has(key)}
          disabled={disabled}
          onChange={(e) => set(key, e.target.checked)}
          className="size-4 accent-primary"
        />
        {label}
      </label>
    )
  }

  const groupBody = (g: PermissionGroupView) => {
    if (g.areas.length === 0)
      return (
        <div className="flex flex-col gap-2">
          {g.keys.map((k) => (
            <div key={k}>{checkbox(k, t(keyLabel(k)), `permissions-key-${k}`)}</div>
          ))}
        </div>
      )
    return (
      <div className="flex flex-col gap-3">
        {checkbox('settings.view', t(keyLabel('settings.view')), 'permissions-key-settings.view')}
        <div className="overflow-x-auto">
          <table data-testid="permissions-matrix" className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-2 font-medium">{t('perm.area')}</th>
                {ACTIONS.map((a) => (
                  <th key={a} scope="col" className="px-2 py-1 text-center font-medium">
                    <label className="inline-flex flex-col items-center gap-1">
                      {t(`perm.actions.${a}`)}
                      <input
                        type="checkbox"
                        data-testid={`permissions-column-${a}`}
                        aria-label={t('perm.column', { action: t(`perm.actions.${a}`) })}
                        checked={locked || columnChecked(selected, a)}
                        disabled={locked}
                        onChange={(e) => setSelected((s) => toggleColumn(s, a, e.target.checked))}
                        className="size-4 accent-primary"
                      />
                    </label>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {g.areas.map((area) => {
                const always = isAlwaysGranted(cellKey(area, 'view'))
                const ownerOnly = isOwnerOnly(cellKey(area, 'view'))
                return (
                  <tr key={area} data-testid={`permissions-area-${area}`}>
                    <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                      <div>{t(`perm.areas.${area}`)}</div>
                      {always ? <div className="text-xs text-muted-foreground">{t('perm.alwaysGranted')}</div> : null}
                      {ownerOnly ? <div className="text-xs text-muted-foreground">{t('perm.ownerOnly')}</div> : null}
                    </th>
                    {ACTIONS.map((a) => {
                      const key = cellKey(area, a)
                      const disabled = locked || isLocked(key)
                      return (
                        <td key={a} className="px-2 py-1.5 text-center">
                          <input
                            type="checkbox"
                            data-testid={`permissions-cell-${area}-${a}`}
                            aria-label={`${t(`perm.areas.${area}`)} · ${t(`perm.actions.${a}`)}`}
                            checked={locked || selected.has(key)}
                            disabled={disabled}
                            onChange={(e) => set(key, e.target.checked)}
                            className="size-4 accent-primary"
                          />
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  const pick = (list: string[] | null, id: string, on: boolean) =>
    on ? [...new Set([...(list ?? []), id])] : (list ?? []).filter((x) => x !== id)

  const scopeBox = (
    <fieldset
      data-testid="permissions-scope"
      data-enabled={chatOn && canScope ? 'true' : 'false'}
      disabled={!chatOn || !canScope}
      className={cn('flex flex-col gap-3 rounded-lg border p-3', (!chatOn || !canScope) && 'opacity-60')}
    >
      <legend className="px-1 text-sm font-medium">{t('perm.scope.title')}</legend>
      <p className="text-xs text-muted-foreground">{chatOn ? t('perm.scope.hint') : t('perm.scope.needsChat')}</p>
      <ScopeList
        title={t('perm.scope.departments')}
        prefix="permissions-scope-department"
        items={depts.data ?? []}
        selected={deptIds ?? []}
        onToggle={(id, on) => setDeptIds((l) => pick(l, id, on))}
        empty={t('perm.scope.noDepartments')}
      />
      <ScopeList
        title={t('perm.scope.connections')}
        prefix="permissions-scope-connection"
        items={conns.data ?? []}
        selected={connIds ?? []}
        onToggle={(id, on) => setConnIds((l) => pick(l, id, on))}
        empty={t('perm.scope.noConnections')}
      />
    </fieldset>
  )

  return (
    <Dialog.Root open onOpenChange={(o) => !o && !pending && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="permissions-modal"
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background shadow-xl outline-none"
        >
          <div className="border-b px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">{t('perm.title')}</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">
              {member.user.name} · {t(`roles.${member.role}`)}
            </Dialog.Description>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
            {locked ? (
              <p
                data-testid="permissions-owner-locked"
                className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
              >
                <Lock className="size-4 shrink-0" aria-hidden /> {t('perm.ownerLocked')}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('perm.reloginHint')}</p>
            )}
            {PERMISSION_GROUPS.map((g) => {
              const expanded = open[g.key] ?? false
              const n = locked ? groupCount(g) : activeCount(g, selected)
              return (
                <section key={g.key} data-testid={`permissions-group-${g.key}`} className="rounded-lg border">
                  <button
                    type="button"
                    data-testid={`permissions-group-toggle-${g.key}`}
                    aria-expanded={expanded}
                    onClick={() => setOpen((o) => ({ ...o, [g.key]: !expanded }))}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
                  >
                    <span className="flex-1">{t(`perm.groups.${g.key}`)}</span>
                    <span data-testid={`permissions-group-count-${g.key}`} className="text-xs text-muted-foreground">
                      {t('perm.active', { n })}
                    </span>
                    <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} aria-hidden />
                  </button>
                  {expanded ? <div className="border-t px-3 py-3">{groupBody(g)}</div> : null}
                </section>
              )
            })}
            {!locked ? scopeBox : null}
          </div>
          {error ? (
            <p data-testid="permissions-error" role="alert" className="px-5 pb-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">
            {!locked ? (
              <Button
                variant="ghost"
                data-testid="permissions-reset"
                className="mr-auto"
                onClick={() => setSelected(roleDefaults(member.role))}
              >
                {t('perm.reset')}
              </Button>
            ) : null}
            <Button variant="outline" data-testid="permissions-cancel" disabled={pending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            {!locked ? (
              <Button data-testid="permissions-save" disabled={pending} onClick={() => void save()}>
                {t('common.save')}
              </Button>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const groupCount = (g: PermissionGroupView) => g.keys.length + g.areas.length * ACTIONS.length

function ScopeList({
  title,
  prefix,
  items,
  selected,
  onToggle,
  empty,
}: {
  title: string
  prefix: string
  items: { id: string; name: string }[]
  selected: string[]
  onToggle: (id: string, on: boolean) => void
  empty: string
}) {
  const t = useT(NS)
  const [q, setQ] = useState('')
  const shown = useMemo(
    () => items.filter((x) => x.name.toLowerCase().includes(q.trim().toLowerCase())),
    [items, q],
  )
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-medium">{title}</span>
        <input
          type="search"
          data-testid={`${prefix}-search`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('perm.scope.search')}
          aria-label={`${title}: ${t('perm.scope.search')}`}
          className="h-8 w-40 rounded-md border bg-background px-2 text-xs outline-none"
        />
      </div>
      {items.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : null}
      <div className="flex flex-wrap gap-2">
        {shown.map((x) => (
          <label key={x.id} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
            <input
              type="checkbox"
              data-testid={`${prefix}-${x.id}`}
              checked={selected.includes(x.id)}
              onChange={(e) => onToggle(x.id, e.target.checked)}
              className="size-3.5 accent-primary"
            />
            {x.name}
          </label>
        ))}
      </div>
    </div>
  )
}
