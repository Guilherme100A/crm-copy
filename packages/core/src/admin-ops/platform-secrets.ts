// Segredos de plataforma pelo admin (T96, AC-T96-04; 20-admin-interno.md §3.9): chaves de IA/ElevenLabs/Groq são só
// de escrita. A leitura devolve `configured`, a origem (`db` | `env`) e a máscara `…abcd`; nunca o valor.
// O segredo salvo no banco tem precedência sobre a variável de ambiente (`AiKeysService.resolveCredentials`).
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { AI_KEY_PROVIDERS, platformSecrets, type AiKeyProvider, type Database } from '@crm/db'
import { PLATFORM_AI_KEY_ENV } from '../ai-keys/service'
import { invalid, notFound } from './errors'
import { sealPlatformSecret, type SecretCipher } from './secret-store'

export const PLATFORM_SECRET_KEYS = AI_KEY_PROVIDERS
export type PlatformSecretKey = AiKeyProvider

export interface PlatformSecretDto {
  key: PlatformSecretKey
  /** Variável de ambiente usada quando não há segredo salvo. */
  env_var: string
  configured: boolean
  /** De onde vem o segredo que vale hoje: banco (admin), ambiente ou nenhum. */
  source: 'db' | 'env' | null
  /** `…abcd` (4 últimos caracteres do segredo que vale), ou null. */
  hint: string | null
  updated_at: string | null
  updated_by_user_id: string | null
}

export const platformSecretWriteSchema = z.object({
  value: z.string('Informe o segredo').trim().min(1, 'Informe o segredo').max(1000, 'Segredo longo demais'),
})

export interface PlatformSecretsServiceOptions {
  db: Database
  /** Default: o cifrador de `CREDENTIALS_KEY` (`@crm/node-kit`). */
  cipher?: SecretCipher
  /** Lido a cada chamada. Default `process.env`. */
  env?: Record<string, string | undefined>
  now?: () => Date
}

export function isPlatformSecretKey(key: string): key is PlatformSecretKey {
  return (PLATFORM_SECRET_KEYS as readonly string[]).includes(key)
}

const mask = (last4: string) => `…${last4}`

export class PlatformSecretsService {
  constructor(private readonly opts: PlatformSecretsServiceOptions) {}

  async list(): Promise<PlatformSecretDto[]> {
    const rows = await this.opts.db.select().from(platformSecrets).orderBy(asc(platformSecrets.key))
    const byKey = new Map(rows.map((r) => [r.key, r]))
    return PLATFORM_SECRET_KEYS.map((k) => this.toDto(k, byKey.get(k)))
  }

  async get(key: string): Promise<PlatformSecretDto> {
    const k = this.key(key)
    const [row] = await this.opts.db.select().from(platformSecrets).where(eq(platformSecrets.key, k)).limit(1)
    return this.toDto(k, row)
  }

  /** Grava (ou troca) o segredo cifrado. Valor vazio → `validation`. */
  async set(key: string, input: unknown, actorUserId: string | null = null): Promise<PlatformSecretDto> {
    const k = this.key(key)
    const r = platformSecretWriteSchema.safeParse(input ?? {})
    if (!r.success) throw invalid('value', r.error.issues[0]?.message ?? 'Informe o segredo')
    const value = r.data.value
    const now = this.opts.now?.() ?? new Date()
    const values = {
      valueEnc: sealPlatformSecret(k, value, this.opts.cipher),
      hint: value.slice(-4),
      updatedByUserId: actorUserId,
      updatedAt: now,
    }
    await this.opts.db
      .insert(platformSecrets)
      .values({ key: k, ...values, createdAt: now })
      .onConflictDoUpdate({ target: platformSecrets.key, set: values })
    return this.get(k)
  }

  /** Remove o segredo salvo (volta a valer a variável de ambiente, se houver). Devolve se havia algo salvo. */
  async remove(key: string): Promise<{ removed: boolean; secret: PlatformSecretDto }> {
    const k = this.key(key)
    const deleted = await this.opts.db
      .delete(platformSecrets)
      .where(eq(platformSecrets.key, k))
      .returning({ id: platformSecrets.id })
    return { removed: deleted.length > 0, secret: await this.get(k) }
  }

  private key(key: string): PlatformSecretKey {
    if (!isPlatformSecretKey(key)) throw notFound('Segredo de plataforma')
    return key
  }

  private toDto(key: PlatformSecretKey, row: typeof platformSecrets.$inferSelect | undefined): PlatformSecretDto {
    const envVar = PLATFORM_AI_KEY_ENV[key]
    const envValue = (this.opts.env ?? process.env)[envVar]?.trim()
    const base = {
      key,
      env_var: envVar,
      updated_at: row ? row.updatedAt.toISOString() : null,
      updated_by_user_id: row?.updatedByUserId ?? null,
    }
    if (row) return { ...base, configured: true, source: 'db', hint: mask(row.hint) }
    if (envValue) return { ...base, configured: true, source: 'env', hint: mask(envValue.slice(-4)) }
    return { ...base, configured: false, source: null, hint: null }
  }
}
