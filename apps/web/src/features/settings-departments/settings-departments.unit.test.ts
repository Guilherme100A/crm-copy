import { describe, expect, it } from 'vitest'
import { DEFAULT_DEPARTMENT_COLOR, DEPARTMENT_PALETTE, departmentFormErrors, normalizeHex, paletteId } from './palette'

describe('departamentos: paleta e cor própria (AC-T53-03)', () => {
  it('paleta de 10 cores da referência, padrão azul', () => {
    expect(DEPARTMENT_PALETTE).toHaveLength(10)
    expect(new Set(DEPARTMENT_PALETTE.map((p) => p.hex)).size).toBe(10)
    expect(DEPARTMENT_PALETTE[0]!.hex).toBe(DEFAULT_DEPARTMENT_COLOR)
  })

  it('cor fora da paleta é personalizada; hex normalizado como o servidor aceita', () => {
    expect(paletteId('#3b82f6')).toBe('blue')
    expect(paletteId('#EF4444')).toBe('red')
    expect(paletteId('#123456')).toBeNull()
    expect(normalizeHex('abc')).toBe('#AABBCC')
    expect(normalizeHex('#a1b2c3')).toBe('#A1B2C3')
    expect(normalizeHex('#12345')).toBeNull()
    expect(normalizeHex('red')).toBeNull()
  })

  it('validação do formulário: nome obrigatório, até 60, cor hex', () => {
    expect(departmentFormErrors('Vendas', '#3B82F6')).toEqual([])
    expect(departmentFormErrors('  ', '#3B82F6')).toEqual(['nameRequired'])
    expect(departmentFormErrors('x'.repeat(61), '#3B82F6')).toEqual(['nameTooLong'])
    expect(departmentFormErrors('Vendas', '#zzz')).toEqual(['colorInvalid'])
  })
})
