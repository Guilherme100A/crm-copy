// Catálogo de permissões (SPEC 3.3; 16-configuracoes-empresa-equipe.md#81-catálogo), SEM `billing.*`.
// Arquivo compartilhado: tarefas de módulo acrescentam grupos/chaves de forma aditiva.

const ved = <P extends string>(prefix: P) => [`${prefix}.view`, `${prefix}.edit`, `${prefix}.delete`] as const

/** Áreas da matriz `settings.<área>.<view|edit|delete>`. */
export const SETTINGS_AREAS = [
  'labels',
  'departments',
  'fields',
  'products',
  'mcp',
  'integrations',
  'dispatch',
  'business_hours',
  'quick_replies',
  'accounts',
  'platform_invitations',
  'global_variables',
] as const
export type SettingsArea = (typeof SETTINGS_AREAS)[number]

const settingsMatrix = <A extends SettingsArea>(areas: readonly A[]) =>
  areas.flatMap((a) => ved(`settings.${a}`)) as `settings.${A}.${'view' | 'edit' | 'delete'}`[]

/** Grupos na ordem do modal "Permissões do membro". */
export const PERMISSION_CATALOG = [
  { group: 'dashboard', keys: ['dashboard.sales', 'dashboard.support'] },
  { group: 'chat', keys: ['chat.view', 'chat.block', 'chat.assign_others', 'chat.delete'] },
  { group: 'kanban', keys: ved('kanban') },
  { group: 'flows', keys: [...ved('flows'), 'flows.run'] },
  { group: 'contacts', keys: ved('contacts') },
  { group: 'webhooks', keys: ved('webhooks') },
  { group: 'connections', keys: ved('connections') },
  { group: 'facebook', keys: ['facebook.campaigns', 'facebook.pixel', 'facebook.profiles'] },
  { group: 'team', keys: ved('team') },
  { group: 'settings', keys: ['settings.view', ...settingsMatrix(SETTINGS_AREAS)] },
] as const

type CatalogEntry = (typeof PERMISSION_CATALOG)[number]
type StaticKey = CatalogEntry['keys'][number]
export type PermissionGroup = CatalogEntry['group']

/** Chaves sempre concedidas a qualquer membro (não editáveis no modal). `profile.view` fica fora do catálogo editável. */
export const ALWAYS_GRANTED_PERMISSIONS = [
  'profile.view',
  'settings.global_variables.view',
  'settings.global_variables.edit',
  'settings.global_variables.delete',
] as const

/** Áreas que só o owner tem por padrão (admin só se a lista explícita conceder). */
export const OWNER_ONLY_PERMISSIONS = ved('settings.platform_invitations')

export type PermissionKey = StaticKey | `settings.${SettingsArea}.${'view' | 'edit' | 'delete'}` | 'profile.view'

/** Todas as chaves editáveis do catálogo, na ordem dos grupos. */
export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_CATALOG.flatMap((g) => [...g.keys])

const KNOWN = new Set<string>([...PERMISSION_KEYS, ...ALWAYS_GRANTED_PERMISSIONS])

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === 'string' && KNOWN.has(value)
}
