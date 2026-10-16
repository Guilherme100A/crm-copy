// Erros de domínio das conexões; a API converte para o código/HTTP da SPEC 3.5.

export type ConnectionsErrorCode = 'not_found' | 'validation' | 'limit_reached' | 'invalid_transition' | 'not_supported' | 'upstream'

export class ConnectionsError extends Error {
  constructor(
    readonly code: ConnectionsErrorCode,
    message: string,
    /** `validation`: `{ fields }`; `limit_reached`: `{ limit, used }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ConnectionsError'
  }
}
