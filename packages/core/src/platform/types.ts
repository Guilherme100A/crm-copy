// Contexto tipado de uma requisição autenticada (SPEC T08): `{ user, companyId, member, perms }`.
import type { MemberRole, SystemRole } from '@crm/db'
import type { PermissionKey } from '@crm/shared'

/** Usuário autenticado (nunca carrega o hash de senha). */
export interface AuthUser {
  id: string
  email: string
  name: string
  systemRole: SystemRole
  locale: string
  lastCompanyId: string | null
}

/** Vínculo do usuário com a empresa ativa. */
export interface CompanyMember {
  id: string
  companyId: string
  userId: string
  role: MemberRole
  /** `null` = matriz padrão do papel; lista explícita substitui a matriz (SPEC 3.3). */
  permissionKeys: string[] | null
}

export type AuthKind = 'session' | 'api_token'

export interface AuthInfo {
  kind: AuthKind
  /** `crm.auth_sessions.id` (kind = session). */
  sessionId?: string
  /** `crm.api_tokens.id` (kind = api_token). */
  tokenId?: string
}

export interface RequestContext {
  /** Usuário da sessão; com token de API, o criador do token (pode ser `null`). */
  user: AuthUser | null
  /** Empresa ativa (`X-Company-Id` / `last_company_id` / empresa do token); `null` se o usuário não tem empresa. */
  companyId: string | null
  member: CompanyMember | null
  perms: ReadonlySet<PermissionKey>
  auth: AuthInfo
}
