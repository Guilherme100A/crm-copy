// Empresa ativa (SPEC 3.3): `X-Company-Id` validado contra a membership; sem header, `users.last_company_id`.
// Empresa da qual o usuário não é membro → "não encontrada" (404, nunca 403, para não vazar existência).
import { asc, and, eq } from 'drizzle-orm'
import { companyMembers, type Database } from '@crm/db'
import { DEFAULT_ROLE_PERMISSIONS, effectivePermissions, type PermissionKey } from '@crm/shared'
import type { AuthUser, CompanyMember } from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

const memberColumns = {
  id: companyMembers.id,
  companyId: companyMembers.companyId,
  userId: companyMembers.userId,
  role: companyMembers.role,
  permissionKeys: companyMembers.permissionKeys,
}

export async function findMembership(db: Database, userId: string, companyId: string): Promise<CompanyMember | null> {
  if (!isUuid(companyId)) return null
  const [row] = await db
    .select(memberColumns)
    .from(companyMembers)
    .where(and(eq(companyMembers.userId, userId), eq(companyMembers.companyId, companyId)))
    .limit(1)
  return row ?? null
}

async function firstMembership(db: Database, userId: string): Promise<CompanyMember | null> {
  const [row] = await db
    .select(memberColumns)
    .from(companyMembers)
    .where(eq(companyMembers.userId, userId))
    .orderBy(asc(companyMembers.createdAt), asc(companyMembers.id))
    .limit(1)
  return row ?? null
}

export type CompanyResolution =
  | { ok: true; companyId: string | null; member: CompanyMember | null }
  | { ok: false; reason: 'not_found' }

/**
 * Resolve a empresa ativa do usuário. Com `requestedCompanyId` (header): precisa ser membro, senão `not_found`.
 * Sem header: `last_company_id` se ainda for membro; senão o vínculo mais antigo; sem vínculo → `companyId: null`.
 */
export async function resolveCompanyContext(
  db: Database,
  user: Pick<AuthUser, 'id' | 'lastCompanyId'>,
  requestedCompanyId?: string | null,
): Promise<CompanyResolution> {
  if (requestedCompanyId) {
    const member = await findMembership(db, user.id, requestedCompanyId)
    return member ? { ok: true, companyId: member.companyId, member } : { ok: false, reason: 'not_found' }
  }
  const member =
    (user.lastCompanyId ? await findMembership(db, user.id, user.lastCompanyId) : null) ?? (await firstMembership(db, user.id))
  return { ok: true, companyId: member?.companyId ?? null, member }
}

/** Permissões efetivas do membro (owner tem tudo; lista explícita substitui a matriz). */
export function permissionsOf(member: CompanyMember | null, user: Pick<AuthUser, 'systemRole'> | null): ReadonlySet<PermissionKey> {
  if (!member) return new Set()
  return effectivePermissions({ role: member.role, permissionKeys: member.permissionKeys, systemRole: user?.systemRole ?? null })
}

/** Permissões de um token de API: as da empresa inteira (equivalente ao owner). */
export function apiTokenPermissions(): ReadonlySet<PermissionKey> {
  return new Set(DEFAULT_ROLE_PERMISSIONS.owner)
}
