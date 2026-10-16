import { describe, expect, it } from 'vitest'
import { AuthError, isUniqueViolation } from './errors'
import { detectImageMime, isAvatarMime } from './image'
import { normalizeLocale, normalizeReferralCode, normalizeWhatsapp } from './normalize'

describe('normalizeLocale', () => {
  it('pt-BR | en | es; pt_BR sinônimo; inválido → pt-BR', () => {
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('es')).toBe('es')
    expect(normalizeLocale('pt-BR')).toBe('pt-BR')
    expect(normalizeLocale('pt_BR')).toBe('pt-BR')
    expect(normalizeLocale('xx')).toBe('pt-BR')
    expect(normalizeLocale(42)).toBe('pt-BR')
  })
})

describe('normalizeReferralCode', () => {
  it('casa ^[A-Za-z0-9_-]{1,64}$ ou null', () => {
    expect(normalizeReferralCode('Af_1-x')).toBe('Af_1-x')
    expect(normalizeReferralCode('a'.repeat(64))).toBe('a'.repeat(64))
    expect(normalizeReferralCode('a'.repeat(65))).toBeNull()
    expect(normalizeReferralCode('com espaço')).toBeNull()
    expect(normalizeReferralCode('')).toBeNull()
    expect(normalizeReferralCode(undefined)).toBeNull()
  })
})

describe('normalizeWhatsapp', () => {
  it('só dígitos; vazio → null', () => {
    expect(normalizeWhatsapp('+55 (11) 9999-0000')).toBe('551199990000')
    expect(normalizeWhatsapp(' ')).toBeNull()
    expect(normalizeWhatsapp(null)).toBeNull()
  })
})

describe('detectImageMime', () => {
  it('pelos magic bytes', () => {
    expect(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(detectImageMime(Uint8Array.from([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBP')]))).toBe('image/webp')
    expect(detectImageMime(Uint8Array.from(Buffer.from('GIF89a')))).toBe('image/gif')
    expect(detectImageMime(Uint8Array.from([1, 2, 3]))).toBeNull()
    expect(isAvatarMime('image/gif')).toBe(false)
    expect(isAvatarMime('image/webp')).toBe(true)
  })
})

describe('isUniqueViolation', () => {
  it('reconhece 23505 direto ou embrulhado', () => {
    expect(isUniqueViolation({ code: '23505', constraint: 'x' }, 'x')).toBe(true)
    expect(isUniqueViolation(new Error('wrap', { cause: { code: '23505', constraint: 'x' } }), 'x')).toBe(true)
    expect(isUniqueViolation({ code: '23505', constraint: 'y' }, 'x')).toBe(false)
    expect(isUniqueViolation(new AuthError('email_taken'))).toBe(false)
  })
})
