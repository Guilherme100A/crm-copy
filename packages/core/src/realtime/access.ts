// Reconferência periódica de acesso de um stream aberto (a cada heartbeat): sessão/token ainda válidos e
// vínculo com a empresa. É o caminho garantido para o logout fechar o stream mesmo sem aviso imediato.
import { and, eq, gt, isNull, or } from 'drizzle-orm'
import { apiTokens, authSessions, type Database } from '@crm/db'
import { findMembership, permissionsOf } from '../platform/company-context'
import type { AuthInfo, AuthUser, CompanyMember } from '../platform/types'

export async function isAuthActive(db: Database, auth: AuthInfo, now = new Date()): Promise<boolean> {
  if (auth.kind === 'session' && auth.sessionId) {
    const [row] = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.id, auth.sessionId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now)))
      .limit(1)
    return !!row
  }
  if (auth.kind === 'api_token' && auth.tokenId) {
    const [row] = await db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(and(eq(apiTokens.id, auth.tokenId), isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now))))
      .limit(1)
    return !!row
  }
  return false
}

export interface ConnectionAccess {
  member: CompanyMember | null
  perms: ReadonlySet<string>
}

/**
 * Acesso atual de um stream: `null` se a sessão/token caiu ou o usuário saiu da empresa; senão o vínculo e as
 * permissões recalculados (mudança de papel vale sem reconectar). Token de API não tem vínculo (empresa inteira).
 */
export async function checkConnectionAccess(
  db: Database,
  input: { auth: AuthInfo; user: Pick<AuthUser, 'id' | 'systemRole'> | null; companyId: string; perms: ReadonlySet<string> },
): Promise<ConnectionAccess | null> {
  if (!(await isAuthActive(db, input.auth))) return null
  if (input.auth.kind === 'api_token' || !input.user) return { member: null, perms: input.perms }
  const member = await findMembership(db, input.user.id, input.companyId)
  if (!member) return null
  return { member, perms: permissionsOf(member, input.user) }
}
