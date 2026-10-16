// Matriz padrão por papel (16-configuracoes-empresa-equipe.md#82-matriz-padrão), sem `billing.*`.
// Vale quando o membro não tem lista explícita de permissões.
import { ALWAYS_GRANTED_PERMISSIONS, PERMISSION_KEYS, SETTINGS_AREAS, type PermissionKey, type SettingsArea } from './catalog'

export const COMPANY_ROLES = ['owner', 'admin', 'member'] as const
export type CompanyRole = (typeof COMPANY_ROLES)[number]

const STANDARD_AREAS = SETTINGS_AREAS.filter(
  (a): a is Exclude<SettingsArea, 'platform_invitations' | 'global_variables'> => a !== 'platform_invitations' && a !== 'global_variables',
)
const area = (action: 'view' | 'edit' | 'delete') => STANDARD_AREAS.map((a) => `settings.${a}.${action}` as PermissionKey)

const MEMBER: readonly PermissionKey[] = [
  'chat.view',
  'kanban.view',
  'flows.view',
  'contacts.view',
  'settings.view',
  ...area('view'),
  'settings.quick_replies.edit',
  ...ALWAYS_GRANTED_PERMISSIONS,
]

const ADMIN: readonly PermissionKey[] = [
  ...MEMBER,
  ...area('edit'),
  ...area('delete'),
  'dashboard.sales',
  'dashboard.support',
  'kanban.edit',
  'kanban.delete',
  'flows.edit',
  'flows.delete',
  'contacts.edit',
  'contacts.delete',
  'webhooks.view',
  'webhooks.edit',
  'webhooks.delete',
  'connections.view',
  'connections.edit',
  'connections.delete',
  'chat.block',
  // T48: assumir/atribuir chat de outro atendente e excluir chat (member não tem).
  'chat.assign_others',
  'chat.delete',
  'facebook.campaigns',
  'facebook.pixel',
  'facebook.profiles',
  'team.view',
  'team.edit',
  'team.delete',
]

const uniq = (keys: readonly PermissionKey[]) => [...new Set(keys)]

/** Permissões padrão de cada papel. `owner` tem tudo. */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<CompanyRole, readonly PermissionKey[]>> = {
  member: uniq(MEMBER),
  admin: uniq(ADMIN),
  owner: uniq([...PERMISSION_KEYS, ...ALWAYS_GRANTED_PERMISSIONS]),
}

export function defaultPermissionsFor(role: CompanyRole): readonly PermissionKey[] {
  return DEFAULT_ROLE_PERMISSIONS[role]
}
