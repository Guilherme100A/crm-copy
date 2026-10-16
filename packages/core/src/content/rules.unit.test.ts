import { describe, expect, it } from 'vitest'
import { ContentError, assertGlobalValue, globalVariableName, globalVariableType, normalizeShortcut, renderTemplateContent } from './rules'

describe('atalho', () => {
  it('normaliza como o editor da referência', () => {
    expect(normalizeShortcut('Boas Vindas!')).toBe('boas vindas')
    expect(normalizeShortcut('  Oi,   tudo_bem-2?  ')).toBe('oi tudo_bem-2')
    expect(normalizeShortcut('Ação')).toBe('ao')
    expect(normalizeShortcut('!!!')).toBe('')
  })
})

describe('variável global', () => {
  it('nome com prefixo g_ automático; fora do padrão é recusado', () => {
    expect(globalVariableName('cidade')).toBe('g_cidade')
    expect(globalVariableName('g_cidade')).toBe('g_cidade')
    for (const bad of ['', 'com espaço', 'acentuação', 'a-b']) expect(() => globalVariableName(bad)).toThrow(ContentError)
  })

  it('tipo text|number (aceita Texto/Número) e valor numérico validado', () => {
    expect(globalVariableType('Número')).toBe('number')
    expect(globalVariableType('Texto')).toBe('text')
    expect(globalVariableType(undefined)).toBeUndefined()
    expect(() => globalVariableType('data')).toThrow(ContentError)
    expect(() => assertGlobalValue('number', 'abc')).toThrow(ContentError)
    for (const ok of ['10', '-2.5', '', null]) expect(() => assertGlobalValue('number', ok)).not.toThrow()
    expect(() => assertGlobalValue('text', 'abc')).not.toThrow()
  })
})

describe('modelo interno → texto', () => {
  it('cabeçalho, corpo, menu numerado, links e rodapé em blocos; mídia do cabeçalho à parte', () => {
    const out = renderTemplateContent(
      {
        header: { type: 'text', text: 'Promo {first_name}' },
        body: 'Corpo',
        footer: 'Rodapé',
        buttons: [
          { type: 'reply', text: 'Quero' },
          { type: 'url', text: 'Site', url: 'https://ex.test' },
          { type: 'reply', text: 'Não' },
          { type: 'phone', text: 'Ligar', phone: '+5511999990000' },
        ],
      },
      (s) => s.replace('{first_name}', 'Ana'),
    )
    expect(out.text).toBe('Promo Ana\n\nCorpo\n\n1 - Quero\n2 - Não\n\nSite: https://ex.test\nLigar: +5511999990000\n\nRodapé')
    expect(out.media).toBeNull()
    expect(renderTemplateContent({ header: { type: 'image', media_id: 'm1' }, body: 'x', buttons: [] }).media).toEqual({ type: 'image', media_id: 'm1' })
  })
})
