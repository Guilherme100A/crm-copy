// Reconferência periódica de acesso de um stream aberto (a cada heartbeat): sessão/token ainda válidos e
// vínculo com a empresa. É o caminho garantido para o logout fechar o stream mesmo sem aviso imediato.
import { and, eq, gt, isNull, or } from 'drizzle-orm'
import { apiTokens, authSessions, type Database } from '@crm/db'
import { findMembership, isUuid, permissionsOf } from '../platform/company-context'
import { findActiveSupportGrant, hasPendingSupportRequest, supportGrantPermissions } from '../support-access/grants'
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
  if (!member) return input.user.systemRole === 'support' ? supportConnectionAccess(db, input.user.id, input.companyId) : null
  return { member, perms: permissionsOf(member, input.user) }
}

/**
 * T32: usuário `support` sem vínculo mantém o stream da empresa enquanto tiver concessão ativa (permissões da
 * concessão) ou pedido pendente nela (sem permissões: só recebe a decisão). Concessão revogada/expirada e nenhum
 * pedido pendente → `null` (o stream cai no próximo heartbeat).
 */
export async function supportConnectionAccess(db: Database, supportUserId: string, companyId: string): Promise<ConnectionAccess | null> {
  if (!isUuid(companyId)) return null
  if (await findActiveSupportGrant(db, supportUserId, companyId)) return { member: null, perms: supportGrantPermissions() }
  if (await hasPendingSupportRequest(db, supportUserId, companyId)) return { member: null, perms: new Set() }
  return null
}
