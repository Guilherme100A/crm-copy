// Status de UI da conexão (08-conexoes.md §4 + compatibilidade Baileys): função pura sobre o estado da sessão no
// gateway e o último `session.connection` conhecido. `forbidden` (403) vira `banned` (status próprio do clone).
import type { DisconnectKind, SessionState } from '@crm/wa-port'

export const CONNECTION_UI_STATUSES = ['pending', 'connecting', 'connected', 'paused', 'disconnected', 'banned'] as const
export type ConnectionUiStatus = (typeof CONNECTION_UI_STATUSES)[number]

export type ConnectionBadge = 'warming' | 'degraded' | 'requires_restart' | 'scheduled_deletion'

export interface ConnectionStatusInput {
  /** Estado da sessão no gateway; `null` = sessão não encontrada. */
  sessionState: SessionState | null
  /** Último `session.connection` (`null` = desconhecido; conta como aberto nos estados conectados). */
  connectionState: 'open' | 'close' | null
  lastDisconnectReason: DisconnectKind | null
  /** QR ou código já pedido (antes da primeira conexão). */
  qrRequested?: boolean
  requiresRestart?: boolean
  scheduledForDeletion?: boolean
}

export interface ConnectionStatusView {
  status: ConnectionUiStatus
  badges: ConnectionBadge[]
}

const LIVE: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED']

export function deriveConnectionStatus(input: ConnectionStatusInput): ConnectionStatusView {
  const badges: ConnectionBadge[] = []
  if (input.sessionState === 'WARMING') badges.push('warming')
  if (input.sessionState === 'DEGRADED') badges.push('degraded')
  if (input.requiresRestart) badges.push('requires_restart')
  if (input.scheduledForDeletion) badges.push('scheduled_deletion')
  return { status: uiStatus(input), badges }
}

function uiStatus(i: ConnectionStatusInput): ConnectionUiStatus {
  const state = i.sessionState
  const open = i.connectionState !== 'close'
  if (i.lastDisconnectReason === 'forbidden' && !(state && LIVE.includes(state) && i.connectionState === 'open')) return 'banned'
  if (state === null || state === 'DISCONNECTED') return 'disconnected'
  if (state === 'PAUSED') return 'paused'
  if (LIVE.includes(state)) return open ? 'connected' : 'connecting'
  // NEW: ainda não autenticou.
  return i.qrRequested ? 'connecting' : 'pending'
}
