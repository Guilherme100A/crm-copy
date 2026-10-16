import { describe, expect, it } from 'vitest'
import { normalizeCurrency } from '../sales/errors'
import { resolvePrice } from './service'

describe('AC-T34-02 resolvePrice', () => {
  const p = { price_min_cents: 1000, price_max_cents: 5000, price_fallback_cents: 2990 }
  it('dentro da faixa usa o valor; fora usa o fallback', () => {
    expect(resolvePrice(p, 1000)).toBe(1000)
    expect(resolvePrice(p, 5000)).toBe(5000)
    expect(resolvePrice(p, 3333)).toBe(3333)
    expect(resolvePrice(p, 999)).toBe(2990)
    expect(resolvePrice(p, 5001)).toBe(2990)
    expect(resolvePrice(p, null)).toBe(2990)
    expect(resolvePrice(p, undefined)).toBe(2990)
    expect(resolvePrice(p, Number.NaN)).toBe(2990)
  })
  it('aceita o formato camel do banco', () => {
    expect(resolvePrice({ priceMinCents: 0, priceMaxCents: 100, priceFallbackCents: 50 }, 101)).toBe(50)
  })
})

describe('moeda', () => {
  it('ISO 4217 em maiúsculas', () => {
    expect(normalizeCurrency('brl')).toBe('BRL')
    expect(normalizeCurrency(' usd ')).toBe('USD')
    expect(normalizeCurrency('XYZ')).toBeNull()
    expect(normalizeCurrency('REAL')).toBeNull()
  })
})
