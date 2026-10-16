// Erros da API no formato da SPEC 3.5: `{ error: { code, message, details? } }`. Nunca expõe stack.
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError, type z } from 'zod'
import { ERROR_CODES, type ErrorCode, type FieldError } from '@crm/shared'
import type { AppEnv } from './types'

/** Erro de domínio da API. Lance em handlers/middlewares; `onError` converte para o formato 3.5. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode

  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = ERROR_CODES[code] as ContentfulStatusCode
  }
}

export interface WireError {
  status: ContentfulStatusCode
  code: string
  message: string
  details?: unknown
}

/** Converte issues do zod em `details.fields = [{ path, message }]` (path em pontos: `a.b.0`). */
export function fieldErrors(issues: readonly z.core.$ZodIssue[]): FieldError[] {
  return issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))
}

export function validationError(err: ZodError): ApiError {
  return new ApiError('VALIDATION_ERROR', 'Dados inválidos', { fields: fieldErrors(err.issues) })
}

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: 'MALFORMED_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMIT',
  502: 'UPSTREAM_ERROR',
}

/** Erros da fronteira WhatsApp (`SendRejectedError`, `WaGatewayError`) mantêm código e HTTP (SPEC 3.5). */
const PASSTHROUGH_NAMES = new Set(['SendRejectedError', 'WaGatewayError'])

function passthrough(err: unknown): WireError | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { name?: unknown; code?: unknown; status?: unknown; message?: unknown; details?: unknown }
  if (typeof e.name !== 'string' || !PASSTHROUGH_NAMES.has(e.name)) return null
  if (typeof e.code !== 'string' || typeof e.status !== 'number' || !Number.isInteger(e.status) || e.status < 400 || e.status > 599)
    return null
  return {
    status: e.status as ContentfulStatusCode,
    code: e.code,
    message: typeof e.message === 'string' ? e.message : e.code,
    ...(e.details !== undefined ? { details: e.details } : {}),
  }
}

const INTERNAL: WireError = { status: 500, code: 'INTERNAL', message: 'Internal server error' }

/** Normaliza qualquer erro lançado. Desconhecido → 500 `INTERNAL` com mensagem genérica. */
export function toWireError(err: unknown): WireError {
  if (err instanceof ApiError)
    return { status: err.status, code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) }
  if (err instanceof ZodError) return toWireError(validationError(err))
  // `await c.req.json()` com corpo malformado lança SyntaxError do JSON.parse.
  if (err instanceof SyntaxError) return { status: 400, code: 'MALFORMED_REQUEST', message: 'Corpo da requisição malformado' }
  if (err instanceof HTTPException) {
    const code = STATUS_CODES[err.status]
    if (!code) return INTERNAL
    const message = code === 'MALFORMED_REQUEST' ? 'Corpo da requisição malformado' : err.message || code
    return { status: ERROR_CODES[code] as ContentfulStatusCode, code, message }
  }
  return passthrough(err) ?? INTERNAL
}

export function errorBody(e: WireError) {
  return { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } }
}

export function onError(err: Error, c: Context<AppEnv>) {
  const wire = toWireError(err)
  const log = c.get('logger')
  if (wire.status >= 500) log?.error({ err }, 'unhandled error')
  else log?.debug({ code: wire.code }, wire.message)
  return c.json(errorBody(wire), wire.status)
}

export function notFound(c: Context<AppEnv>) {
  return c.json(errorBody({ status: 404, code: 'NOT_FOUND', message: `Rota não encontrada: ${c.req.method} ${c.req.path}` }), 404)
}
