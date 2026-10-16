import { describe, expect, it } from 'vitest'
import { ERROR_CODES, ERROR_CODE_LIST, errorBodySchema, httpStatusOf, isErrorCode } from './codes'

describe('errors/codes', () => {
  it('tem exatamente os 18 códigos da SPEC 3.5', () => {
    expect(ERROR_CODE_LIST).toHaveLength(18)
    expect(ERROR_CODES).toMatchObject({ NOT_FOUND: 404, VALIDATION_ERROR: 422, SESSION_NOT_CONNECTED: 409, CONTACT_NOT_ALLOWED: 403 })
  })

  it('httpStatusOf devolve o HTTP de cada código e 500 para desconhecido', () => {
    for (const code of ERROR_CODE_LIST) expect(httpStatusOf(code)).toBe(ERROR_CODES[code])
    expect(httpStatusOf('NOPE')).toBe(500)
  })

  it('isErrorCode não aceita chaves do protótipo', () => {
    expect(isErrorCode('RATE_LIMIT')).toBe(true)
    expect(isErrorCode('toString')).toBe(false)
  })

  it('errorBodySchema valida o formato do fio', () => {
    expect(errorBodySchema.safeParse({ error: { code: 'GONE', message: 'x' } }).success).toBe(true)
    expect(errorBodySchema.safeParse({ error: { code: 'BOOM', message: 'x' } }).success).toBe(false)
  })
})
