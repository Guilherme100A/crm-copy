// Realtime do kanban (T50 `kanban.*`): o quadro afetado e a lista de quadros são recarregados com debounce (o refetch
// mantém o tanto de cards já carregado por coluna). Mensagens/chats novos atualizam prévia e não lidas dos cards.
import type { QueryClient } from '@tanstack/react-query'
import { onRealtime, type RealtimeEnvelope } from '@/lib/realtime'
import { boardKey, boardsKey, CRMS_KEY } from './api'

const DEBOUNCE_MS = 400

export const KANBAN_EVENTS = ['kanban.card.created', 'kanban.card.updated', 'kanban.card.moved', 'kanban.card.deleted', 'kanban.column.changed'] as const

/** Agenda os refetches; `crmId` null = todos os quadros abertos. */
export function createRefresher(delay = DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<string | null>()
  return (queryClient: QueryClient, crmId: string | null) => {
    pending.add(crmId)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const ids = [...pending]
      pending.clear()
      if (ids.includes(null)) void queryClient.invalidateQueries({ queryKey: [...CRMS_KEY, 'board'] })
      else for (const id of ids) void queryClient.invalidateQueries({ queryKey: boardKey(id!) })
      void queryClient.invalidateQueries({ queryKey: boardsKey })
    }, delay)
  }
}

let registered = false

/** Registra os handlers (idempotente). Chamado no carregamento do módulo das rotas `/crms`. */
export function registerCrmsRealtime(): void {
  if (registered) return
  registered = true
  const refresh = createRefresher()
  const onKanban = (e: RealtimeEnvelope, queryClient: QueryClient) => {
    const crmId = (e.data as { crm_id?: unknown } | null)?.crm_id
    refresh(queryClient, typeof crmId === 'string' ? crmId : null)
  }
  for (const type of KANBAN_EVENTS) onRealtime(type, onKanban)
  // Prévia/não lidas dos cards vêm do chat: só os quadros abertos (queries ativas) refazem a busca.
  const onChat = (_e: RealtimeEnvelope, queryClient: QueryClient) => {
    if (queryClient.getQueryCache().findAll({ queryKey: [...CRMS_KEY, 'board'], type: 'active' }).length) refresh(queryClient, null)
  }
  onRealtime('chat.updated', onChat)
  onRealtime('message.created', onChat)
}
