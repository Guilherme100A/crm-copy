// Realtime dos disparos (T74 → T83; AC-T83-04): `mass_dispatch.updated` (no máximo 1/s por disparo) aplica status,
// fase da preparação e contagens no detalhe e nas listas em cache; depois um refetch silencioso (debounce) acerta a
// cota e o resto do DTO. Registrado no topo do arquivo de rota: handler em módulo lazy não entra no SSE já aberto
// (docs/licoes.md).
import type { QueryClient } from '@tanstack/react-query'
import { onRealtime, type RealtimeEnvelope } from '@/lib/realtime'
import { MASS_DISPATCH_KEY, detailKey, quotaKey, type MassDispatchDto, type MassDispatchesPage } from './api'
import { patchDispatch, patchPage } from './logic'

export const MASS_DISPATCH_EVENT = 'mass_dispatch.updated'

const REFETCH_DEBOUNCE_MS = 400
let timer: ReturnType<typeof setTimeout> | undefined

function scheduleRefetch(qc: QueryClient) {
  clearTimeout(timer)
  timer = setTimeout(() => {
    void qc.invalidateQueries({ queryKey: [...MASS_DISPATCH_KEY, 'list'], refetchType: 'active' })
    void qc.invalidateQueries({ queryKey: quotaKey, refetchType: 'active' })
  }, REFETCH_DEBOUNCE_MS)
}

/** Aplica o evento no cache. Devolve se o disparo estava em alguma lista ou no detalhe. */
export function applyMassDispatchEvent(qc: QueryClient, data: Record<string, unknown>): boolean {
  const id = typeof data.mass_dispatch_id === 'string' ? data.mass_dispatch_id : null
  if (!id) return false
  let found = false
  const detail = qc.getQueryData<MassDispatchDto>(detailKey(id))
  if (detail) {
    qc.setQueryData(detailKey(id), patchDispatch(detail, data))
    found = true
  }
  for (const [key, page] of qc.getQueriesData<MassDispatchesPage>({ queryKey: [...MASS_DISPATCH_KEY, 'list'] })) {
    if (!page) continue
    const next = patchPage(page, id, data)
    if (next) {
      qc.setQueryData(key, next)
      found = true
    }
  }
  return found
}

export function handleMassDispatchEvent(e: Pick<RealtimeEnvelope, 'type' | 'data'>, qc: QueryClient): void {
  if (e.type !== MASS_DISPATCH_EVENT) return
  applyMassDispatchEvent(qc, (e.data ?? {}) as Record<string, unknown>)
  scheduleRefetch(qc)
}

let registered = false

export function registerMassDispatchRealtime(): void {
  if (registered) return
  registered = true
  onRealtime(MASS_DISPATCH_EVENT, (e, qc) => handleMassDispatchEvent(e, qc))
}
