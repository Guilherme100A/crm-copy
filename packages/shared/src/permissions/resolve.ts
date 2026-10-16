// Resolução de permissões (SPEC 3.3; 16#8.2–8.4): owner tem tudo; lista explícita não vazia substitui a matriz
// do papel; usuário de suporte usa só a lista explícita; `profile.view` e `settings.global_variables.*` sempre.
import { ALWAYS_GRANTED_PERMISSIONS, PERMISSION_KEYS, isPermissionKey, type PermissionKey } from './catalog'
import { DEFAULT_ROLE_PERMISSIONS, type CompanyRole } from './defaults'

export const SYSTEM_ROLES = ['user', 'platform_admin', 'support'] as const
export type SystemRole = (typeof SYSTEM_ROLES)[number]

/** Quem é avaliado. Aceita a forma do fio (`permission_keys`) e a camelCase do domínio (`permissionKeys`). */
export interface PermissionSubject {
  role: CompanyRole
  permission_keys?: readonly string[] | null
  permissionKeys?: readonly string[] | null
  system_role?: SystemRole | null
  systemRole?: SystemRole | null
}

const ORDER = new Map<string, number>([...PERMISSION_KEYS, ...ALWAYS_GRANTED_PERMISSIONS].map((k, i) => [k, i]))
const byCatalogOrder = (a: string, b: string) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0)

function viewOf(key: string): string | null {
  const m = /^(.+)\.(edit|delete)$/.exec(key)
  return m ? `${m[1]}.view` : null
}

/**
 * Aplica as dependências do modal de permissões, só acrescentando chaves e sem duplicar:
 * `X.edit`/`X.delete` ⇒ `X.view` + `settings.view`; `chat.block` ⇒ `chat.view`; qualquer `settings.*` ⇒ `settings.view`.
 * Chaves fora do catálogo (ex.: `billing.*`) são descartadas. Resultado na ordem do catálogo.
 */
export function normalizePermissions(keys: Iterable<string>): PermissionKey[] {
  const out = new Set<PermissionKey>()
  const add = (k: string | null) => {
    if (k && isPermissionKey(k)) out.add(k)
  }
  for (const key of keys) {
    if (!isPermissionKey(key)) continue
    add(key)
    const view = viewOf(key)
    if (view) {
      add(view)
      add('settings.view')
    }
    if (key === 'chat.block') add('chat.view')
    if (key.startsWith('settings.')) add('settings.view')
  }
  return [...out].sort(byCatalogOrder)
}

/**
 * Remove uma chave aplicando a cascata inversa do modal: tirar `X.view` tira `X.edit`/`X.delete`;
 * tirar `chat.view` tira `chat.block`. Chaves sempre concedidas não são removíveis.
 */
export function revokePermission(keys: Iterable<string>, key: string): PermissionKey[] {
  const removed = new Set<string>([key])
  const m = /^(.+)\.view$/.exec(key)
  if (m) removed.add(`${m[1]}.edit`).add(`${m[1]}.delete`)
  if (key === 'chat.view') removed.add('chat.block')
  for (const k of ALWAYS_GRANTED_PERMISSIONS) removed.delete(k)
  return normalizePermissions([...keys].filter((k) => !removed.has(k)))
}

function explicitKeys(subject: PermissionSubject): readonly string[] | null {
  return subject.permission_keys ?? subject.permissionKeys ?? null
}

/** Conjunto efetivo de permissões do membro na empresa. */
export function effectivePermissions(subject: PermissionSubject): ReadonlySet<PermissionKey> {
  if (subject.role === 'owner') return new Set(DEFAULT_ROLE_PERMISSIONS.owner)
  const explicit = explicitKeys(subject)
  const isSupport = (subject.system_role ?? subject.systemRole) === 'support'
  const base = explicit && explicit.length > 0 ? normalizePermissions(explicit) : isSupport ? [] : DEFAULT_ROLE_PERMISSIONS[subject.role] ?? []
  return new Set<PermissionKey>([...base, ...ALWAYS_GRANTED_PERMISSIONS])
}

/** O membro tem a permissão `key`? `owner` sempre `true`. */
export function can(subject: PermissionSubject, key: PermissionKey | (string & {})): boolean {
  if (subject.role === 'owner') return true
  return (effectivePermissions(subject) as ReadonlySet<string>).has(key)
}
