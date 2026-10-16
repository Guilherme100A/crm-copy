// Estados da mensagem (SPEC 3.3): queued → processing → sent → delivered → read, com retrying, failed e cancelled.
import { MESSAGE_STATUSES, type MessageStatus } from '../db'

export { MESSAGE_STATUSES, type MessageStatus }

/** Transições permitidas. Toda transição grava uma linha em `message_events`. */
export const MESSAGE_TRANSITIONS: Record<MessageStatus, readonly MessageStatus[]> = {
  queued: ['processing', 'cancelled', 'failed'],
  processing: ['sent', 'retrying', 'failed'],
  retrying: ['processing', 'cancelled', 'failed'],
  sent: ['delivered', 'read'],
  delivered: ['read'],
  read: [],
  failed: [],
  cancelled: [],
}

/** Estados em que a mensagem ainda pode ser cancelada (nunca chegou ao transporte com sucesso). */
export const CANCELLABLE_STATUSES: readonly MessageStatus[] = ['queued', 'retrying']

export function canTransitionMessage(from: MessageStatus, to: MessageStatus): boolean {
  return MESSAGE_TRANSITIONS[from].includes(to)
}

export class MessageTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION'
  constructor(
    readonly from: MessageStatus,
    readonly to: MessageStatus,
    message = `invalid message transition: ${from} → ${to}`,
  ) {
    super(message)
    this.name = 'MessageTransitionError'
  }
}

export class MessageNotFoundError extends Error {
  readonly code = 'MESSAGE_NOT_FOUND'
  constructor(readonly messageId: string) {
    super(`message ${messageId} not found`)
    this.name = 'MessageNotFoundError'
  }
}
