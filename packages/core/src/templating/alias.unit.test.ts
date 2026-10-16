import { describe, expect, it } from 'vitest'
import { render } from './render'

describe('alias customer.name (T123)', () => {
  const contact = { full_name: 'Maria Souza', phone_number: '5511999990000' }

  it('{{customer.name}}, {{contact.name}} e {name} = nome completo', () => {
    expect(render('Oi {{customer.name}}', { contact })).toBe('Oi Maria Souza')
    expect(render('{{contact.name}}', { contact })).toBe('Maria Souza')
    expect(render('Oi {name}', { contact })).toBe('Oi Maria Souza')
  })

  it('não muda o que já resolvia: variável do run, name próprio e campo personalizado vencem', () => {
    expect(render('{name}', { contact, vars: { name: 'do fluxo' } })).toBe('do fluxo')
    expect(render('{{customer.name}}', { contact: { ...contact, name: 'Própria' } })).toBe('Própria')
    expect(render('{{customer.name}}', { contact: { ...contact, custom_fields: { name: 'Apelido' } } })).toBe('Apelido')
    expect(render('{{customer.name}}', { contact: { phone_number: '1' } })).toBe('')
    expect(render('{{customer.name}}', {})).toBe('')
    expect(render('{first_name} {full_name}', { contact })).toBe('Maria Maria Souza')
  })
})
