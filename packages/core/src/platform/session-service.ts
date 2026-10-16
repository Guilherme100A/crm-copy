// Sessões por token opaco e tokens de API (SPEC 3.4). TTL deslizante de `AUTH_SESSION_TTL_DAYS` (padrão 30).
import { and, eq, gt, isNull, or } from 'drizzle-orm'
import { apiTokens, authSessions, users, type Database } from '@crm/db'
import { generateSessionToken, hashToken, isApiToken } from './tokens'
import type { AuthUser } from './types'

export const DEFAULT_SESSION_TTL_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** Intervalo mínimo entre gravações de `last_seen_at`/`expires_at` (evita um UPDATE por requisição). */
const DEFAULT_TOUCH_INTERVAL_MS = 60_000

export interface SessionServiceOptions {
  db: Database
  ttlDays?: number
  touchIntervalMs?: number
  now?: () => Date
}

export interface VerifiedSession {
  sessionId: string
  user: AuthUser
  expiresAt: Date
  /** `true` quando a validade foi renovada nesta verificação (o cookie deve ser reemitido). */
  renewed: boolean
}

export interface VerifiedApiToken {
  tokenId: string
  companyId: string
  name: string
  /** Criador do token, se ainda existir. */
  user: AuthUser | null
}

export interface CreateSessionInput {
  userAgent?: string | null
  ip?: string | null
}

const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  systemRole: users.systemRole,
  locale: users.locale,
  lastCompanyId: users.lastCompanyId,
}

export class SessionService {
  readonly ttlMs: number
  private readonly db: Database
  private readonly touchIntervalMs: number
  private readonly now: () => Date

  constructor(opts: SessionServiceOptions) {
    this.db = opts.db
    this.ttlMs = (opts.ttlDays ?? DEFAULT_SESSION_TTL_DAYS) * DAY_MS
    this.touchIntervalMs = opts.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS
    this.now = opts.now ?? (() => new Date())
  }

  /** Cria a sessão e devolve o token cru (vai só no cookie; o banco guarda o hash). */
  async create(userId: string, input: CreateSessionInput = {}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const token = generateSessionToken()
    const now = this.now()
    const expiresAt = new Date(now.getTime() + this.ttlMs)
    const [row] = await this.db
      .insert(authSessions)
      .values({
        userId,
        tokenHash: hashToken(token),
        expiresAt,
        lastSeenAt: now,
        userAgent: input.userAgent ?? null,
        ip: input.ip ?? null,
      })
      .returning({ id: authSessions.id })
    return { token, sessionId: row!.id, expiresAt }
  }

  /** Valida o token do cookie. Inexistente, revogado ou expirado → `null`. Renova a validade (deslizante). */
  async verify(token: string | undefined | null): Promise<VerifiedSession | null> {
    if (!token) return null
    const now = this.now()
    const [row] = await this.db
      .select({ session: { id: authSessions.id, expiresAt: authSessions.expiresAt, lastSeenAt: authSessions.lastSeenAt }, user: userColumns })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(and(eq(authSessions.tokenHash, hashToken(token)), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now)))
      .limit(1)
    if (!row) return null

    let expiresAt = row.session.expiresAt
    let renewed = false
    const lastSeen = row.session.lastSeenAt?.getTime() ?? 0
    if (now.getTime() - lastSeen >= this.touchIntervalMs) {
      expiresAt = new Date(now.getTime() + this.ttlMs)
      renewed = true
      await this.db
        .update(authSessions)
        .set({ lastSeenAt: now, expiresAt })
        .where(and(eq(authSessions.id, row.session.id), isNull(authSessions.revokedAt)))
    }
    return { sessionId: row.session.id, user: row.user, expiresAt, renewed }
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: this.now() })
      .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    const rows = await this.db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    for (const r of rows) if (r.id !== exceptSessionId) await this.revoke(r.id)
  }

  /** Valida um `Bearer crm_pat_…`. Revogado, expirado ou desconhecido → `null`. */
  async verifyApiToken(token: string | undefined | null): Promise<VerifiedApiToken | null> {
    if (!token || !isApiToken(token)) return null
    const now = this.now()
    const [row] = await this.db
      .select({ id: apiTokens.id, companyId: apiTokens.companyId, name: apiTokens.name, userId: apiTokens.createdByUserId, lastUsedAt: apiTokens.lastUsedAt })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.tokenHash, hashToken(token)),
          isNull(apiTokens.revokedAt),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
        ),
      )
      .limit(1)
    if (!row) return null
    if (now.getTime() - (row.lastUsedAt?.getTime() ?? 0) >= this.touchIntervalMs)
      await this.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id))
    let user: AuthUser | null = null
    if (row.userId) {
      const [u] = await this.db.select(userColumns).from(users).where(eq(users.id, row.userId)).limit(1)
      user = u ?? null
    }
    return { tokenId: row.id, companyId: row.companyId, name: row.name, user }
  }
}
