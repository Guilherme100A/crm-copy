// Quem consulta: empresa, usuário e o escopo de chat da T31 (departamentos/conexões; owner/admin = todos).
import { eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { chats, type Database } from '@crm/db'
import { ALL_CHATS, loadChatScope, scopeAllows, type ChatScope } from '../../departments'
import { chatNotFound } from '../lifecycle/errors'

export interface ChatActor {
  companyId: string
  /** `null` = token de API (empresa inteira). */
  userId: string | null
  perms: ReadonlySet<string>
}

/** Escopo do ator: token de API → todos; membro → `loadChatScope` (T31). */
export async function actorScope(db: Database, actor: ChatActor): Promise<ChatScope> {
  if (!actor.userId) return { ...ALL_CHATS }
  return (await loadChatScope(db, actor.companyId, actor.userId)) ?? { departments: [], connections: [] }
}

/** Condição SQL equivalente a `scopeAllows` (chat sem departamento não restringe). */
export function scopeCondition(scope: ChatScope): SQL | undefined {
  const parts: SQL[] = []
  if (scope.departments !== 'all')
    parts.push(scope.departments.length ? or(isNull(chats.departmentId), inArray(chats.departmentId, scope.departments))! : isNull(chats.departmentId))
  if (scope.connections !== 'all') parts.push(scope.connections.length ? inArray(chats.connectionId, scope.connections) : sql`false`)
  return parts.length ? sql.join(parts, sql` and `) : undefined
}

/** Chat fora do escopo se comporta como inexistente (404, SPEC 3.3). */
export function assertInScope(scope: ChatScope, chat: { departmentId: string | null; connectionId: string }): void {
  if (!scopeAllows(scope, { department_id: chat.departmentId, connection_id: chat.connectionId })) throw chatNotFound()
}

export const companyChats = (companyId: string) => eq(chats.companyId, companyId)
