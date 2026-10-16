// Erros de domínio dos agentes de IA; a API converte para a SPEC 3.5.

export type AiAgentsErrorCode =
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'invalid_transition'
  | 'limit_reached'
  | 'payload_too_large'
  | 'unsupported_media'

export class AiAgentsError extends Error {
  constructor(
    readonly code: AiAgentsErrorCode,
    message: string,
    /** `validation`: `{ fields, error_code? }`; `conflict`: `{ references }`; `limit_reached`: `{ limit, used }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AiAgentsError'
  }
}

export const agentNotFound = () => new AiAgentsError('not_found', 'Agente não encontrado')

export function agentInvalid(path: string, message: string, errorCode?: string): AiAgentsError {
  return new AiAgentsError('validation', message, { ...(errorCode ? { error_code: errorCode } : {}), fields: [{ path, message }] })
}
