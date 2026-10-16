// Máquina de estados da sessão (SPEC 3.8; fork de ai-manager core/session/states.ts).
import { SESSION_STATUSES, type SessionStatus } from '../db'

export const SESSION_STATES = SESSION_STATUSES
export type SessionState = SessionStatus

/**
 * Transições permitidas. Mesmo estado → mesmo estado nunca é transição.
 * - NEW → WARMING (autenticou)
 * - WARMING → STABLE (warm-up concluído)
 * - WARMING|STABLE → DEGRADED; DEGRADED → WARMING|STABLE (health recuperado)
 * - WARMING|STABLE|DEGRADED → PAUSED; PAUSED → WARMING|STABLE (somente resume manual)
 * - * → DISCONNECTED; DISCONNECTED → NEW (re-autenticação)
 */
export const SESSION_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  NEW: ['WARMING', 'DISCONNECTED'],
  WARMING: ['STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED'],
  STABLE: ['DEGRADED', 'PAUSED', 'DISCONNECTED'],
  DEGRADED: ['WARMING', 'STABLE', 'PAUSED', 'DISCONNECTED'],
  PAUSED: ['WARMING', 'STABLE', 'DISCONNECTED'],
  DISCONNECTED: ['NEW'],
}

/** Estados com a conta autenticada e conexão esperada. */
export const CONNECTED_STATES: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED', 'PAUSED']
/** Estados que permitem envio (SESSION_NOT_CONNECTED fora deles). DEGRADED envia em ritmo reduzido. */
export const SENDABLE_STATES: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED']

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value)
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from]?.includes(to) ?? false
}

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION'
  constructor(
    readonly from: SessionState,
    readonly to: SessionState | string,
    message = `transição de sessão inválida: ${from} → ${to}`,
  ) {
    super(message)
    this.name = 'InvalidTransitionError'
  }
}

export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to)
}

/** Ações manuais sobre a sessão e os estados de origem em que cada uma é válida. */
export type SessionAction = 'pause' | 'resume' | 'restart' | 'logout' | 'connect'

export const ACTION_SOURCES: Record<SessionAction, readonly SessionState[]> = {
  pause: ['WARMING', 'STABLE', 'DEGRADED'],
  resume: ['PAUSED'],
  // restart não muda o estado: fecha e reabre a conexão (aplica troca de proxy).
  restart: ['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED'],
  logout: ['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED'],
  // Iniciar autenticação (QR/pairing): só sessões ainda não autenticadas (DISCONNECTED passa por NEW).
  connect: ['NEW', 'DISCONNECTED'],
}

export function assertAction(action: SessionAction, from: SessionState): void {
  if (!ACTION_SOURCES[action].includes(from)) {
    throw new InvalidTransitionError(from, action, `ação "${action}" não permitida no estado ${from}`)
  }
}
