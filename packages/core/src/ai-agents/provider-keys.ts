// Chave de provedor de IA configurada? (AC-T39-06). Porta injetável: hoje só a chave da plataforma (env);
// a T38 (BYOK) troca pela verificação empresa + plataforma.
import type { LlmProviderId } from '@crm/ai'

export interface AiProviderKeys {
  isConfigured(input: { companyId: string; provider: LlmProviderId }): boolean | Promise<boolean>
}

export const PLATFORM_KEY_ENV: Readonly<Record<LlmProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

/** Chave da plataforma no ambiente (lida a cada chamada). */
export function envProviderKeys(env: Record<string, string | undefined> = process.env): AiProviderKeys {
  return { isConfigured: ({ provider }) => Boolean(env[PLATFORM_KEY_ENV[provider]]?.trim()) }
}
