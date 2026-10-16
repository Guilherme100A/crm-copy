// Erros do repositório de fluxos; a API converte o código para o HTTP da SPEC 3.5 (NOT_FOUND 404, CONFLICT 409,
// VALIDATION_ERROR 422). Recurso de outra empresa é sempre NOT_FOUND (SPEC 1.4 nº 7).

export type FlowStoreErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_ERROR'

export class FlowStoreError extends Error {
  constructor(
    readonly code: FlowStoreErrorCode,
    message: string = code,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'FlowStoreError'
  }
}

/** Violação de unicidade do Postgres (23505), também quando o driver vem embrulhado pelo Drizzle. */
export function uniqueViolation(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const pg = e as { code?: unknown; constraint?: unknown }
    if (pg.code === '23505') return typeof pg.constraint === 'string' ? pg.constraint : ''
  }
  return undefined
}
