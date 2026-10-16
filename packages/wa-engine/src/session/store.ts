// Persistência das sessões (public.sessions + health_events; fork de ai-manager core/session/store.ts).
// Nunca expõe credenciais: a visão pública só tem colunas de `sessions`.
import { and, desc, eq, sql } from 'drizzle-orm'
import { E164_REGEX, healthEvents, proxies, sessionCredentials, sessions, type Database } from '../db'
import { isUniqueViolation } from '../proxy/errors'
import { assertTransition, InvalidTransitionError, type SessionState } from './states'

export type SessionRow = typeof sessions.$inferSelect

export type SessionErrorCode = 'SESSION_NOT_FOUND' | 'PROXY_IN_USE' | 'PROXY_NOT_FOUND' | 'VALIDATION_ERROR'

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    /** Campo inválido (VALIDATION_ERROR). */
    readonly field?: string,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

export interface SessionView {
  id: string
  name: string
  /** Null até a sessão conectar pela primeira vez (cadastro por QR sem número). */
  phone: string | null
  status: SessionState
  /** Alias de `status`. */
  state: SessionState
  proxyId: string | null
  note: string | null
  requiresRestart: boolean
  warmupStartedAt: string | null
  lastConnectedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateSessionInput {
  name: string
  /** Opcional no QR (preenchido com o número da conta ao conectar). Obrigatório para pairing code. */
  phone?: string | null
  /** Proxy opcional (vínculo 1:1). */
  proxyId?: string | null
  note?: string | null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: row.status,
    state: row.status,
    proxyId: row.proxyId,
    note: row.note,
    requiresRestart: row.requiresRestart,
    warmupStartedAt: iso(row.warmupStartedAt),
    lastConnectedAt: iso(row.lastConnectedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TransitionResult {
  row: SessionRow
  from: SessionState
  to: SessionState
  changed: boolean
}

export interface TransitionOptions {
  /** Campos extras gravados junto com o estado. */
  set?: Partial<Pick<SessionRow, 'warmupStartedAt' | 'lastConnectedAt' | 'requiresRestart'>>
}

export class SessionStore {
  constructor(readonly db: Database) {}

  async create(input: CreateSessionInput): Promise<SessionRow> {
    const name = input.name?.trim()
    if (!name) throw new SessionError('VALIDATION_ERROR', 'name é obrigatório', 'name')
    const phone = input.phone?.trim() || null
    if (phone !== null && !E164_REGEX.test(phone)) throw new SessionError('VALIDATION_ERROR', 'phone deve estar em E.164 (ex.: +5511999999999)', 'phone')
    const proxyId = input.proxyId ?? null
    try {
      return await this.db.transaction(async (tx) => {
        if (proxyId) {
          const [proxy] = await tx.select({ id: proxies.id }).from(proxies).where(eq(proxies.id, proxyId)).for('update')
          if (!proxy) throw new SessionError('PROXY_NOT_FOUND', `proxy ${proxyId} não encontrado`)
          const [owner] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.proxyId, proxyId))
          if (owner) throw new SessionError('PROXY_IN_USE', `proxy ${proxyId} já está vinculado a outra sessão`)
          await tx.update(proxies).set({ lastChangedAt: new Date(), updatedAt: new Date() }).where(eq(proxies.id, proxyId))
        }
        const [row] = await tx.insert(sessions).values({ name, phone, proxyId, note: input.note ?? null, status: 'NEW' }).returning()
        return row!
      })
    } catch (err) {
      if (isUniqueViolation(err)) throw new SessionError('PROXY_IN_USE', `proxy ${proxyId} já está vinculado a outra sessão`)
      throw err
    }
  }

  async list(): Promise<SessionRow[]> {
    return this.db.select().from(sessions).orderBy(desc(sessions.createdAt))
  }

  async find(id: string): Promise<SessionRow | undefined> {
    if (!UUID_RE.test(id)) return undefined
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id))
    return row
  }

  async get(id: string): Promise<SessionRow> {
    const row = await this.find(id)
    if (!row) throw new SessionError('SESSION_NOT_FOUND', `sessão ${id} não encontrada`)
    return row
  }

  /** Exclui a sessão (credenciais e eventos caem em cascata); o proxy fica sem uso e é apagado (vínculo 1:1). */
  async delete(id: string): Promise<{ deletedProxyId: string | null }> {
    if (!UUID_RE.test(id)) throw new SessionError('SESSION_NOT_FOUND', `sessão ${id} não encontrada`)
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(sessions).where(eq(sessions.id, id)).for('update')
      if (!current) throw new SessionError('SESSION_NOT_FOUND', `sessão ${id} não encontrada`)
      await tx.delete(sessions).where(eq(sessions.id, id))
      let deletedProxyId: string | null = null
      if (current.proxyId) {
        const [stillUsed] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.proxyId, current.proxyId))
        if (!stillUsed) {
          await tx.delete(proxies).where(eq(proxies.id, current.proxyId))
          deletedProxyId = current.proxyId
        }
      }
      return { deletedProxyId }
    })
  }

  /**
   * Muda o estado validando contra o valor atual no banco (linha travada).
   * `to === atual` é no-op (`changed: false`) com `allowSame`; senão INVALID_TRANSITION.
   */
  async transition(id: string, to: SessionState, opts: TransitionOptions & { allowSame?: boolean } = {}): Promise<TransitionResult> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(sessions).where(eq(sessions.id, id)).for('update')
      if (!current) throw new SessionError('SESSION_NOT_FOUND', `sessão ${id} não encontrada`)
      const from = current.status
      if (from === to) {
        if (!opts.allowSame) throw new InvalidTransitionError(from, to)
        if (!opts.set) return { row: current, from, to, changed: false }
        const [row] = await tx.update(sessions).set({ ...opts.set, updatedAt: new Date() }).where(eq(sessions.id, id)).returning()
        return { row: row!, from, to, changed: false }
      }
      assertTransition(from, to)
      const [row] = await tx.update(sessions).set({ ...opts.set, status: to, updatedAt: new Date() }).where(eq(sessions.id, id)).returning()
      return { row: row!, from, to, changed: true }
    })
  }

  async update(id: string, set: Partial<Pick<SessionRow, 'warmupStartedAt' | 'lastConnectedAt' | 'requiresRestart' | 'phone'>>): Promise<SessionRow> {
    const [row] = await this.db.update(sessions).set({ ...set, updatedAt: new Date() }).where(eq(sessions.id, id)).returning()
    if (!row) throw new SessionError('SESSION_NOT_FOUND', `sessão ${id} não encontrada`)
    return row
  }

  async recordHealthEvent(sessionId: string, type: string, detail?: Record<string, unknown>): Promise<void> {
    await this.db.insert(healthEvents).values({ sessionId, type, detail: detail ?? null })
  }

  /** Tipo do evento de saúde mais recente (ex.: `proxy_unavailable`). */
  async lastHealthEventType(sessionId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ type: healthEvents.type })
      .from(healthEvents)
      .where(eq(healthEvents.sessionId, sessionId))
      .orderBy(desc(healthEvents.id))
      .limit(1)
    return row?.type
  }

  async hasCredentials(sessionId: string): Promise<boolean> {
    const [row] = await this.db.select({ one: sql<number>`1` }).from(sessionCredentials).where(eq(sessionCredentials.sessionId, sessionId)).limit(1)
    return row !== undefined
  }

  /** Sessões a reconectar no boot: com credenciais e estado ≠ DISCONNECTED (PAUSED reconecta e segue PAUSED). */
  async listResumable(): Promise<SessionRow[]> {
    const withCreds = sql`exists (select 1 from ${sessionCredentials} where ${sessionCredentials.sessionId} = ${sessions.id})`
    return this.db
      .select()
      .from(sessions)
      .where(and(sql`${sessions.status} <> 'DISCONNECTED'`, withCreds))
      .orderBy(sessions.createdAt)
  }
}
