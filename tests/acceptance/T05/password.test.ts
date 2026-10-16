// AC-T05-03 — hashPassword/verifyPassword (scrypt).
import { describe, expect, it } from 'vitest'
import { freshKit } from './kit'

describe('T05 — hash de senha', () => {
  it('AC-T05-03 verifyPassword(await hashPassword(s), s) é true', async () => {
    const kit = await freshKit()
    const hash = await kit.hashPassword('s3nha!')
    expect(typeof hash).toBe('string')
    expect(await kit.verifyPassword(hash, 's3nha!')).toBe(true)
  })

  it('AC-T05-03 senha errada → false (inclui prefixo, caixa e vazia)', async () => {
    const kit = await freshKit()
    const hash = await kit.hashPassword('s3nha!')
    for (const wrong of ['s3nha', 's3nha!!', 'S3NHA!', '', ' s3nha!'])
      expect(await kit.verifyPassword(hash, wrong), `aceitou "${wrong}"`).toBe(false)
  })

  it('AC-T05-03 o hash não contém a senha (nem em base64/hex)', async () => {
    const kit = await freshKit()
    const pwd = 's3nha!-bem-longa-para-busca'
    const hash: string = await kit.hashPassword(pwd)
    expect(hash).not.toContain(pwd)
    expect(hash).not.toContain(Buffer.from(pwd).toString('base64').replace(/=+$/, ''))
    expect(hash.toLowerCase()).not.toContain(Buffer.from(pwd).toString('hex'))
  })

  it('AC-T05-03 hash de outra senha não valida esta (unicode incluído)', async () => {
    const kit = await freshKit()
    const h1 = await kit.hashPassword('çãõ-🔐-1')
    const h2 = await kit.hashPassword('çãõ-🔐-2')
    expect(await kit.verifyPassword(h1, 'çãõ-🔐-1')).toBe(true)
    expect(await kit.verifyPassword(h2, 'çãõ-🔐-1')).toBe(false)
  })
})
