// Comum às rotas de contatos, etiquetas e campos: erro de domínio → SPEC 3.5 e a dependência `waGateway`.
import { ContactsError } from '@crm/core'
import type { WaGateway } from '@crm/wa-port'
import { ApiError } from '../../lib/errors'

declare module '../../lib/types' {
  interface AppDeps {
    /** Fronteira WhatsApp (SPEC 3.2): `wa-gateway-rpc` em produção, `FakeWaGateway` em teste/E2E. */
    waGateway?: WaGateway
  }
}

/** Converte `ContactsError` (not_found 404, conflict 409, validation 422) no erro da API. */
export function toApiError(err: unknown): unknown {
  if (!(err instanceof ContactsError)) return err
  if (err.code === 'not_found') return new ApiError('NOT_FOUND', err.message)
  if (err.code === 'conflict') return new ApiError('CONFLICT', err.message, err.details)
  return new ApiError('VALIDATION_ERROR', err.message, err.details)
}

/** Executa a operação de domínio traduzindo `ContactsError` para o erro da API. */
export async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}
