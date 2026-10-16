// Erros de domínio da lista e do ciclo de vida dos chats; a API converte para a SPEC 3.5.

export type ChatsErrorCode = 'not_found' | 'validation' | 'invalid_transition' | 'forbidden'

export class ChatsError extends Error {
  constructor(
    readonly code: ChatsErrorCode,
    message: string,
    /** `validation`: `{ fields: [{ path, message }] }`; `invalid_transition`: `{ from, action }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ChatsError'
  }
}

export const chatNotFound = () => new ChatsError('not_found', 'Chat não encontrado')

export function chatInvalid(path: string, message: string): ChatsError {
  return new ChatsError('validation', message, { fields: [{ path, message }] })
}
