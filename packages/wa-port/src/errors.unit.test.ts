import { describe, expect, it } from 'vitest'
import { isSendRejectedError, SEND_REJECTION_STATUS, SendRejectedError, TransportNotConnectedError, WaGatewayError, type SendRejectionCode } from './errors'

describe('SendRejectedError', () => {
  it('tem code e status iguais à tabela do pipeline do ai-manager', () => {
    expect(SEND_REJECTION_STATUS).toEqual({
      UNAUTHORIZED: 401,
      VALIDATION_ERROR: 400,
      SESSION_NOT_FOUND: 404,
      SESSION_NOT_CONNECTED: 409,
      CONTACT_NOT_ALLOWED: 403,
      WARMUP_LIMIT: 429,
      RATE_LIMIT: 429,
    })
    for (const [code, status] of Object.entries(SEND_REJECTION_STATUS)) {
      const err = new SendRejectedError(code as SendRejectionCode, 'x', { a: 1 })
      expect(err).toBeInstanceOf(Error)
      expect(err).toMatchObject({ name: 'SendRejectedError', code, status, message: 'x', details: { a: 1 } })
    }
  })

  it('isSendRejectedError reconhece o erro serializado (RPC)', () => {
    expect(isSendRejectedError(new SendRejectedError('RATE_LIMIT', 'limit'))).toBe(true)
    expect(isSendRejectedError({ name: 'SendRejectedError', code: 'RATE_LIMIT', status: 429 })).toBe(true)
    expect(isSendRejectedError({ name: 'SendRejectedError', code: 'RATE_LIMIT', status: 500 })).toBe(false)
    expect(isSendRejectedError(new Error('x'))).toBe(false)
  })

  it('TransportNotConnectedError e WaGatewayError', () => {
    expect(new TransportNotConnectedError()).toMatchObject({ name: 'TransportNotConnectedError', code: 'TRANSPORT_NOT_CONNECTED' })
    expect(new WaGatewayError('INVALID_TRANSITION')).toMatchObject({ name: 'WaGatewayError', status: 409 })
  })
})
