// Erros de domínio de contatos, etiquetas e campos personalizados; a API converte para a SPEC 3.5.

export type ContactsErrorCode = 'not_found' | 'conflict' | 'validation'

export class ContactsError extends Error {
  constructor(
    readonly code: ContactsErrorCode,
    message: string,
    /** `conflict`: `{ id, field }` do registro existente. `validation`: `{ fields: [{ path, message }] }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ContactsError'
  }
}

export const notFound = (what: string) => new ContactsError('not_found', `${what} não encontrado`)

export function invalid(path: string, message: string): ContactsError {
  return new ContactsError('validation', message, { fields: [{ path, message }] })
}

/** Violação de unicidade do Postgres (23505), também quando o driver vem embrulhado pelo Drizzle. */
export function uniqueViolation(err: unknown): { constraint?: string } | undefined {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const pg = e as { code?: unknown; constraint?: unknown }
    if (pg.code === '23505') return { constraint: typeof pg.constraint === 'string' ? pg.constraint : undefined }
  }
  return undefined
}
