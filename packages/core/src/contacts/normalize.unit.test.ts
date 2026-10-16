import { describe, expect, it } from 'vitest'
import { normalizeFieldKey } from '../custom-fields/service'
import { ContactsError } from './errors'
import { normalizeContactLid, normalizeContactPhone, normalizeContactState, normalizeContactZip } from './normalize'

const fieldOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    return err instanceof ContactsError ? (err.details?.fields as { path: string }[])[0]?.path : 'other'
  }
  return undefined
}

describe('normalização de contato', () => {
  it('telefone BR 10–11 dígitos, internacional e JID', () => {
    expect(normalizeContactPhone('(11) 99999-8888')).toBe('+5511999998888')
    expect(normalizeContactPhone('1133334444')).toBe('+551133334444')
    expect(normalizeContactPhone('+1 415 555 2671')).toBe('+14155552671')
    expect(normalizeContactPhone('5511999998888:3@s.whatsapp.net')).toBe('+5511999998888')
    expect(fieldOf(() => normalizeContactPhone('99999-8888'))).toBe('phone')
    expect(fieldOf(() => normalizeContactPhone('123', 'pn'))).toBe('pn')
  })

  it('LID, UF e CEP', () => {
    expect(normalizeContactLid('123456789:4@lid')).toBe('123456789@lid')
    expect(fieldOf(() => normalizeContactLid('5511999998888@s.whatsapp.net'))).toBe('wa_lid')
    expect(normalizeContactState(' sp ')).toBe('SP')
    expect(fieldOf(() => normalizeContactState('XX'))).toBe('state')
    expect(normalizeContactZip('01310-100')).toBe('01310100')
    expect(fieldOf(() => normalizeContactZip('123'))).toBe('zip')
  })

  it('chave de campo personalizado', () => {
    expect(normalizeFieldKey('  Plano ')).toBe('plano')
    expect(fieldOf(() => normalizeFieldKey('a'))).toBe('key')
    expect(fieldOf(() => normalizeFieldKey('full_name', 'custom_fields.full_name'))).toBe('custom_fields.full_name')
    expect(fieldOf(() => normalizeFieldKey('a.b'))).toBe('key')
    expect(fieldOf(() => normalizeFieldKey('{x}'))).toBe('key')
  })
})
