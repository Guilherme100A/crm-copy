// Erros que atravessam o RPC: serializados como no ai-manager (nome, mensagem e as propriedades que o cliente usa
// para recriar o erro); o HTTP da resposta segue o `status` do erro (SendRejectedError) ou o código.

export interface SerializedError {
  name: string
  message: string
  code?: unknown
  [key: string]: unknown
}

const ERROR_FIELDS = ['code', 'status', 'gate', 'details', 'from', 'to', 'messageId', 'sessionId', 'proxyId', 'reason', 'field']

export function serializeError(err: unknown): SerializedError {
  if (!(err instanceof Error)) return { name: 'Error', message: String(err) }
  const out: SerializedError = { name: err.name, message: err.message }
  for (const k of ERROR_FIELDS) {
    const v = (err as unknown as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

const CODE_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  VALIDATION_ERROR: 422,
  MALFORMED_REQUEST: 400,
  UNKNOWN_METHOD: 400,
  SESSION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  MEDIA_NOT_FOUND: 404,
  MEDIA_UNAVAILABLE: 404,
  PROXY_NOT_FOUND: 404,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  PROXY_IN_USE: 409,
  CONFLICT: 409,
  TRANSPORT_NOT_CONNECTED: 409,
  SESSION_NOT_CONNECTED: 409,
  CONTACT_NOT_ALLOWED: 403,
  WARMUP_LIMIT: 429,
  RATE_LIMIT: 429,
  NOT_SUPPORTED: 501,
}

/** HTTP da resposta de erro: o `status` do próprio erro (ex.: SendRejectedError) vence; senão pelo código. */
export function httpStatusOf(e: SerializedError): number {
  if (typeof e.status === 'number' && e.status >= 400 && e.status <= 599) return e.status
  return (typeof e.code === 'string' && CODE_STATUS[e.code]) || 500
}

/** Erros esperados (de domínio) não são logados como falha do worker. */
export function isDomainError(e: SerializedError): boolean {
  return httpStatusOf(e) < 500 || e.code === 'NOT_SUPPORTED'
}

export class RpcError extends Error {
  constructor(
    readonly code: 'UNKNOWN_METHOD' | 'MALFORMED_REQUEST' | 'VALIDATION_ERROR' | 'NOT_SUPPORTED' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}
