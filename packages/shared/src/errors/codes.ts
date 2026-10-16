// Códigos de erro da API (SPEC 3.5) — fonte única. Arquivo compartilhado: novas entradas só de forma aditiva.
import * as z from 'zod'

export const ERROR_CODES = {
  MALFORMED_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  LIMIT_REACHED: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  VALIDATION_ERROR: 422,
  RATE_LIMIT: 429,
  WARMUP_LIMIT: 429,
  QUOTA_EXCEEDED: 429,
  SESSION_NOT_CONNECTED: 409,
  CONTACT_NOT_ALLOWED: 403,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
} as const satisfies Record<string, number>

export type ErrorCode = keyof typeof ERROR_CODES
export type ErrorHttpStatus = (typeof ERROR_CODES)[ErrorCode]

export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as ErrorCode[]

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value)
}

/** HTTP de um código; código desconhecido vira 500 (INTERNAL). */
export function httpStatusOf(code: ErrorCode | (string & {})): number {
  return isErrorCode(code) ? ERROR_CODES[code] : ERROR_CODES.INTERNAL
}

export const errorCodeSchema = z.enum(ERROR_CODE_LIST as [ErrorCode, ...ErrorCode[]])

/** Item de `details.fields` em erros de validação (422). */
export const fieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
})
export type FieldError = z.infer<typeof fieldErrorSchema>

/** Corpo de erro no fio: `{ error: { code, message, details? } }`. */
export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
})
export type ErrorBody = z.infer<typeof errorBodySchema>
