// Filtros de escopo de chat (SPEC 3.3/3.7): cada módulo registra o seu (departamentos, conexões…).
// Owner/admin ignoram o escopo. Para os demais, o evento com `scope` só é entregue se TODOS os filtros
// aceitarem. Sem filtro registrado, o escopo do membro é "vazio = todos" e o evento é entregue.
import type { RealtimeScope, ScopeSubject, WireEnvelope } from './types'

export type ScopeFilter = (subject: ScopeSubject, scope: RealtimeScope, envelope: WireEnvelope) => boolean | Promise<boolean>

const filters = new Set<ScopeFilter>()

/** Registra um filtro; devolve a função que desfaz o registro. */
export function registerScopeFilter(filter: ScopeFilter): () => void {
  filters.add(filter)
  return () => {
    filters.delete(filter)
  }
}

/** Remove todos os filtros (testes). */
export function clearScopeFilters(): void {
  filters.clear()
}

export const bypassesScope = (role: ScopeSubject['role'] | null) => role === null || role === 'owner' || role === 'admin'

/** `subject === null` = token de API (acesso da empresa inteira). Filtro que lança nega a entrega. */
export async function passesScope(subject: ScopeSubject | null, scope: RealtimeScope | null, envelope: WireEnvelope): Promise<boolean> {
  if (!scope || !subject || bypassesScope(subject.role)) return true
  for (const filter of [...filters]) {
    try {
      if (!(await filter(subject, scope, envelope))) return false
    } catch {
      return false
    }
  }
  return true
}
