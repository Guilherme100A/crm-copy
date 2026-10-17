// Concessões de acesso de suporte (T32): escopo, relógio e consultas usadas pelo contexto de empresa, pelo SSE e
// pela lista de empresas do perfil. Sem dependência de outros módulos do core (company-context importa daqui).
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { supportAccessGrants, supportAccessRequests, type Database } from '@crm/db'
import { normalizePermissions, PERMISSION_KEYS, type PermissionKey } from '@crm/shared'

/** Validade da concessão aprovada (16 §3.7: "Aprovar por 12h"). */
export const SUPPORT_GRANT_TTL_MS = 12 * 60 * 60 * 1000

/** Áreas liberadas ao suporte (01 §19): só fluxos e Ferramentas MCP. */
const SCOPE_PREFIXES = ['flows.', 'settings.mcp.'] as const

/**
 * Permissões da concessão: `flows.*` + `settings.mcp.*` do catálogo, normalizadas (`normalizePermissions` acrescenta
 * `settings.view`). Não passa por `effectivePermissions`, que somaria `profile.view` e `settings.global_variables.*`.
 */
export const SUPPORT_GRANT_PERMISSIONS: readonly PermissionKey[] = normalizePermissions(
  PERMISSION_KEYS.filter((k) => SCOPE_PREFIXES.some((p) => k.startsWith(p))),
)

export function supportGrantPermissions(): ReadonlySet<PermissionKey> {
  return new Set(SUPPORT_GRANT_PERMISSIONS)
}

/** Concessão que autoriza a requisição atual (gravada no contexto e na auditoria). */
export interface SupportGrantContext {
  id: string
  companyId: string
  supportUserId: string
  expiresAt: Date
}

declare module '../platform/types' {
  interface RequestContext {
    /** T32: presente quando o usuário `support` age na empresa por concessão (sem vínculo; `member` é `null`). */
    supportGrant?: SupportGrantContext | null
  }
}

// Relógio por banco: a API registra o relógio injetado (testes) para o contexto de empresa e o SSE.
const clocks = new WeakMap<object, () => Date>()

export function setSupportAccessClock(db: Database, now: (() => Date) | undefined): void {
  if (now) clocks.set(db, now)
  else clocks.delete(db)
}

export function supportAccessNow(db: Database): Date {
  return clocks.get(db)?.() ?? new Date()
}

const grantColumns = {
  id: supportAccessGrants.id,
  companyId: supportAccessGrants.companyId,
  supportUserId: supportAccessGrants.supportUserId,
  expiresAt: supportAccessGrants.expiresAt,
}

const activeFor = (supportUserId: string, now: Date) =>
  and(eq(supportAccessGrants.supportUserId, supportUserId), isNull(supportAccessGrants.revokedAt), gt(supportAccessGrants.expiresAt, now))

/** Concessão ativa (não revogada e `expires_at > now`) do suporte na empresa; `null` se não houver. */
export async function findActiveSupportGrant(
  db: Database,
  supportUserId: string,
  companyId: string,
  now = supportAccessNow(db),
): Promise<SupportGrantContext | null> {
  const [row] = await db
    .select(grantColumns)
    .from(supportAccessGrants)
    .where(and(activeFor(supportUserId, now), eq(supportAccessGrants.companyId, companyId)))
    .orderBy(desc(supportAccessGrants.expiresAt))
    .limit(1)
  return row ?? null
}

/** Concessões ativas do suporte, a que expira por último primeiro. */
export async function listActiveSupportGrants(db: Database, supportUserId: string, now = supportAccessNow(db)): Promise<SupportGrantContext[]> {
  return db.select(grantColumns).from(supportAccessGrants).where(activeFor(supportUserId, now)).orderBy(desc(supportAccessGrants.expiresAt))
}

/** O suporte já teve concessão na empresa (hoje expirada ou revogada)? Ele já conhece a empresa: 403, não 404. */
export async function hadSupportGrant(db: Database, supportUserId: string, companyId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: supportAccessGrants.id })
    .from(supportAccessGrants)
    .where(and(eq(supportAccessGrants.supportUserId, supportUserId), eq(supportAccessGrants.companyId, companyId)))
    .limit(1)
  return !!row
}

/** O suporte tem pedido pendente na empresa? (pode abrir o SSE dela para receber a decisão). */
export async function hasPendingSupportRequest(db: Database, supportUserId: string, companyId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: supportAccessRequests.id })
    .from(supportAccessRequests)
    .where(
      and(
        eq(supportAccessRequests.supportUserId, supportUserId),
        eq(supportAccessRequests.companyId, companyId),
        eq(supportAccessRequests.status, 'pending'),
      ),
    )
    .limit(1)
  return !!row
}
