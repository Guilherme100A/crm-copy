import { describe, expect, it } from 'vitest'
import { matchOption, menuText, normalizeAnswer } from './menu'

const options = [
  { id: 'v', title: 'Vendas' },
  { id: 's', title: 'Suporte Técnico', description: '24h' },
  { id: 'site', title: 'Site', type: 'URL', description: 'https://x.test' },
  { id: 'f', title: 'Financeiro', type: 'REPLY' },
]

describe('menu em texto', () => {
  it('numera só as opções de resposta, com descrição, links e rodapé', () => {
    expect(menuText('Escolha:', options, 'Responda com o número')).toBe(
      'Escolha:\n\n1 - Vendas\n2 - Suporte Técnico — 24h\n3 - Financeiro\n\nSite: https://x.test\n\nResponda com o número',
    )
    expect(menuText('Oi', [{ id: 'a', title: 'A' }])).toBe('Oi\n\n1 - A')
  })

  it('reconhece número, título exato e título sem caixa/acentos', () => {
    expect(matchOption('2', options)?.id).toBe('s')
    expect(matchOption('3.', options)?.id).toBe('f')
    expect(matchOption('9', options)).toBeNull()
    expect(matchOption('Vendas', options)?.id).toBe('v')
    expect(matchOption('  suporte tecnico ', options)?.id).toBe('s')
    expect(matchOption('VENDÁS!', options)?.id).toBe('v')
    expect(matchOption('Site', options)).toBeNull()
    expect(matchOption('quero falar', options)).toBeNull()
    expect(matchOption('', options)).toBeNull()
    expect(normalizeAnswer('  Vendás! ')).toBe('vendas')
  })
})
