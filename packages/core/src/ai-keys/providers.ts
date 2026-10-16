// Provedores de IA por empresa sobre as chaves BYOK (T38): quem monta o worker (configureAiAgent da T68) e os nós de
// IA dos fluxos (T42) recebem estes resolvedores em vez de uma chave fixa. Ver docs/ai-keys.md.
import {
  createAiSdkProvider,
  ElevenLabsTts,
  GroqStt,
  type AiSdkProviderOptions,
  type LlmProvider,
  type SttProvider,
  type TtsProvider,
} from '@crm/ai'
import type { AiKeyProvider } from '@crm/db'
import { apiBaseUrl } from './http'
import type { AiKeysService } from './service'

type Env = Record<string, string | undefined>

export interface CompanyLlmProviderOptions extends Omit<AiSdkProviderOptions, 'resolveCredentials'> {
  keys: Pick<AiKeysService, 'resolveCredentials'>
}

/**
 * `LlmProvider` único para todas as empresas: a cada `generate`, a chave vem de `keys.resolveCredentials(tenantId, provider)`
 * (chave efetiva da empresa, senão a da plataforma). Sem nenhuma → `ProviderNotConfiguredError`.
 */
export function createCompanyLlmProvider(opts: CompanyLlmProviderOptions): LlmProvider {
  const { keys, ...rest } = opts
  return createAiSdkProvider({
    ...rest,
    resolveCredentials: async ({ companyId, provider }) => ({ apiKey: (await keys.resolveCredentials(companyId, provider)).apiKey }),
  })
}

export interface CompanyVoiceOptions {
  keys: Pick<AiKeysService, 'resolveCredentials'>
  fetch?: typeof globalThis.fetch
  /** URLs base (`ELEVENLABS_API_URL`, `GROQ_API_URL`), lidas a cada chamada. Default `process.env`. */
  env?: Env
}

const voiceBase = (provider: AiKeyProvider, env: Env | undefined) =>
  env?.[provider === 'elevenlabs' ? 'ELEVENLABS_API_URL' : 'GROQ_API_URL']?.trim() ? apiBaseUrl(provider, env) : undefined

/** TTS (ElevenLabs) com a chave da empresa ou da plataforma. Sem chave → `ProviderNotConfiguredError`. */
export async function resolveTts(companyId: string, opts: CompanyVoiceOptions): Promise<TtsProvider> {
  const { apiKey } = await opts.keys.resolveCredentials(companyId, 'elevenlabs')
  const baseUrl = voiceBase('elevenlabs', opts.env ?? process.env)
  return new ElevenLabsTts({ apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(baseUrl ? { baseUrl } : {}) })
}

/** STT (Groq Whisper) com a chave da empresa ou da plataforma. Sem chave → `ProviderNotConfiguredError`. */
export async function resolveStt(companyId: string, opts: CompanyVoiceOptions): Promise<SttProvider> {
  const { apiKey } = await opts.keys.resolveCredentials(companyId, 'groq')
  const baseUrl = voiceBase('groq', opts.env ?? process.env)
  return new GroqStt({ apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(baseUrl ? { baseUrl } : {}) })
}
