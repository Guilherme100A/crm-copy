import { describe, expect, it } from 'vitest'
import { filterLabels, labelIssue, normalizeColor, textOn } from './rules'

describe('AC-T58-04 etiquetas — cor e busca', () => {
  it('cor normalizada para #RRGGBB maiúsculo', () => {
    expect(normalizeColor('ff8800')).toBe('#FF8800')
    expect(normalizeColor(' #abcdef ')).toBe('#ABCDEF')
    expect(normalizeColor('#FFF')).toBe('#FFF')
  })

  it('valida nome 2–50 e cor', () => {
    expect(labelIssue('a', '#FFFFFF')).toBe('name')
    expect(labelIssue('x'.repeat(51), '#FFFFFF')).toBe('name')
    expect(labelIssue('Boa', '#FFF')).toBe('color')
    expect(labelIssue('Quente', '#ff8800')).toBeNull()
  })

  it('texto legível sobre a cor e busca sem acento', () => {
    expect(textOn('#FFFFFF')).toBe('#000000')
    expect(textOn('#1E3A8A')).toBe('#FFFFFF')
    const items = [
      { id: '1', name: 'Atenção', color: '#EF4444', contacts_count: 3, created_at: '' },
      { id: '2', name: 'Quente', color: '#F97316', contacts_count: 0, created_at: '' },
    ]
    expect(filterLabels(items, 'atencao').map((l) => l.id)).toEqual(['1'])
    expect(filterLabels(items, '  ')).toHaveLength(2)
  })
})
