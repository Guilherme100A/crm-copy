// Erros de domínio de vendas, produtos, despesas e grupos de filtro; a API converte para a SPEC 3.5.

export type SalesErrorCode = 'not_found' | 'validation' | 'conflict'

export class SalesError extends Error {
  constructor(
    readonly code: SalesErrorCode,
    message: string,
    /** `validation`/`conflict`: `{ fields: [{ path, message }], reason? }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SalesError'
  }
}

export const salesNotFound = (what: string) => new SalesError('not_found', `${what} não encontrado`)

export function salesInvalid(fields: { path: string; message: string }[]): SalesError {
  return new SalesError('validation', fields[0]?.message ?? 'Dados inválidos', { fields })
}

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'))

/** Código ISO 4217 em maiúsculas, ou `null` se não existir. */
export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) && CURRENCIES.has(code) ? code : null
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
