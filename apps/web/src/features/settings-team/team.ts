// Regras puras da aba Equipe (16 §5 Equipe, §8): filtros e ordem da lista, quem pode o quê e a matriz do modal de
// permissões. As dependências entre chaves vêm de `@crm/shared` (`normalizePermissions`/`revokePermission`).
import {
  ALWAYS_GRANTED_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  PERMISSION_CATALOG,
  SETTINGS_AREAS,
  normalizePermissions,
  revokePermission,
  type CompanyRole,
} from '@crm/shared'
import type { MemberDto } from './api'

export const ROLE_ORDER: Record<CompanyRole, number> = { owner: 0, admin: 1, member: 2 }
export const ROLE_FILTERS = ['all', 'owner', 'admin', 'member'] as const
export type RoleFilter = (typeof ROLE_FILTERS)[number]
/** `all`, `none` ("Sem departamento") ou o id do departamento. */
export type DepartmentFilter = 'all' | 'none' | (string & {})

const fold = (v: string) =>
  v
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** owner < admin < member, depois por nome (a API já manda assim; a ordem não depende dela). */
export function sortMembers(list: readonly MemberDto[]): MemberDto[] {
  return [...list].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.user.name.localeCompare(b.user.name, 'pt-BR'),
  )
}

/** Busca local (nome, e-mail ou rótulo do papel) + filtros de papel e departamento, já ordenado. */
export function filterMembers(
  list: readonly MemberDto[],
  f: { role: RoleFilter; department: DepartmentFilter; search?: string; roleLabel?: (r: CompanyRole) => string },
): MemberDto[] {
  const q = fold(f.search?.trim() ?? '')
  return sortMembers(
    list.filter((m) => {
      if (f.role !== 'all' && m.role !== f.role) return false
      const depts = m.department_ids ?? []
      if (f.department === 'none' && depts.length > 0) return false
      if (f.department !== 'all' && f.department !== 'none' && !depts.includes(f.department)) return false
      if (!q) return true
      return [m.user.name, m.user.email, f.roleLabel?.(m.role) ?? m.role].some((v) => fold(v).includes(q))
    }),
  )
}

export interface Actor {
  userId: string
  role: CompanyRole | null
  isOwner: boolean
  can: (key: string) => boolean
}

/** Ações do menu do membro (16 §5 Equipe 4–5, §4, §8.4). */
export function memberActions(actor: Actor, target: MemberDto) {
  const ownerOrAdmin = actor.role === 'owner' || actor.role === 'admin'
  const isTargetOwner = target.role === 'owner'
  return {
    /** Modal "Permissões do membro" (owner/admin da conta; o owner aparece travado). */
    permissions: ownerOrAdmin,
    /** Trocar entre admin/member: `team.edit`, nunca o owner. */
    changeRole: actor.can('team.edit') && !isTargetOwner,
    /** Remover: `team.delete`, nunca o owner nem a si mesmo. */
    remove: actor.can('team.delete') && !isTargetOwner && target.user_id !== actor.userId,
    /** Transferir a propriedade: só o owner, para um admin. */
    transfer: actor.isOwner && target.role === 'admin' && target.user_id !== actor.userId,
  }
}

// ---------- matriz de permissões ----------

const ALWAYS = new Set<string>(ALWAYS_GRANTED_PERMISSIONS)
const OWNER_ONLY = new Set<string>(OWNER_ONLY_PERMISSIONS)
export const ACTIONS = ['view', 'edit', 'delete'] as const
export type MatrixAction = (typeof ACTIONS)[number]

export const isAlwaysGranted = (key: string) => ALWAYS.has(key)
export const isOwnerOnly = (key: string) => OWNER_ONLY.has(key)
export const isLocked = (key: string) => ALWAYS.has(key) || OWNER_ONLY.has(key)

export interface PermissionGroupView {
  key: string
  /** Chaves soltas (checkbox). */
  keys: string[]
  /** Matriz área × (ver, editar, excluir) do grupo `settings`. */
  areas: string[]
}

/** Grupos do modal na ordem do catálogo; o grupo `settings` vira matriz das áreas. */
export const PERMISSION_GROUPS: PermissionGroupView[] = PERMISSION_CATALOG.map((g) =>
  g.group === 'settings'
    ? { key: g.group, keys: ['settings.view'], areas: [...SETTINGS_AREAS] }
    : { key: g.group, keys: [...g.keys], areas: [] },
)

export const cellKey = (area: string, action: MatrixAction) => `settings.${area}.${action}`

/** Todas as chaves do grupo (para o contador). */
export const groupKeys = (g: PermissionGroupView) => [...g.keys, ...g.areas.flatMap((a) => ACTIONS.map((x) => cellKey(a, x)))]

/** "N ativa(s)": chaves do grupo presentes na seleção. */
export const activeCount = (g: PermissionGroupView, selected: ReadonlySet<string>) =>
  groupKeys(g).filter((k) => selected.has(k)).length

/** Seleção inicial: a lista explícita do membro ou a matriz do papel, sempre com as sempre concedidas. */
export function initialSelection(member: Pick<MemberDto, 'role' | 'permission_keys'>): Set<string> {
  const base =
    member.permission_keys && member.permission_keys.length > 0
      ? member.permission_keys
      : DEFAULT_ROLE_PERMISSIONS[member.role]
  return new Set<string>([...normalizePermissions(base), ...ALWAYS_GRANTED_PERMISSIONS])
}

export const roleDefaults = (role: CompanyRole) =>
  new Set<string>([...normalizePermissions(DEFAULT_ROLE_PERMISSIONS[role]), ...ALWAYS_GRANTED_PERMISSIONS])

/** Marca/desmarca uma chave aplicando as dependências (edit/delete ⇒ view; tirar view tira edit/delete…). */
export function toggleKey(selected: ReadonlySet<string>, key: string, on: boolean): Set<string> {
  if (isLocked(key)) return new Set(selected)
  const next = on ? normalizePermissions([...selected, key]) : revokePermission(selected, key)
  return new Set<string>([...next, ...ALWAYS_GRANTED_PERMISSIONS])
}

/** Cabeçalho de coluna: marca/desmarca a ação em todas as áreas editáveis. */
export function toggleColumn(selected: ReadonlySet<string>, action: MatrixAction, on: boolean): Set<string> {
  let next = new Set(selected)
  for (const area of SETTINGS_AREAS) {
    const key = cellKey(area, action)
    if (!isLocked(key)) next = toggleKey(next, key, on)
  }
  return next
}

/** A coluna está toda marcada (entre as áreas editáveis)? */
export const columnChecked = (selected: ReadonlySet<string>, action: MatrixAction) =>
  SETTINGS_AREAS.map((a) => cellKey(a, action))
    .filter((k) => !isLocked(k))
    .every((k) => selected.has(k))

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((k) => b.has(k))

/** Corpo do PATCH: igual à matriz do papel → `null` (volta ao padrão); senão a lista normalizada. */
export function permissionPayload(role: CompanyRole, selected: ReadonlySet<string>): string[] | null {
  if (sameSet(selected, roleDefaults(role))) return null
  return normalizePermissions(selected)
}

/** O escopo de chat só vale com `chat.view` (16 §5 Equipe 10). */
export const scopeEnabled = (selected: ReadonlySet<string>) => selected.has('chat.view')
