// Papéis do admin interno (20 §4, §8) → os nossos (SPEC 3.3; decisão do Orquestrador, T95):
// `admin` → `platform_admin`; `support` → `support`; `client`/`client_employee` → `user` (o papel na empresa,
// owner/member, vem de `company_members`). No fio devolvemos os dois: `system_role` e o `role` da referência.
import type { MemberRole, SystemRole } from '@crm/db'

export const LEGACY_USER_ROLES = ['client', 'client_employee', 'admin', 'support'] as const
export type LegacyUserRole = (typeof LEGACY_USER_ROLES)[number]

export const LEGACY_ROLE_LABELS: Record<LegacyUserRole, string> = {
  client: 'Cliente',
  client_employee: 'Funcionário',
  admin: 'Administrador',
  support: 'Suporte',
}

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  owner: 'Proprietário',
  admin: 'Administrador',
  member: 'Membro',
}

export function systemRoleFromLegacy(role: LegacyUserRole): SystemRole {
  return role === 'admin' ? 'platform_admin' : role === 'support' ? 'support' : 'user'
}

/** `user` vira `client` quando é dono de alguma empresa; senão `client_employee`. */
export function legacyRoleOf(systemRole: SystemRole, ownsCompany: boolean): LegacyUserRole {
  if (systemRole === 'platform_admin') return 'admin'
  if (systemRole === 'support') return 'support'
  return ownsCompany ? 'client' : 'client_employee'
}

/** `system_role` explícito vence; senão o `role` da referência; nenhum dos dois → `undefined`. */
export function resolveSystemRole(input: { system_role?: SystemRole; role?: LegacyUserRole }): SystemRole | undefined {
  if (input.system_role) return input.system_role
  return input.role ? systemRoleFromLegacy(input.role) : undefined
}
