// Segredos de plataforma no banco (T96, AC-T96-04): cifrados com AAD por chave. Módulo baixo nível, sem dependência
// de `ai-keys` (que o importa para a precedência banco → env em `resolveCredentials`/`isConfigured`).
import { eq } from 'drizzle-orm'
import { platformSecrets, type Database } from '@crm/db'
import { getCredentialsCipher, parseEncrypted, serializeEncrypted, type CredentialCipher } from '@crm/node-kit'

export type SecretCipher = Pick<CredentialCipher, 'encrypt' | 'decrypt'>

export const platformSecretAad = (key: string) => `platform-secret/${key}`

export function sealPlatformSecret(key: string, value: string, cipher: SecretCipher = getCredentialsCipher()): string {
  return serializeEncrypted(cipher.encrypt(value, platformSecretAad(key)))
}

export function openPlatformSecret(
  key: string,
  valueEnc: string,
  cipher: SecretCipher = getCredentialsCipher(),
): string {
  return cipher.decrypt<string>(parseEncrypted<string>(valueEnc), platformSecretAad(key))
}

/** Valor decifrado do segredo de plataforma salvo no banco; `undefined` sem segredo salvo. */
export async function readPlatformSecret(
  db: Database,
  key: string,
  cipher?: SecretCipher,
): Promise<string | undefined> {
  const [row] = await db
    .select({ valueEnc: platformSecrets.valueEnc })
    .from(platformSecrets)
    .where(eq(platformSecrets.key, key))
    .limit(1)
  if (!row) return undefined
  return openPlatformSecret(key, row.valueEnc, cipher).trim() || undefined
}

/** Há segredo salvo no banco para a chave (sem decifrar). */
export async function hasPlatformSecret(db: Database, key: string): Promise<boolean> {
  const [row] = await db
    .select({ id: platformSecrets.id })
    .from(platformSecrets)
    .where(eq(platformSecrets.key, key))
    .limit(1)
  return Boolean(row)
}
