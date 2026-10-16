import { describe, expect, it } from 'vitest'
import { PhoneError, isE164, parsePhone, phoneInputSchema, toE164, tryParsePhone } from './phone'

describe('phone', () => {
  it('normaliza formatos BR para E.164', () => {
    expect(parsePhone('+55 (11) 99999-8888')).toBe('+5511999998888')
    expect(parsePhone('(11) 99999-8888')).toBe('+5511999998888')
    expect(parsePhone('11 3333-4444')).toBe('+551133334444')
    expect(parsePhone('5511999998888')).toBe('+5511999998888')
    expect(parsePhone('005511999998888')).toBe('+5511999998888')
  })

  it('aceita números internacionais', () => {
    expect(parsePhone('+1 213 373 4253')).toBe('+12133734253')
  })

  it('rejeita celular BR de 9 dígitos sem DDD', () => {
    expect(() => parsePhone('99999-8888')).toThrow(PhoneError)
    expect(tryParsePhone('999998888')).toBeNull()
    expect(() => parsePhone('+55 99999-8888')).toThrow(PhoneError)
  })

  it('rejeita lixo e números longos demais', () => {
    expect(() => parsePhone('abc')).toThrow(PhoneError)
    expect(() => parsePhone('+55 11 99999 88888 7777')).toThrow(PhoneError)
  })

  it('toE164 rejeita menos de 8 dígitos', () => {
    expect(() => toE164('1234567')).toThrow(PhoneError)
    expect(() => toE164('+55 12')).toThrow(PhoneError)
    expect(toE164('11999998888')).toBe('+5511999998888')
  })

  it('isE164 e schemas', () => {
    expect(isE164('+5511999998888')).toBe(true)
    expect(isE164('5511999998888')).toBe(false)
    expect(phoneInputSchema.parse('(11) 99999-8888')).toBe('+5511999998888')
    expect(phoneInputSchema.safeParse('123').success).toBe(false)
  })
})
