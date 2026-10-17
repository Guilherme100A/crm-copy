// Erros de domínio das operações do admin (T96); a API converte para a SPEC 3.5.

export type AdminOpsErrorCode = 'not_found' | 'validation'

export class AdminOpsError extends Error {
  constructor(
    readonly code: AdminOpsErrorCode,
    message: string,
    /** `validation`: `{ fields: [{ path, message }] }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AdminOpsError'
  }
}

export const notFound = (what: string) => new AdminOpsError('not_found', `${what} não encontrado`)

export function invalid(path: string, message: string): AdminOpsError {
  return new AdminOpsError('validation', message, { fields: [{ path, message }] })
}
