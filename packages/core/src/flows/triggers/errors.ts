// Erros de domínio dos fluxos padrões por conexão; a API converte para a SPEC 3.5.

export type FlowTriggersErrorCode = 'not_found' | 'validation'

export class FlowTriggersError extends Error {
  constructor(
    readonly code: FlowTriggersErrorCode,
    message: string,
    /** `validation`: `{ fields: [{ path, message }] }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'FlowTriggersError'
  }
}

export const triggersNotFound = (what = 'Conexão') => new FlowTriggersError('not_found', `${what} não encontrada`)

export function triggersInvalid(fields: { path: string; message: string }[]): FlowTriggersError {
  return new FlowTriggersError('validation', fields[0]?.message ?? 'Dados inválidos', { fields })
}
