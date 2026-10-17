// Chave de provedor de IA configurada? (AC-T39-06). Porta injetável: hoje só a chave da plataforma (env);
// a T38 (BYOK) troca pela verificação empresa + plataforma.
import type { LlmProviderId } from '@crm/ai'
import type { Database } from '@crm/db'
import { hasPlatformSecret } from '../admin-ops/secret-store'

export interface AiProviderKeys {
  isConfigured(input: { companyId: string; provider: LlmProviderId }): boolean | Promise<boolean>
}

export const PLATFORM_KEY_ENV: Readonly<Record<LlmProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

/**
 * Chave da plataforma no ambiente (lida a cada chamada). Com `db` (T96), o segredo de plataforma salvo pelo admin
 * (`crm.platform_secrets`) também conta e vem antes do env; sem `db`, só o env, como antes.
 */
export function envProviderKeys(env: Record<string, string | undefined> = process.env, opts: { db?: Database } = {}): AiProviderKeys {
  const fromEnv = (provider: LlmProviderId) => Boolean(env[PLATFORM_KEY_ENV[provider]]?.trim())
  const db = opts.db
  if (!db) return { isConfigured: ({ provider }) => fromEnv(provider) }
  return { isConfigured: async ({ provider }) => (await hasPlatformSecret(db, provider)) || fromEnv(provider) }
}
