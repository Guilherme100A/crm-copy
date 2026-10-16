// Erros do gateway RPC (SPEC T46). Os erros de domínio que atravessam o `POST /internal/rpc` voltam com as classes
// da `@crm/wa-port` (mesmo `code`/`status`), como o bridge do ai-manager (apps/api/src/bridge/client.ts) faz com as
// classes do `@wsm/core`. Falha de rede, timeout, token recusado ou resposta inválida viram `WorkerUnavailableError`.
import {
  isSendRejectionCode,
  SendRejectedError,
  TransportNotConnectedError,
  WA_GATEWAY_ERROR_STATUS,
  WaGatewayError,
  type GateName,
  type WaGatewayErrorCode,
} from '@crm/wa-port'

export type WorkerUnavailableReason = 'unreachable' | 'timeout' | 'unauthorized' | 'invalid_response'

/** O wa-worker não respondeu (fora do ar, timeout, token recusado ou resposta que não é do RPC). */
export class WorkerUnavailableError extends Error {
  readonly code = 'WORKER_UNAVAILABLE'
  readonly status = 503

  constructor(
    message: string,
    readonly reason: WorkerUnavailableReason = 'unreachable',
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'WorkerUnavailableError'
  }
}

/**
 * O perfil do gateway não mapeia o método (capacidade ausente no backend). Lançado ANTES de qualquer chamada de
 * rede; `remote: true` quando foi o próprio worker que não conhece o alvo (`UNKNOWN_METHOD`).
 */
export class CapabilityNotSupportedError extends Error {
  readonly code = 'CAPABILITY_NOT_SUPPORTED'
  readonly status = 501

  constructor(
    readonly method: string,
    readonly profile: string,
    readonly remote = false,
  ) {
    super(remote ? `o worker não suporta ${method} (perfil ${profile})` : `o perfil ${profile} não suporta ${method}`)
    this.name = 'CapabilityNotSupportedError'
  }
}

/** Erro do worker sem classe conhecida: preserva nome, código e o HTTP da resposta. */
export class RemoteRpcError extends Error {
  constructor(
    name: string,
    message: string,
    readonly code: string | undefined,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = name
  }
}

/** Payload `{ error }` serializado pelo wa-worker (apps/wa-worker/src/rpc/errors.ts). */
export interface RemoteErrorPayload {
  name?: unknown
  message?: unknown
  code?: unknown
  status?: unknown
  gate?: unknown
  details?: unknown
  [key: string]: unknown
}

const isWaGatewayErrorCode = (code: unknown): code is WaGatewayErrorCode => typeof code === 'string' && Object.hasOwn(WA_GATEWAY_ERROR_STATUS, code)
const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

/** Recria o erro de domínio a partir do payload do worker. `rpc` = `target.method` chamado. */
export function reviveError(e: RemoteErrorPayload, httpStatus: number, ctx: { rpc: string; profile: string }): Error {
  const name = typeof e.name === 'string' && e.name ? e.name : 'Error'
  const message = typeof e.message === 'string' && e.message ? e.message : 'worker error'
  if (name === 'SendRejectedError' && isSendRejectionCode(e.code)) {
    const err = new SendRejectedError(e.code, message, record(e.details))
    if (typeof e.gate === 'string') err.gate = e.gate as GateName
    return err
  }
  if (e.code === 'UNKNOWN_METHOD') return new CapabilityNotSupportedError(ctx.rpc, ctx.profile, true)
  if (isWaGatewayErrorCode(e.code)) return new WaGatewayError(e.code, message, record(e.details))
  if (name === 'TransportNotConnectedError' || e.code === 'TRANSPORT_NOT_CONNECTED') return new TransportNotConnectedError(message)
  const status = typeof e.status === 'number' ? e.status : httpStatus
  return new RemoteRpcError(name, message, typeof e.code === 'string' ? e.code : undefined, status, e.details)
}
