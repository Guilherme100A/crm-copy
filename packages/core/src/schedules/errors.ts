// Erros de domínio dos agendamentos; a API converte para a SPEC 3.5.
export type SchedulesErrorCode = 'not_found' | 'validation' | 'conflict'

export class SchedulesError extends Error {
  constructor(
    readonly code: SchedulesErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SchedulesError'
  }
}

export const scheduleNotFound = () => new SchedulesError('not_found', 'Agendamento não encontrado')

export function scheduleInvalid(path: string, message: string): SchedulesError {
  return new SchedulesError('validation', message, { fields: [{ path, message }] })
}
