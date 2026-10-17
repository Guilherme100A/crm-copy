// Realtime do indicador (T107; 18 §7 adaptado). O shell importa este módulo de forma ESTÁTICA: os handlers precisam
// estar registrados antes de o SSE abrir. Uma queda publica `connection.updated`/`status_changed` antes do
// `connection.disconnected`; para não gerar consulta, a queda liga o indicador direto no cache (AC-T107-02) e só a
// reconexão e a exclusão refazem a consulta (a queda pode ter sido de outra conexão, ou a excluída era a que caiu).
import type { QueryClient } from '@tanstack/react-query'
import { onRealtime, type RealtimeEnvelope } from '@/lib/realtime'
import { disconnectAlertKey, type DisconnectAlertDto } from './api'

export const DROP_EVENTS = [
  'connection.disconnected',
  'connection.disconnected_alert',
  'connection.banned_alert',
  'flow.auto_paused',
] as const
export const REFETCH_EVENTS = ['connection.connected', 'connection.deleted'] as const

/** Liga o indicador da empresa do evento com o `disconnected_at` da queda (ou a hora do evento). */
export function applyDrop(e: RealtimeEnvelope, qc: QueryClient): void {
  const data = (e.data ?? {}) as { disconnected_at?: string | null }
  const at = data.disconnected_at || e.at || new Date().toISOString()
  qc.setQueryData<DisconnectAlertDto>(disconnectAlertKey(e.company_id), (prev) => ({
    has_recent_disconnected: true,
    last_disconnected_at: prev?.last_disconnected_at && prev.last_disconnected_at > at ? prev.last_disconnected_at : at,
  }))
}

export function refetchAlert(e: RealtimeEnvelope, qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: disconnectAlertKey(e.company_id) })
}

for (const type of DROP_EVENTS) onRealtime(type, applyDrop)
for (const type of REFETCH_EVENTS) onRealtime(type, refetchAlert)
