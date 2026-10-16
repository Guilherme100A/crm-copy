// Erros de domínio de departamentos e horários; a API converte para a SPEC 3.5.

export type DepartmentsErrorCode = 'not_found' | 'validation'

export class DepartmentsError extends Error {
  constructor(
    readonly code: DepartmentsErrorCode,
    message: string,
    /** `validation`: `{ fields: [{ path, message }] }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DepartmentsError'
  }
}

export const deptNotFound = (what = 'Departamento') => new DepartmentsError('not_found', `${what} não encontrado`)

export function deptInvalid(fields: { path: string; message: string }[]): DepartmentsError {
  return new DepartmentsError('validation', fields[0]?.message ?? 'Dados inválidos', { fields })
}
