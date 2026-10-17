// Realtime das conexões (T47 → T71; AC-T71-02/04). Registrado no topo do arquivo de rota (como `chats/route.tsx`):
// handler em módulo lazy não entra no SSE já aberto (docs/licoes.md).
// - `connection.status_changed|connected|disconnected` aplicam o payload na hora nas listas em cache; depois um
//   refetch silencioso (debounce) acerta contadores e o resto do DTO. O harness muda o estado da sessão no fake
//   (rota `/__e2e/wa/sessions/:id/state`), então o refetch confirma o que o evento disse.
// - `connection.qr_updated` / `connection.pairing_code` gravam o valor no cache do QR / do código (modal Conectar).
// - `connection.connected` sinaliza o modal Conectar para fechar.
// - `connection.reconnected_with_paused_flows` abre o modal Retomar/Cancelar.
import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { onRealtime, type RealtimeEnvelope } from '@/lib/realtime'
import { CONNECTIONS_KEY, pairingKey, pausedKey, qrKey, type ConnectionsPage, type PausedFlowsCounts } from './api'
import { patchFromEvent, patchPage } from './logic'

export interface PausedPrompt extends PausedFlowsCounts {
  connection_id: string
  name: string
}

interface UiState {
  /** connection_id → instante (ms) em que chegou o `connected`. */
  connected: Record<string, number>
  pausedPrompt: PausedPrompt | null
}

let state: UiState = { connected: {}, pausedPrompt: null }
const listeners = new Set<() => void>()

function set(next: Partial<UiState>) {
  state = { ...state, ...next }
  for (const l of [...listeners]) l()
}

export const connectionsUi = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  markConnected: (id: string, at = Date.now()) => set({ connected: { ...state.connected, [id]: at } }),
  openPausedPrompt: (p: PausedPrompt) => set({ pausedPrompt: p }),
  closePausedPrompt: () => set({ pausedPrompt: null }),
  reset: () => set({ connected: {}, pausedPrompt: null }),
}

export function useConnectionsUi(): UiState {
  return useSyncExternalStore(connectionsUi.subscribe, connectionsUi.get, connectionsUi.get)
}

const REFETCH_DEBOUNCE_MS = 400
let timer: ReturnType<typeof setTimeout> | undefined

function scheduleRefetch(qc: QueryClient) {
  clearTimeout(timer)
  timer = setTimeout(
    () => void qc.invalidateQueries({ queryKey: [...CONNECTIONS_KEY, 'list'], refetchType: 'active' }),
    REFETCH_DEBOUNCE_MS,
  )
}

/** Aplica o evento nas listas em cache. Devolve se alguma lista tinha a conexão. */
export function applyConnectionEvent(qc: QueryClient, type: string, data: Record<string, unknown>): boolean {
  const patch = patchFromEvent(type, data)
  if (!patch) return false
  let found = false
  for (const [key, page] of qc.getQueriesData<ConnectionsPage>({ queryKey: [...CONNECTIONS_KEY, 'list'] })) {
    if (!page) continue
    const next = patchPage(page, patch)
    if (next) {
      found = true
      qc.setQueryData(key, next)
    }
  }
  return found
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function handleConnectionEvent(e: Pick<RealtimeEnvelope, 'type' | 'data'>, qc: QueryClient): void {
  const data = (e.data ?? {}) as Record<string, unknown>
  const id = typeof data.connection_id === 'string' ? data.connection_id : null
  switch (e.type) {
    case 'connection.qr_updated':
      if (id && typeof data.qr_code === 'string')
        qc.setQueryData(qrKey(id), { qr_code: data.qr_code, generated_at: new Date().toISOString() })
      return
    case 'connection.pairing_code':
      if (id && typeof data.code === 'string') qc.setQueryData(pairingKey(id), data.code)
      return
    case 'connection.reconnected_with_paused_flows':
      if (!id || num(data.paused_count) <= 0) return
      connectionsUi.openPausedPrompt({
        connection_id: id,
        name: typeof data.name === 'string' ? data.name : '',
        paused_count: num(data.paused_count),
        waiting_count: num(data.waiting_count),
        failed_count: num(data.failed_count),
        received_count: num(data.received_count),
        total_leads: num(data.total_leads),
      })
      scheduleRefetch(qc)
      return
    case 'flow.resumed':
      if (id) void qc.invalidateQueries({ queryKey: pausedKey(id) })
      scheduleRefetch(qc)
      return
    case 'connection.connected':
      if (id) connectionsUi.markConnected(id)
      break
    case 'connection.status_changed':
      if (id && data.status === 'connected') connectionsUi.markConnected(id)
      break
  }
  applyConnectionEvent(qc, e.type, data)
  scheduleRefetch(qc)
}

export const CONNECTION_EVENT_TYPES = [
  'connection.created',
  'connection.updated',
  'connection.deleted',
  'connection.status_changed',
  'connection.connected',
  'connection.disconnected',
  'connection.qr_updated',
  'connection.pairing_code',
  'connection.reconnected_with_paused_flows',
  'connection.health_degraded',
  'flow.auto_paused',
  'flow.resumed',
] as const

let registered = false

export function registerConnectionsRealtime(): void {
  if (registered) return
  registered = true
  for (const type of CONNECTION_EVENT_TYPES) onRealtime(type, (e, qc) => handleConnectionEvent(e, qc))
}
