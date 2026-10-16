import { describe, expect, it } from 'vitest'
import { errorTable, fn, SPEC_ERROR_CODES } from './contract'

describe('T02 — códigos de erro (SPEC 3.5)', () => {
  it('AC-T02-01 ERROR_CODES contém exatamente os códigos da seção 3.5', () => {
    const table = errorTable()
    expect(Object.keys(table).sort()).toEqual(Object.keys(SPEC_ERROR_CODES).sort())
  })

  it('AC-T02-01 cada código de ERROR_CODES traz o HTTP da seção 3.5', () => {
    const table = errorTable()
    for (const [code, http] of Object.entries(SPEC_ERROR_CODES)) {
      // Se a tabela for só a lista de códigos, o HTTP vem de httpStatusOf (teste abaixo).
      if (table[code] !== undefined) expect(table[code], code).toBe(http)
    }
  })

  it('AC-T02-01 httpStatusOf(code) devolve o HTTP de cada código da seção 3.5', () => {
    const httpStatusOf = fn('httpStatusOf')
    for (const [code, http] of Object.entries(SPEC_ERROR_CODES)) {
      expect(httpStatusOf(code), code).toBe(http)
    }
  })
})
