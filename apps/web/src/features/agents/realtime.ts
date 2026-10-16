// Realtime dos agentes: `ai_knowledge_source.updated` (T52) atualiza a fonte na lista de conhecimento do agente em
// cache, sem recarregar a página (AC-T88-04). Registrado no carregamento das rotas de `/agentes`.
import type { QueryClient } from '@tanstack/react-query'
import { onRealtime, type RealtimeEnvelope } from '@/lib/realtime'
import { knowledgeKey, type KnowledgeSource } from './api'

interface SourceEvent {
  agent_id?: string
  source_id?: string
  status?: KnowledgeSource['status'] | 'deleted'
  source?: Partial<KnowledgeSource> & { id: string }
}

export function applyKnowledgeEvent(qc: QueryClient, data: unknown): void {
  const ev = data as SourceEvent | null
  if (!ev?.agent_id || !ev.source_id) return
  const key = knowledgeKey(ev.agent_id)
  if (!qc.getQueryData(key)) {
    void qc.invalidateQueries({ queryKey: key })
    return
  }
  qc.setQueryData<KnowledgeSource[]>(key, (old) => {
    const list = old ?? []
    if (ev.status === 'deleted') return list.filter((s) => s.id !== ev.source_id)
    const i = list.findIndex((s) => s.id === ev.source_id)
    if (i < 0) return ev.source ? [...list, ev.source as KnowledgeSource] : list
    const next = [...list]
    next[i] = { ...next[i]!, ...(ev.source ?? {}), ...(ev.status ? { status: ev.status } : {}) }
    return next
  })
  // Fonte nova sem o DTO no evento: busca a lista.
  if (
    !ev.source &&
    ev.status !== 'deleted' &&
    !(qc.getQueryData<KnowledgeSource[]>(key) ?? []).some((s) => s.id === ev.source_id)
  )
    void qc.invalidateQueries({ queryKey: key })
}

let registered = false

export function registerAgentsRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('ai_knowledge_source.updated', (e: RealtimeEnvelope, qc) => applyKnowledgeEvent(qc, e.data))
}
