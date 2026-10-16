// Realtime das ferramentas do kanban (T76): `job.progress` (T27) atualiza o job da exportação em cache e `kanban.*`
// marca as estatísticas do quadro para recarregar. Registrado no carregamento da rota do quadro (antes do SSE abrir).
import type { QueryClient } from '@tanstack/react-query'
import { onRealtime, type RealtimeEnvelope } from '@/lib/realtime'
import { mergeJobProgress, statsKey, type JobDto } from './api'

export const jobKey = (id: string) => ['kanban-tools', 'job', id] as const

const KANBAN_EVENTS = ['kanban.card.created', 'kanban.card.updated', 'kanban.card.moved', 'kanban.card.deleted', 'kanban.column.changed'] as const

export function applyJobProgress(queryClient: QueryClient, data: unknown): void {
  const ev = data as (Partial<JobDto> & { job_id?: string }) | null
  if (!ev?.job_id) return
  queryClient.setQueryData<JobDto>(jobKey(ev.job_id), (old) => (old ? mergeJobProgress(old, ev) : old))
  // Terminou: a busca do job traz o link do arquivo.
  if (ev.status === 'completed' || ev.status === 'failed') void queryClient.invalidateQueries({ queryKey: jobKey(ev.job_id) })
}

let registered = false

export function registerKanbanToolsRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('job.progress', (e: RealtimeEnvelope, qc) => applyJobProgress(qc, e.data))
  for (const type of KANBAN_EVENTS)
    onRealtime(type, (e: RealtimeEnvelope, qc) => {
      const crmId = (e.data as { crm_id?: unknown } | null)?.crm_id
      void qc.invalidateQueries({ queryKey: typeof crmId === 'string' ? statsKey(crmId) : ['crms', 'stats'] })
    })
}
