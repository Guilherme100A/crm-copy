// Tokens do OAuth MCP (T115): formatos, TTLs, PKCE S256 e a validação do access token no endpoint MCP.
// Sem import de `../mcp/*`: `mcp/credentials.ts` usa este módulo para aceitar o access token OAuth.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { mcpCredentials, mcpOauthGrants, mcpOauthTokens, type Database, type McpAccessMode } from '@crm/db'
import { hashToken } from '../platform/tokens'

export const MCP_OAUTH_ACCESS_PREFIX = 'crm_mcpat_'
export const MCP_OAUTH_REFRESH_PREFIX = 'crm_mcprt_'
export const MCP_OAUTH_CODE_PREFIX = 'crm_mcpac_'
export const MCP_OAUTH_CLIENT_PREFIX = 'crm_mcpc_'
export const MCP_OAUTH_SECRET_PREFIX = 'crm_mcpcs_'

/** TTLs (segundos): pedido de autorização aguardando consentimento, código, access e refresh. */
export const MCP_OAUTH_TTL = {
  request: 10 * 60,
  code: 2 * 60,
  access: 60 * 60,
  refresh: 30 * 86_400,
} as const

export const MCP_OAUTH_SCOPE = 'mcp:read'

export function generateSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

/** `BASE64URL(SHA256(verifier))` (RFC 7636 §4.2). */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** RFC 7636 §4.1: 43–128 caracteres do alfabeto "unreserved". */
export function isValidVerifier(verifier: unknown): verifier is string {
  return typeof verifier === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)
}

export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (!isValidVerifier(verifier)) return false
  const a = Buffer.from(s256(verifier))
  const b = Buffer.from(challenge)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function sameSecret(raw: string, hash: string): boolean {
  const a = Buffer.from(hashToken(raw), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface OAuthAccess {
  credentialId: string
  companyId: string
  grantId: string
  /** Usuário que autorizou o cliente (dono das ações de escrita); `null` se ele foi removido. */
  userId: string | null
  access: McpAccessMode
}

/**
 * Access token OAuth válido → empresa, credencial e grant. `null` se desconhecido, expirado, com o grant revogado
 * (revogação, reuso de refresh) ou com a credencial revogada.
 */
export async function authenticateOAuthAccess(db: Database, token: string, now: Date): Promise<OAuthAccess | null> {
  if (!token.startsWith(MCP_OAUTH_ACCESS_PREFIX) || token.length > 200) return null
  const [row] = await db
    .select({
      accessExpiresAt: mcpOauthTokens.accessExpiresAt,
      grantId: mcpOauthGrants.id,
      userId: mcpOauthGrants.userId,
      grantRevokedAt: mcpOauthGrants.revokedAt,
      credentialId: mcpCredentials.id,
      companyId: mcpCredentials.companyId,
      credentialRevokedAt: mcpCredentials.revokedAt,
      authType: mcpCredentials.authType,
      access: mcpCredentials.access,
    })
    .from(mcpOauthTokens)
    .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthTokens.grantId))
    .innerJoin(mcpCredentials, eq(mcpCredentials.id, mcpOauthGrants.credentialId))
    .where(eq(mcpOauthTokens.accessHash, hashToken(token)))
    .limit(1)
  if (!row || row.authType !== 'oauth' || row.grantRevokedAt || row.credentialRevokedAt) return null
  if (row.accessExpiresAt.getTime() <= now.getTime()) return null
  return { credentialId: row.credentialId, companyId: row.companyId, grantId: row.grantId, userId: row.userId, access: row.access }
}

/** Cliente conectado (grant ativo mais recente) por credencial OAuth, para o status `connected`. */
export async function connectedClients(
  db: Database,
  companyId: string,
  credentialIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (credentialIds.length === 0) return out
  const rows = await db
    .select({ credentialId: mcpOauthGrants.credentialId, clientName: mcpOauthGrants.clientName })
    .from(mcpOauthGrants)
    .where(
      and(
        eq(mcpOauthGrants.companyId, companyId),
        inArray(mcpOauthGrants.credentialId, credentialIds),
        isNull(mcpOauthGrants.revokedAt),
      ),
    )
    .orderBy(desc(mcpOauthGrants.createdAt))
  for (const r of rows) if (!out.has(r.credentialId)) out.set(r.credentialId, r.clientName)
  return out
}
