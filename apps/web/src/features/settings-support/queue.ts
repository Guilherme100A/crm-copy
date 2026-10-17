// Fila do modal global de aprovação (16 §5 "Acesso de suporte", §7; AC-T54-05): os eventos `support_access.*`
// do SSE mexem no cache da lista de pendentes; aprovar/recusar tira o pedido e o modal passa ao próximo.
import type { QueryClient } from '@tanstack/react-query'
import type { RealtimeEnvelope } from '@/lib/realtime'
import type { Session } from '@/lib/session'
import { companyGrantsKey, pendingRequestsKey, type SupportAccessRequestDto } from './api'

/** Modal e aba só para owner/admin da empresa ativa (16 §8.4); o próprio suporte nunca. */
export const canReviewSupport = (s: Pick<Session, 'company' | 'role' | 'isSupport'>) =>
  !!s.company && !s.isSupport && (s.role === 'owner' || s.role === 'admin')

/** Acrescenta (ou atualiza) um pedido pendente, mantendo a ordem de chegada; pedido já decidido sai. */
export function upsertPending(list: readonly SupportAccessRequestDto[], req: SupportAccessRequestDto): SupportAccessRequestDto[] {
  if (req.status !== 'pending') return removeRequest(list, req.id)
  const i = list.findIndex((r) => r.id === req.id)
  if (i < 0) return [...list, req]
  const next = [...list]
  next[i] = { ...next[i]!, ...req }
  return next
}

export const removeRequest = (list: readonly SupportAccessRequestDto[], id: string) => list.filter((r) => r.id !== id)

/** Os que o modal mostra (sem os dispensados com "fechar" nesta sessão). */
export const visibleQueue = (list: readonly SupportAccessRequestDto[], dismissed: ReadonlySet<string>) =>
  list.filter((r) => !dismissed.has(r.id))

type EventData = { request?: SupportAccessRequestDto; grant?: { id: string } }

const REMOVES = new Set(['support_access.cancelled', 'support_access.granted', 'support_access.rejected'])

/** Aplica um evento `support_access.*` ao cache da empresa do evento. */
export function applySupportEvent(event: RealtimeEnvelope, qc: QueryClient): void {
  const data = (event.data ?? {}) as EventData
  const key = pendingRequestsKey(event.company_id)
  const req = data.request
  if (event.type === 'support_access.requested' && req) {
    // Lista ainda não carregada: busca (o pedido novo vem junto).
    if (qc.getQueryData(key) === undefined) void qc.invalidateQueries({ queryKey: key })
    else qc.setQueryData<SupportAccessRequestDto[]>(key, (old) => upsertPending(old ?? [], { ...req, status: req.status ?? 'pending' }))
  }
  if (REMOVES.has(event.type) && req)
    qc.setQueryData<SupportAccessRequestDto[]>(key, (old) => (old ? removeRequest(old, req.id) : old))
  if (event.type === 'support_access.granted' || event.type === 'support_access.revoked')
    void qc.invalidateQueries({ queryKey: companyGrantsKey(event.company_id) })
}

export const SUPPORT_EVENT_TYPES = [
  'support_access.requested',
  'support_access.granted',
  'support_access.rejected',
  'support_access.revoked',
  'support_access.cancelled',
] as const
