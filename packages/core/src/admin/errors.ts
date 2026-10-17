// Erros de domínio do admin interno (T95); a API converte para a SPEC 3.5.

export type AdminErrorCode = 'not_found' | 'validation' | 'conflict'

export class AdminError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    message: string,
    /** `validation`: `{ fields }`; `conflict`: `{ error_code }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AdminError'
  }
}

export const adminNotFound = (what: string) =>
  new AdminError('not_found', `${what} não encontrad${what === 'Empresa' ? 'a' : 'o'}`)

export const adminInvalid = (path: string, message: string) =>
  new AdminError('validation', message, { fields: [{ path, message }] })
