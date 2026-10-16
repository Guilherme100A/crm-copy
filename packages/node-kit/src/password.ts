// Hash de senha com scrypt (node:crypto) e comparação em tempo constante (SPEC 3.4, AC-T05-03).
// Formato autodescritivo: `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>` (permite subir o custo depois).
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  )

export const PASSWORD_HASH_PREFIX = 'scrypt'
const DEFAULT_COST = { N: 16384, r: 8, p: 1 }
const SALT_BYTES = 16
const KEY_BYTES = 64
// 128·N·r = 16 MiB no custo padrão; folga para custos maiores.
const MAX_MEM = 64 * 1024 * 1024

export interface HashPasswordOptions {
  /** Custo do scrypt (default N=16384, r=8, p=1). */
  N?: number
  r?: number
  p?: number
}

export async function hashPassword(password: string, opts: HashPasswordOptions = {}): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) throw new TypeError('senha vazia')
  const { N, r, p } = { ...DEFAULT_COST, ...opts }
  const salt = randomBytes(SALT_BYTES)
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N, r, p, maxmem: MAX_MEM })
  return [PASSWORD_HASH_PREFIX, N, r, p, salt.toString('base64'), key.toString('base64')].join('$')
}

/** `true` se `password` corresponde ao `hash`; hash malformado → `false` (nunca lança por formato). */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (typeof hash !== 'string' || typeof password !== 'string') return false
  const parts = hash.split('$')
  if (parts.length !== 6 || parts[0] !== PASSWORD_HASH_PREFIX) return false
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number]
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false
  const salt = Buffer.from(parts[4]!, 'base64')
  const expected = Buffer.from(parts[5]!, 'base64')
  if (salt.length === 0 || expected.length === 0) return false
  let actual: Buffer
  try {
    actual = await scrypt(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: MAX_MEM })
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
