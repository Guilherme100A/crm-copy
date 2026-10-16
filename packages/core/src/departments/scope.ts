// Escopo de chat do membro (SPEC 3.3): departamentos e conexões; vazio = todos; owner/admin ignoram.
// Usado pelas listas de chats (T48) e pelo filtro do realtime (registerScopeFilter, T16).
import { and, eq } from 'drizzle-orm'
import { companyMembers, memberConnections, memberDepartments, type Database } from '@crm/db'
import { registerScopeFilter, type RealtimeScope, type ScopeSubject } from '../realtime'

export type ScopeList = 'all' | string[]

export interface ChatScope {
  departments: ScopeList
  connections: ScopeList
}

export interface ScopeMemberInput {
  role: 'owner' | 'admin' | 'member' | (string & {})
  department_ids?: readonly string[] | null
  connection_ids?: readonly string[] | null
  departmentIds?: readonly string[] | null
  connectionIds?: readonly string[] | null
}

export const ALL_CHATS: ChatScope = Object.freeze({ departments: 'all', connections: 'all' }) as ChatScope

const listOf = (ids: readonly string[] | null | undefined): ScopeList => (ids && ids.length ? [...new Set(ids)] : 'all')

/** Escopo do membro: só os departamentos/conexões escolhidos; nenhuma seleção = todos; owner/admin = todos. */
export function chatScopeFor(member: ScopeMemberInput): ChatScope {
  if (member.role === 'owner' || member.role === 'admin') return { ...ALL_CHATS }
  return {
    departments: listOf(member.department_ids ?? member.departmentIds),
    connections: listOf(member.connection_ids ?? member.connectionIds),
  }
}

/** O escopo permite um chat/evento desse departamento e dessa conexão? (`null` = sem valor, não restringe.) */
export function scopeAllows(scope: ChatScope, target: { department_id?: string | null; connection_id?: string | null }): boolean {
  if (scope.departments !== 'all' && target.department_id && !scope.departments.includes(target.department_id)) return false
  if (scope.connections !== 'all' && target.connection_id && !scope.connections.includes(target.connection_id)) return false
  return true
}

/** Escopo do usuário na empresa, lido do banco; sem vínculo → `null`. */
export async function loadChatScope(db: Database, companyId: string, userId: string): Promise<ChatScope | null> {
  const [m] = await db
    .select({ id: companyMembers.id, role: companyMembers.role })
    .from(companyMembers)
    .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)))
    .limit(1)
  if (!m) return null
  if (m.role === 'owner' || m.role === 'admin') return { ...ALL_CHATS }
  const [deps, conns] = await Promise.all([
    db.select({ id: memberDepartments.departmentId }).from(memberDepartments).where(eq(memberDepartments.memberId, m.id)),
    db.select({ id: memberConnections.connectionId }).from(memberConnections).where(eq(memberConnections.memberId, m.id)),
  ])
  return chatScopeFor({ role: m.role, department_ids: deps.map((d) => d.id), connection_ids: conns.map((c) => c.id) })
}

const registered = new WeakSet<Database>()

/**
 * Registra no realtime (T16) o filtro de departamento/conexão para este banco (uma vez por banco).
 * Banco encerrado (`pool.end()`, ex.: fim de um teste) remove o próprio filtro e não interfere em outros.
 */
export function registerChatScopeFilter(db: Database): void {
  if (registered.has(db)) return
  registered.add(db)
  const pool = db.$client as unknown as { ended?: boolean }
  const off = registerScopeFilter(async (subject: ScopeSubject, scope: RealtimeScope) => {
    if (pool.ended) {
      off()
      return true
    }
    if (!scope.department_id && !scope.connection_id) return true
    const memberScope = await loadChatScope(db, subject.companyId, subject.userId)
    // Usuário não é membro nesta base: a decisão é de outro filtro/banco.
    if (!memberScope) return true
    return scopeAllows(memberScope, scope)
  })
}
