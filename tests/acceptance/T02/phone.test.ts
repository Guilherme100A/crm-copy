import { describe, expect, it } from 'vitest'
import { e164Of, fn, outcome } from './contract'

describe('T02 — telefone E.164 (phone.ts)', () => {
  it("AC-T02-04 parsePhone('+55 (11) 99999-8888') → +5511999998888", () => {
    const r = outcome(() => fn('parsePhone')('+55 (11) 99999-8888'))
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(e164Of((r as any).value)).toBe('+5511999998888')
  })

  it('AC-T02-04 parsePhone aceita número BR nacional com DDD (10 e 11 dígitos)', () => {
    const parsePhone = fn('parsePhone')
    for (const [input, expected] of [
      ['(11) 99999-8888', '+5511999998888'],
      ['11999998888', '+5511999998888'],
      ['(11) 3333-4444', '+551133334444'],
      ['+55 11 3333-4444', '+551133334444'],
    ] as const) {
      const r = outcome(() => parsePhone(input))
      expect(r.ok, `${input}: ${JSON.stringify(r)}`).toBe(true)
      expect(e164Of((r as any).value), input).toBe(expected)
    }
  })

  it('AC-T02-04 número BR com 9 dígitos sem DDD → erro', () => {
    const parsePhone = fn('parsePhone')
    for (const input of ['99999-8888', '999998888', '+55 99999-8888', '+55999998888']) {
      const r = outcome(() => parsePhone(input))
      expect(r.ok, `${input} deveria ser rejeitado: ${JSON.stringify(r)}`).toBe(false)
    }
  })

  it('AC-T02-04 toE164 rejeita menos de 8 dígitos', () => {
    const toE164 = fn('toE164')
    for (const input of ['1234567', '+1234567', '123-4567', '12']) {
      const r = outcome(() => toE164(input))
      expect(r.ok, `${input} deveria ser rejeitado: ${JSON.stringify(r)}`).toBe(false)
    }
  })

  it('AC-T02-04 toE164 aceita número válido e devolve E.164', () => {
    const r = outcome(() => fn('toE164')('+55 (11) 99999-8888'))
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(e164Of((r as any).value)).toBe('+5511999998888')
  })
})
