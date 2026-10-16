import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('hashPassword/verifyPassword scrypt (AC-T05-03)', () => {
  it('senha certa true, errada false, hash sem a senha', async () => {
    const hash = await hashPassword('s3nha!')
    expect(await verifyPassword(hash, 's3nha!')).toBe(true)
    expect(await verifyPassword(hash, 's3nha?')).toBe(false)
    expect(hash).not.toContain('s3nha!')
    expect(hash.startsWith('scrypt$')).toBe(true)
  })

  it('salt aleatório: hashes diferentes para a mesma senha', async () => {
    expect(await hashPassword('abc')).not.toBe(await hashPassword('abc'))
  })

  it('hash malformado → false', async () => {
    expect(await verifyPassword('', 'x')).toBe(false)
    expect(await verifyPassword('scrypt$a$b$c$d$e', 'x')).toBe(false)
    expect(await verifyPassword('bcrypt$1$1$1$AA==$AA==', 'x')).toBe(false)
  })

  it('senha vazia é rejeitada no hash', async () => {
    await expect(hashPassword('')).rejects.toThrow()
  })
})
