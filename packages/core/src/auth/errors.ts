// Erros de domínio da autenticação; a API converte cada um para o código HTTP da SPEC 3.5.

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_taken'
  | 'current_password_invalid'
  | 'reset_token_gone'
  | 'user_not_found'
  | 'unsupported_media'
  | 'payload_too_large'
  | 'forbidden'

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/** Violação de unicidade do Postgres (23505), também quando o driver vem embrulhado pelo Drizzle. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const pg = e as { code?: unknown; constraint?: unknown }
    if (pg.code === '23505') return constraint === undefined || pg.constraint === constraint
  }
  return false
}
