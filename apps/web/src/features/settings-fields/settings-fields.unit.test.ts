import { describe, expect, it } from 'vitest'
import type { CustomFieldDto } from './api'
import { filterFields, keyIssue } from './rules'

const f = (key: string, system = false, description: string | null = null): CustomFieldDto => ({
  key,
  description,
  example_value: null,
  system,
})

describe('AC-T58-04 campos personalizados — abas e chave', () => {
  const items = [
    f('full_name', true, 'Nome Completo'),
    f('response.type', true, 'Tipo'),
    f('plano pago', false, 'Se pagou'),
    f('cidade'),
  ]

  it('separa Customizados e Sistema e busca sem acento em chave e descrição', () => {
    expect(filterFields(items, 'custom', '').map((x) => x.key)).toEqual(['plano pago', 'cidade'])
    expect(filterFields(items, 'system', '').map((x) => x.key)).toEqual(['full_name', 'response.type'])
    expect(filterFields(items, 'system', 'nome').map((x) => x.key)).toEqual(['full_name'])
    expect(filterFields(items, 'custom', 'PÁGOU').map((x) => x.key)).toEqual(['plano pago'])
  })

  it('valida a chave como o servidor', () => {
    const system = new Set(['full_name'])
    expect(keyIssue('a', system)).toBe('length')
    expect(keyIssue('a.b', system)).toBe('chars')
    expect(keyIssue('{x}', system)).toBe('chars')
    expect(keyIssue(' FULL_NAME ', system)).toBe('reserved')
    expect(keyIssue('Plano Pago', system)).toBeNull()
  })
})
