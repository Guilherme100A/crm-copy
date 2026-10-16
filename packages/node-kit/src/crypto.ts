// Cifragem de segredos em repouso (SPEC T05, AC-T05-01; SPEC 1.4 #1 e #8): AES-256-GCM com AAD e `keyVersion`.
// Chave de 32 bytes em base64 vinda de `CREDENTIALS_KEY`. Padrão do ai-manager (packages/core/src/crypto),
// acrescido de chaveiro (chaves antigas para rotação) e serialização compacta em texto.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const CREDENTIALS_ALGORITHM = 'aes-256-gcm'
export const CREDENTIALS_KEY_BYTES = 32
export const IV_BYTES = 12
export const AUTH_TAG_BYTES = 16
export const DEFAULT_KEY_VERSION = 1

// Primeiro byte do texto claro (dentro do ciphertext) indica o tipo original, para decrypt devolver string ou Buffer.
const KIND_BUFFER = 0x00
const KIND_STRING = 0x01

export type Plaintext = string | Buffer
export type Aad = string | Buffer

/** Resultado de `encrypt`. Os campos casam com colunas bytea (`ciphertext`, `iv`, `auth_tag`) + `key_version`. */
export interface EncryptedPayload<T extends Plaintext = Plaintext> {
  ciphertext: Buffer
  iv: Buffer
  authTag: Buffer
  keyVersion: number
  /** Marca de tipo apenas em tempo de compilação. */
  readonly __plaintext?: T
}

export class CredentialsKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialsKeyError'
  }
}

export class DecryptionError extends Error {
  constructor(message = 'falha ao decifrar: dados adulterados, AAD ou chave incorreta') {
    super(message)
    this.name = 'DecryptionError'
  }
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Decodifica e valida a chave (32 bytes em base64). Lança `CredentialsKeyError` se ausente ou inválida. */
export function parseCredentialsKey(raw: string | undefined, name = 'CREDENTIALS_KEY'): Buffer {
  const value = raw?.trim()
  if (!value) throw new CredentialsKeyError(`${name} ausente (32 bytes em base64)`)
  if (!BASE64.test(value)) throw new CredentialsKeyError(`${name} inválida: não é base64`)
  const key = Buffer.from(value, 'base64')
  if (key.length !== CREDENTIALS_KEY_BYTES)
    throw new CredentialsKeyError(`${name} inválida: esperado ${CREDENTIALS_KEY_BYTES} bytes, veio ${key.length}`)
  return key
}

/** Lê `CREDENTIALS_KEY` do ambiente (ou de `env`) e valida. */
export function loadCredentialsKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseCredentialsKey(env.CREDENTIALS_KEY)
}

export interface CipherOptions {
  /** Chave atual (Buffer de 32 bytes ou base64). Default: `CREDENTIALS_KEY`. */
  key?: Buffer | string
  /** Versão da chave atual, gravada em cada payload. Default 1. */
  keyVersion?: number
  /** Chaves antigas, só para decifrar (rotação): `{ [versão]: chave }`. */
  previousKeys?: Record<number, Buffer | string>
}

export interface CredentialCipher {
  readonly keyVersion: number
  encrypt<T extends Plaintext>(plaintext: T, aad?: Aad): EncryptedPayload<T extends string ? string : Buffer>
  decrypt<T extends Plaintext>(payload: EncryptedPayload<T>, aad?: Aad): T
}

function toKey(key: Buffer | string, name: string): Buffer {
  if (typeof key === 'string') return parseCredentialsKey(key, name)
  if (!Buffer.isBuffer(key) || key.length !== CREDENTIALS_KEY_BYTES)
    throw new CredentialsKeyError(`${name} inválida: esperado ${CREDENTIALS_KEY_BYTES} bytes`)
  return Buffer.from(key) // cópia: mutações externas não afetam o cifrador
}

function toAad(aad: Aad | undefined): Buffer | undefined {
  if (aad === undefined) return undefined
  if (typeof aad === 'string') return Buffer.from(aad, 'utf8')
  if (Buffer.isBuffer(aad)) return aad
  throw new TypeError('AAD deve ser string ou Buffer')
}

function assertVersion(v: number): number {
  if (!Number.isInteger(v) || v < 1 || v > 0xffff) throw new CredentialsKeyError(`keyVersion inválida: ${v}`)
  return v
}

/**
 * Cria um cifrador. Valida a(s) chave(s) imediatamente: chave ausente ou ≠ 32 bytes lança
 * `CredentialsKeyError` na inicialização (AC-T05-01).
 */
