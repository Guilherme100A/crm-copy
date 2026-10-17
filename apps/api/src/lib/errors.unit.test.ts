import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiError, toWireError } from './errors'

describe('toWireError', () => {
  it('ApiError usa o HTTP do catálogo', () => {
    expect(toWireError(new ApiError('LIMIT_REACHED', 'x'))).toMatchObject({ status: 409, code: 'LIMIT_REACHED', message: 'x' })
  })

  it('ZodError → 422 com fields', () => {
    const r = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } })
    expect(toWireError(r.error)).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: { fields: [{ path: 'a.b' }] } })
  })

  it('SyntaxError e HTTPException 400 → MALFORMED_REQUEST', () => {
    expect(toWireError(new SyntaxError('x')).code).toBe('MALFORMED_REQUEST')
    expect(toWireError(new HTTPException(400, { message: 'Malformed JSON in request body' })).code).toBe('MALFORMED_REQUEST')
    expect(toWireError(new HTTPException(413)).code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('erros do WaGateway mantêm código e HTTP', () => {
    const e = Object.assign(new Error('fora'), { name: 'SendRejectedError', code: 'SESSION_NOT_FOUND', status: 404 })
    expect(toWireError(e)).toEqual({ status: 404, code: 'SESSION_NOT_FOUND', message: 'fora' })
  })

  it('capacidade ausente no worker (ex.: ai-manager sem CRM_BRIDGE) → 501 CAPABILITY_NOT_SUPPORTED, não 500', () => {
    const e = Object.assign(new Error('o worker não suporta messages.send (perfil ai-manager)'), {
      name: 'CapabilityNotSupportedError',
      code: 'CAPABILITY_NOT_SUPPORTED',
      status: 501,
    })
    expect(toWireError(e)).toEqual({ status: 501, code: 'CAPABILITY_NOT_SUPPORTED', message: 'o worker não suporta messages.send (perfil ai-manager)' })
  })

  it('desconhecido → 500 INTERNAL genérico', () => {
    expect(toWireError(new Error('detalhe interno'))).toEqual({ status: 500, code: 'INTERNAL', message: 'Internal server error' })
    expect(toWireError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code).toBe('INTERNAL')
  })
})
