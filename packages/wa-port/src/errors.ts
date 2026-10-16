// Erros da fronteira WhatsApp (SPEC T03). `SendRejectedError` copia 1:1 a tabela de gates do pipeline do
// ai-manager (packages/core/src/send/pipeline.ts): o código e o HTTP chegam inalterados à API (SPEC 3.5).

/** Ordem fixa dos gates do SendPipeline (ai-manager). */
export const GATE_ORDER = ['auth', 'sessionExists', 'connected', 'contactAllowed', 'warmupLimit', 'rateLimit', 'enqueue'] as const
export type GateName = (typeof GATE_ORDER)[number]

export const SEND_REJECTION_STATUS = {
  UNAUTHORIZED: 401,
  VALIDATION_ERROR: 400,
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_CONNECTED: 409,
  CONTACT_NOT_ALLOWED: 403,
  WARMUP_LIMIT: 429,
  RATE_LIMIT: 429,
} as const
export type SendRejectionCode = keyof typeof SEND_REJECTION_STATUS

export const SEND_REJECTION_CODES = Object.keys(SEND_REJECTION_STATUS) as SendRejectionCode[]

export function isSendRejectionCode(value: unknown): value is SendRejectionCode {
  return typeof value === 'string' && Object.hasOwn(SEND_REJECTION_STATUS, value)
}

export class SendRejectedError extends Error {
  readonly status: number
  /** Gate que rejeitou (preenchido pelo pipeline). */
  gate?: GateName

  constructor(
    readonly code: SendRejectionCode,
    message: string = code,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SendRejectedError'
    this.status = SEND_REJECTION_STATUS[code]
  }
}

/** Reconhece um `SendRejectedError` também quando ele atravessa processos (RPC) e perde o protótipo. */
export function isSendRejectedError(err: unknown): err is SendRejectedError {
  if (err instanceof SendRejectedError) return true
  if (typeof err !== 'object' || err === null) return false
  const e = err as { name?: unknown; code?: unknown; status?: unknown }
  return e.name === 'SendRejectedError' && isSendRejectionCode(e.code) && e.status === SEND_REJECTION_STATUS[e.code]
}

export class TransportNotConnectedError extends Error {
  readonly code = 'TRANSPORT_NOT_CONNECTED'
  constructor(message = 'transporte não está conectado') {
    super(message)
    this.name = 'TransportNotConnectedError'
  }
}

/** Erros das operações que não são envio (sessões, mensagens, mídia), com o HTTP da SPEC 3.5. */
export const WA_GATEWAY_ERROR_STATUS = {
  SESSION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  MEDIA_NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  NOT_SUPPORTED: 501,
} as const
export type WaGatewayErrorCode = keyof typeof WA_GATEWAY_ERROR_STATUS

export class WaGatewayError extends Error {
  readonly status: number

  constructor(
    readonly code: WaGatewayErrorCode,
    message: string = code,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'WaGatewayError'
    this.status = WA_GATEWAY_ERROR_STATUS[code]
  }
}
