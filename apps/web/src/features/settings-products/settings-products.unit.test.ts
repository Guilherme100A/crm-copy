import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS } from '../settings/tabs'
import {
  centsToInput,
  currencyLabel,
  draftFromProduct,
  hasIssues,
  normalizeCurrency,
  parseMoney,
  resolvePrice,
  toProductInput,
  validateProduct,
  type ProductDraft,
} from './rules'

const draft = (over: Partial<ProductDraft> = {}): ProductDraft => ({
  name: 'Curso',
  currency: 'BRL',
  price_min: '100,00',
  price_max: '200,00',
  price_fallback: '150,00',
  ...over,
})

describe('produtos (T90, AC-T90-01)', () => {
  it('valor digitado com vírgula decimal vira centavos', () => {
    expect(parseMoney('12,50')).toBe(1250)
    expect(parseMoney('12')).toBe(1200)
    expect(parseMoney('12,5')).toBe(1250)
    expect(parseMoney('1.299,90')).toBe(129990)
    expect(parseMoney('1299.9')).toBe(129990)
    expect(parseMoney('1.299')).toBe(129900)
    expect(parseMoney('R$ 0,99')).toBe(99)
    expect(parseMoney('0')).toBe(0)
    for (const bad of ['', '  ', '-1', '12,345', 'abc', '1,2,3', '12,']) expect(parseMoney(bad)).toBeNull()
  })

  it('centavos voltam ao formato do campo', () => {
    expect(centsToInput(1250)).toBe('12,50')
    expect(centsToInput(5)).toBe('0,05')
    expect(centsToInput(null)).toBe('')
    expect(parseMoney(centsToInput(129990))).toBe(129990)
  })

  it('moeda: ISO 4217 do Intl, como o servidor (padrão BRL)', () => {
    expect(normalizeCurrency(' usd ')).toBe('USD')
    expect(normalizeCurrency('BRL')).toBe('BRL')
    expect(normalizeCurrency('XYZ')).toBeNull()
    expect(normalizeCurrency('REAL')).toBeNull()
    expect(currencyLabel('BRL', 'pt-BR')).toMatch(/^BRL · Real/)
    expect(toProductInput(draft({ currency: '' })).currency).toBe('BRL')
  })

  it('faixa e fallback com as mesmas regras do servidor', () => {
    expect(validateProduct(draft())).toEqual({})
    expect(validateProduct(draft({ name: ' a ' }))).toEqual({ name: 'name' })
    expect(validateProduct(draft({ name: 'x'.repeat(256) }))).toEqual({ name: 'name' })
    expect(validateProduct(draft({ currency: 'XYZ' }))).toEqual({ currency: 'currency' })
    // máx < mín → erro no máximo; máx = mín é aceito.
    expect(validateProduct(draft({ price_max: '99,99' }))).toEqual({ price_max_cents: 'range' })
    expect(validateProduct(draft({ price_max: '100,00' }))).toEqual({})
    // fallback precisa ser > 0 (mín/máx podem ser 0).
    expect(validateProduct(draft({ price_fallback: '0' }))).toEqual({ price_fallback_cents: 'fallback' })
    expect(validateProduct(draft({ price_min: '0', price_max: '0' }))).toEqual({})
    expect(validateProduct(draft({ price_min: '', price_max: 'x', price_fallback: '-1' }))).toEqual({
      price_min_cents: 'money',
      price_max_cents: 'money',
      price_fallback_cents: 'money',
    })
    expect(hasIssues({})).toBe(false)
  })

  it('corpo enviado em centavos, com nome aparado e moeda normalizada', () => {
    expect(toProductInput(draft({ name: '  Curso X ', currency: 'usd', price_min: '12,50' }))).toEqual({
      name: 'Curso X',
      currency: 'USD',
      price_min_cents: 1250,
      price_max_cents: 20000,
      price_fallback_cents: 15000,
    })
    expect(
      draftFromProduct({
        name: 'A',
        currency: 'EUR',
        price_min_cents: 100,
        price_max_cents: 250,
        price_fallback_cents: 199,
      }),
    ).toEqual({
      name: 'A',
      currency: 'EUR',
      price_min: '1,00',
      price_max: '2,50',
      price_fallback: '1,99',
    })
    expect(draftFromProduct(null).currency).toBe('BRL')
  })

  it('regra de preço: dentro da faixa usa o valor, fora ou ausente usa o fallback', () => {
    const p = { price_min_cents: 100, price_max_cents: 200, price_fallback_cents: 150 }
    expect(resolvePrice(p, 100)).toBe(100)
    expect(resolvePrice(p, 200)).toBe(200)
    expect(resolvePrice(p, 99)).toBe(150)
    expect(resolvePrice(p, 201)).toBe(150)
    expect(resolvePrice(p, null)).toBe(150)
  })

  it('aba products no grupo Integrações com settings.products.view', () => {
    expect(SETTINGS_TABS.find((x) => x.id === 'products')).toMatchObject({
      group: 'integrations',
      labelKey: 'settings-products:tab',
      permissions: ['settings.products.view'],
    })
  })
})
