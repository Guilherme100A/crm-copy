// Erros de domínio das chaves de IA (T38); a API converte para a SPEC 3.5.
import type { AiKeyProvider } from '@crm/db'

export type AiKeysErrorCode = 'not_found' | 'validation' | 'conflict' | 'upstream'

export class AiKeysError extends Error {
  constructor(
    readonly code: AiKeysErrorCode,
    message: string,
    /** `validation`: `{ fields }`; `conflict`: `{ agents, flows }`; `upstream`: `{ provider, status? }`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AiKeysError'
  }
}

export const keyNotFound = () => new AiKeysError('not_found', 'Chave não encontrada')

export function keyInvalid(path: string, message: string): AiKeysError {
  return new AiKeysError('validation', message, { fields: [{ path, message }] })
}

/** Nenhuma chave para o provedor: nem da empresa nem da plataforma (AC-T38-05). */
export class ProviderNotConfiguredError extends Error {
  override readonly name = 'ProviderNotConfiguredError'
  readonly code = 'provider_not_configured' as const

  constructor(readonly provider: AiKeyProvider | (string & {})) {
    super(`Provedor ${provider} sem chave configurada (empresa nem plataforma)`)
  }
}
