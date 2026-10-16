// Casamento de palavras-chave (AC-T61-01): seis tipos, any/all, sem caixa/acentos.
import { describe, expect, it } from 'vitest'
import { matchCondition, matchKeywordRule, normalizeKeywordText } from './match'

describe('matchCondition', () => {
  it.each([
    ['equals', 'Quero COMPRAR', 'quero comprar', true],
    ['equals', 'quero comprar agora', 'quero comprar', false],
    ['contains', 'oi, quero o PREÇO', 'preco', true],
    ['contains', 'oi', 'preco', false],
    ['different', 'sim', 'não', true],
    ['different', 'Não', 'nao', false],
    ['excludes', 'tudo certo', 'cancelar', true],
    ['excludes', 'quero cancelar', 'cancelar', false],
    ['starts_with', '  Olá, bom dia', 'ola', true],
    ['starts_with', 'bom dia, olá', 'ola', false],
    ['ends_with', 'quero o catálogo', 'CATALOGO', true],
    ['ends_with', 'catálogo por favor', 'catalogo', false],
  ] as const)('%s(%j, %j) = %s', (type, text, keyword, expected) => {
    expect(matchCondition(text, keyword, type)).toBe(expected)
  })

  it('palavra-chave vazia nunca casa', () => {
    expect(matchCondition('qualquer', '  ', 'contains')).toBe(false)
  })
})

describe('matchKeywordRule', () => {
  const conditions = [
    { keyword: 'preço', match_type: 'contains' as const },
    { keyword: 'cancelar', match_type: 'excludes' as const },
  ]
  it('any casa com uma condição; all exige todas', () => {
    expect(matchKeywordRule('qual o preço? quero cancelar', { rule_type: 'any', conditions })).toBe(true)
    expect(matchKeywordRule('qual o preço? quero cancelar', { rule_type: 'all', conditions })).toBe(false)
    expect(matchKeywordRule('qual o preço?', { rule_type: 'all', conditions })).toBe(true)
  })

  it('sem condições não casa; texto nulo (mídia) vale como vazio', () => {
    expect(matchKeywordRule('x', { rule_type: 'any', conditions: [] })).toBe(false)
    expect(matchKeywordRule(null, { rule_type: 'any', conditions: [{ keyword: 'oi', match_type: 'different' }] })).toBe(true)
  })

  it('normaliza caixa, acentos e espaços', () => {
    expect(normalizeKeywordText('  ÁGUA   de  Côco ')).toBe('agua de coco')
  })
})
