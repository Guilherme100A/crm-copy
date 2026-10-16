import { describe, expect, it } from 'vitest'
import { ManipulatorError, cardValueCents, chatStatusOf, formatMoney, manipulate, parseCreatedAt, saleAmountCents } from './rules'

describe('status do chat', () => {
  it('enum interno e rótulos do editor; o resto é inválido', () => {
    expect(chatStatusOf('attending')).toBe('attending')
    expect(chatStatusOf('Aguardando')).toBe('waiting')
    expect(chatStatusOf('Resolvidos')).toBe('resolved')
    expect(chatStatusOf('closed')).toBeNull()
    expect(chatStatusOf(3)).toBeNull()
  })
})

describe('manipulador', () => {
  it('set, contas com vírgula e divisão por zero', () => {
    expect(manipulate('x', 'set_value', 'novo')).toBe('novo')
    expect(manipulate(undefined, 'set_value', '10,5', 'number')).toBe(10.5)
    expect(manipulate('10', 'add', '2,5')).toBe(12.5)
    expect(manipulate(undefined, 'subtract', 3)).toBe(-3)
    expect(manipulate('0.1', 'add', '0.2')).toBe(0.3)
    expect(manipulate('7', 'multiply', '3')).toBe(21)
    expect(manipulate('10', 'divide', '4')).toBe(2.5)
    expect(() => manipulate('10', 'divide', '0')).toThrow(ManipulatorError)
    expect(() => manipulate('10', 'divide', '0')).toThrow(/^division_by_zero/)
    expect(() => manipulate('10', 'add', 'abc')).toThrow(/^not_a_number/)
  })
})

describe('data de criação', () => {
  it('dd/MM/aaaa HH:mm:ss no fuso, só data e ISO; inexistente é inválida', () => {
    expect(parseCreatedAt('19/10/2026 10:30:15', 'America/Sao_Paulo')?.toISOString()).toBe('2026-10-19T13:30:15.000Z')
    expect(parseCreatedAt('01/02/2026', 'America/Sao_Paulo')?.toISOString()).toBe('2026-02-01T03:00:00.000Z')
    expect(parseCreatedAt('2026-10-19T10:00:00Z', 'America/Sao_Paulo')?.toISOString()).toBe('2026-10-19T10:00:00.000Z')
    expect(parseCreatedAt('31/02/2026', 'America/Sao_Paulo')).toBeNull()
    expect(parseCreatedAt('ontem', 'America/Sao_Paulo')).toBeNull()
  })
})

describe('valores', () => {
  const product = { priceMinCents: 1000, priceMaxCents: 50_000, priceFallbackCents: 9_700 }
  it('venda dentro e fora da faixa; card em reais; moeda pt-BR', () => {
    expect(saleAmountCents('97,00', product)).toEqual({ cents: 9_700, fallback: false })
    expect(saleAmountCents('1.234,56', product)).toEqual({ cents: 9_700, fallback: true })
    expect(saleAmountCents('499,99', product)).toEqual({ cents: 49_999, fallback: false })
    expect(saleAmountCents('', product)).toEqual({ cents: 9_700, fallback: true })
    expect(saleAmountCents('5', product)).toEqual({ cents: 9_700, fallback: true })
    expect(cardValueCents('1.500,50')).toBe(150_050)
    expect(cardValueCents(20)).toBe(2_000)
    expect(cardValueCents('x')).toBeUndefined()
    expect(formatMoney(123_456)).toBe('1.234,56')
  })
})
