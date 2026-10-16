// Realtime da página de contatos: `job.progress` (T27) atualiza a exportação/exclusão em massa em cache e
// `contact.updated` recarrega a lista. Registrado no carregamento da rota (antes de o shell abrir o SSE).
import type { QueryClient } from '@tanstack/react-query'
import { onRealtime, type RealtimeEnvelope } from '@/lib/realtime'
import { CONTACTS_KEY, jobKey, mergeJobProgress, type JobDto } from './api'

const KINDS: Record<string, 'export' | 'bulk-delete'> = { contacts_export: 'export', contacts_bulk_delete: 'bulk-delete' }

export function applyJobProgress(queryClient: QueryClient, data: unknown): void {
  const ev = data as (Partial<JobDto> & { job_id?: string }) | null
  const kind = ev?.kind ? KINDS[ev.kind] : undefined
  if (!ev?.job_id || !kind) return
  const key = jobKey(kind, ev.job_id)
  queryClient.setQueryData<JobDto>(key, (old) => (old ? mergeJobProgress(old, ev) : old))
  // Terminou: a busca do job traz o link do arquivo e os contadores finais.
  if (ev.status === 'completed' || ev.status === 'failed') void queryClient.invalidateQueries({ queryKey: key })
}

let registered = false

export function registerContactsRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('job.progress', (e: RealtimeEnvelope, qc) => applyJobProgress(qc, e.data))
  onRealtime('contact.updated', (_e, qc) => void qc.invalidateQueries({ queryKey: [...CONTACTS_KEY, 'list'] }))
}
