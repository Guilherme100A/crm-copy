// `job.progress` dos jobs da T86 (o handler da T77 ignora `contacts_import`): importação em cache (terminou → nova
// busca com o relatório, lista e etiquetas) e exportação (o painel de recentes recarrega). O tipo `job.progress` já é
// registrado no carregamento de `/customers` (T77), então este handler entra no SSE aberto mesmo vindo depois.
import type { QueryClient } from '@tanstack/react-query'
import { CONTACTS_KEY, mergeJobProgress, type JobDto } from '@/features/contacts/api'
import { onRealtime } from '@/lib/realtime'
import { importJobKey, RECENT_EXPORTS_KEY } from './api'

export function applyContactJobProgress(queryClient: QueryClient, data: unknown): void {
  const ev = data as (Partial<JobDto> & { job_id?: string }) | null
  if (!ev?.job_id) return
  const done = ev.status === 'completed' || ev.status === 'failed'
  if (ev.kind === 'contacts_import') {
    const key = importJobKey(ev.job_id)
    queryClient.setQueryData<JobDto>(key, (old) => (old ? mergeJobProgress(old, ev) : old))
    if (done) {
      void queryClient.invalidateQueries({ queryKey: key })
      void queryClient.invalidateQueries({ queryKey: [...CONTACTS_KEY, 'list'] })
      void queryClient.invalidateQueries({ queryKey: [...CONTACTS_KEY, 'labels'] })
    }
  } else if (ev.kind === 'contacts_export' && (done || ev.status === 'processing')) {
    void queryClient.invalidateQueries({ queryKey: RECENT_EXPORTS_KEY })
  }
}

let registered = false

export function registerContactJobsRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('job.progress', (e, qc) => applyContactJobProgress(qc, e.data))
}