export function createCipher(opts: CipherOptions = {}): CredentialCipher {
  const keyVersion = assertVersion(opts.keyVersion ?? DEFAULT_KEY_VERSION)
  const keys = new Map<number, Buffer>()
  for (const [v, k] of Object.entries(opts.previousKeys ?? {}))
    keys.set(assertVersion(Number(v)), toKey(k, `chave versão ${v}`))
  const current = opts.key === undefined ? loadCredentialsKey() : toKey(opts.key, 'CREDENTIALS_KEY')
  keys.set(keyVersion, current)

  return {
    keyVersion,
    encrypt(plaintext, aad) {
      const isString = typeof plaintext === 'string'
      if (!isString && !Buffer.isBuffer(plaintext)) throw new TypeError('encrypt aceita string ou Buffer')
      const body = isString ? Buffer.from(plaintext, 'utf8') : plaintext
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(CREDENTIALS_ALGORITHM, current, iv, { authTagLength: AUTH_TAG_BYTES })
      const a = toAad(aad)
      if (a) cipher.setAAD(a)
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.of(isString ? KIND_STRING : KIND_BUFFER)),
        cipher.update(body),
        cipher.final(),
      ])
      return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion }
    },
    decrypt<T extends Plaintext>(payload: EncryptedPayload<T>, aad?: Aad): T {
      const secret = keys.get(payload?.keyVersion ?? keyVersion)
      if (!secret) throw new DecryptionError(`versão de chave ${payload?.keyVersion} desconhecida`)
      if (
        !Buffer.isBuffer(payload.ciphertext) ||
        payload.iv?.length !== IV_BYTES ||
        payload.authTag?.length !== AUTH_TAG_BYTES
      )
        throw new DecryptionError()
      let plain: Buffer
      try {
        const decipher = createDecipheriv(CREDENTIALS_ALGORITHM, secret, payload.iv, { authTagLength: AUTH_TAG_BYTES })
        const a = toAad(aad)
        if (a) decipher.setAAD(a)
        decipher.setAuthTag(payload.authTag)
        plain = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()])
      } catch {
        throw new DecryptionError()
      }
      const kind = plain[0]
      const body = plain.subarray(1)
      if (kind === KIND_STRING) return body.toString('utf8') as T
      if (kind === KIND_BUFFER) return Buffer.from(body) as T
      throw new DecryptionError()
    },
  }
}

let defaultCipher: CredentialCipher | undefined

/** Valida `CREDENTIALS_KEY` e prepara o cifrador padrão. Chame no boot da API/worker para falhar cedo. */
export function initCredentialsCrypto(opts?: CipherOptions): CredentialCipher {
  defaultCipher = createCipher(opts)
  return defaultCipher
}

/** Cifrador padrão (inicializado sob demanda a partir de `CREDENTIALS_KEY`). */
export function getCredentialsCipher(): CredentialCipher {
  return (defaultCipher ??= createCipher())
}

/** Descarta o cifrador padrão (útil em testes que trocam `CREDENTIALS_KEY`). */
export function resetCredentialsCrypto(): void {
  defaultCipher = undefined
}

/** Cifra com o cifrador padrão. `aad` (ex.: `companyId/tipo/id`) é exigido igual no decrypt. */
export function encrypt<T extends Plaintext>(plaintext: T, aad?: Aad): EncryptedPayload<T extends string ? string : Buffer> {
  return getCredentialsCipher().encrypt(plaintext, aad)
}

/** Decifra com o cifrador padrão. Lança `DecryptionError` se ciphertext, IV, tag ou AAD forem adulterados. */
export function decrypt<T extends Plaintext>(payload: EncryptedPayload<T>, aad?: Aad): T {
  return getCredentialsCipher().decrypt(payload, aad)
}

/** Gera uma chave nova (base64) para `CREDENTIALS_KEY`. */
export function generateCredentialsKey(): string {
  return randomBytes(CREDENTIALS_KEY_BYTES).toString('base64')
}

const SERIAL_PREFIX = 'v'

/** Serializa o payload em texto (`v<versão>.<iv>.<tag>.<ciphertext>`, base64url) para colunas `text`. */
export function serializeEncrypted(payload: EncryptedPayload): string {
  return [
    `${SERIAL_PREFIX}${payload.keyVersion}`,
    payload.iv.toString('base64url'),
    payload.authTag.toString('base64url'),
    payload.ciphertext.toString('base64url'),
  ].join('.')
}

/** Inverso de `serializeEncrypted`. Lança `DecryptionError` se o formato for inválido. */
export function parseEncrypted<T extends Plaintext = Plaintext>(value: string): EncryptedPayload<T> {
  const parts = typeof value === 'string' ? value.split('.') : []
  const [ver, iv, tag, ct] = parts
  if (parts.length !== 4 || !ver?.startsWith(SERIAL_PREFIX) || iv === undefined || tag === undefined || ct === undefined)
    throw new DecryptionError('payload cifrado em formato inválido')
  const keyVersion = Number(ver.slice(SERIAL_PREFIX.length))
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new DecryptionError('payload cifrado em formato inválido')
  return {
    keyVersion,
    iv: Buffer.from(iv, 'base64url'),
    authTag: Buffer.from(tag, 'base64url'),
    ciphertext: Buffer.from(ct, 'base64url'),
  }
}
