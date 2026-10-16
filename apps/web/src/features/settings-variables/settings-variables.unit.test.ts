import { describe, expect, it } from 'vitest'
import { nameIssue, nameSuffix, stripPrefix, valueIssue } from './rules'

describe('AC-T58-03 variáveis globais — prefixo fixo e número no cliente', () => {
  it('o usuário digita só o sufixo: g_ colado e caracteres inválidos saem', () => {
    expect(nameSuffix('g_valor')).toBe('valor')
    expect(nameSuffix(' meu-nome ção! ')).toBe('meunomeo')
    expect(stripPrefix('g_preco')).toBe('preco')
    expect(stripPrefix('preco')).toBe('preco')
  })

  it('nome vazio ou longo demais', () => {
    expect(nameIssue('')).toBe('name')
    expect(nameIssue('x'.repeat(63))).toBe('name_long')
    expect(nameIssue('x'.repeat(62))).toBeNull()
  })

  it('tipo número recusa texto; vazio e decimais passam; texto aceita tudo', () => {
    expect(valueIssue('number', 'abc')).toBe('number')
    expect(valueIssue('number', '10,5')).toBe('number')
    expect(valueIssue('number', '1e3')).toBe('number')
    expect(valueIssue('number', ' -2.5 ')).toBeNull()
    expect(valueIssue('number', '')).toBeNull()
    expect(valueIssue('text', 'abc')).toBeNull()
  })
})
