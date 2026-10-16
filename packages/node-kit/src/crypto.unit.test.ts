import { afterEach, describe, expect, it } from 'vitest'
import {
  createCipher,
  CredentialsKeyError,
  decrypt,
  DecryptionError,
  encrypt,
  generateCredentialsKey,
  initCredentialsCrypto,
  parseEncrypted,
  resetCredentialsCrypto,
  serializeEncrypted,
} from './crypto'

const KEY = generateCredentialsKey()

describe('crypto AES-256-GCM (AC-T05-01)', () => {
  afterEach(() => {
    resetCredentialsCrypto()
    delete process.env.CREDENTIALS_KEY
  })

  it('round-trip de string e Buffer com AAD', () => {
    const c = createCipher({ key: KEY })
    expect(c.decrypt(c.encrypt('segredo ç', 'co/1'), 'co/1')).toBe('segredo ç')
    const buf = Buffer.from([0, 1, 2, 255])
    const out = c.decrypt(c.encrypt(buf, Buffer.from('aad')), Buffer.from('aad'))
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out.equals(buf)).toBe(true)
  })

  it('encrypt/decrypt padrão usam CREDENTIALS_KEY', () => {
    process.env.CREDENTIALS_KEY = KEY
    expect(decrypt(encrypt('x', 'a'), 'a')).toBe('x')
  })

  it('IV aleatório: mesmo texto gera ciphertexts diferentes', () => {
    const c = createCipher({ key: KEY })
    expect(c.encrypt('a').ciphertext.equals(c.encrypt('a').ciphertext)).toBe(false)
  })

  it('AAD diferente ou ausente → erro', () => {
    const c = createCipher({ key: KEY })
    const p = c.encrypt('x', 'a')
    expect(() => c.decrypt(p, 'b')).toThrow(DecryptionError)
    expect(() => c.decrypt(p)).toThrow(DecryptionError)
  })

  it('IV, tag ou ciphertext adulterados → erro', () => {
    const c = createCipher({ key: KEY })
    const p = c.encrypt('x', 'a')
    const flip = (b: Buffer) => {
      const o = Buffer.from(b)
      o[0] = o[0]! ^ 1
      return o
    }
    expect(() => c.decrypt({ ...p, iv: flip(p.iv) }, 'a')).toThrow(DecryptionError)
    expect(() => c.decrypt({ ...p, authTag: flip(p.authTag) }, 'a')).toThrow(DecryptionError)
    expect(() => c.decrypt({ ...p, ciphertext: flip(p.ciphertext) }, 'a')).toThrow(DecryptionError)
    expect(() => c.decrypt({ ...p, authTag: p.authTag.subarray(0, 8) }, 'a')).toThrow(DecryptionError)
  })

  it('chave errada → erro', () => {
    const p = createCipher({ key: KEY }).encrypt('x')
    expect(() => createCipher({ key: generateCredentialsKey() }).decrypt(p)).toThrow(DecryptionError)
  })

  it('CREDENTIALS_KEY ausente ou ≠ 32 bytes → erro na inicialização', () => {
    delete process.env.CREDENTIALS_KEY
    expect(() => initCredentialsCrypto()).toThrow(CredentialsKeyError)
    expect(() => createCipher({ key: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/)
    expect(() => createCipher({ key: Buffer.alloc(31) })).toThrow(CredentialsKeyError)
    expect(() => createCipher({ key: 'não base64!' })).toThrow(CredentialsKeyError)
    process.env.CREDENTIALS_KEY = Buffer.alloc(33).toString('base64')
    expect(() => initCredentialsCrypto()).toThrow(CredentialsKeyError)
  })

  it('keyVersion gravada no payload; chaves antigas decifram após rotação', () => {
    const old = createCipher({ key: KEY, keyVersion: 1 })
    const p1 = old.encrypt('antigo')
    const KEY2 = generateCredentialsKey()
    const rotated = createCipher({ key: KEY2, keyVersion: 2, previousKeys: { 1: KEY } })
    const p2 = rotated.encrypt('novo')
    expect(p1.keyVersion).toBe(1)
    expect(p2.keyVersion).toBe(2)
    expect(rotated.decrypt(p1)).toBe('antigo')
    expect(rotated.decrypt(p2)).toBe('novo')
    expect(() => old.decrypt(p2)).toThrow(DecryptionError)
  })

  it('serialização em texto ida e volta', () => {
    const c = createCipher({ key: KEY, keyVersion: 3 })
    const s = serializeEncrypted(c.encrypt('olá', 'x'))
    expect(s.startsWith('v3.')).toBe(true)
    expect(c.decrypt(parseEncrypted<string>(s), 'x')).toBe('olá')
    expect(() => parseEncrypted('lixo')).toThrow(DecryptionError)
  })
})
