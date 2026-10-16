// Chamadas HTTP aos provedores para testar a chave e listar modelos/vozes (T38). `fetch` injetável; as URLs base vêm
// do env lido a cada chamada (`<PROVEDOR>_API_URL`), para os testes apontarem a servidores fake (SPEC 3.12.1).
// Nenhuma mensagem de erro carrega a chave nem o corpo cru da resposta.
import type { AiKeyProvider } from '@crm/db'
import { AiKeysError } from './errors'

type Env = Record<string, string | undefined>
type FetchFn = typeof globalThis.fetch

export const PROVIDER_API_URL_ENV: Readonly<Record<AiKeyProvider, string>> = {
  anthropic: 'ANTHROPIC_API_URL',
  openai: 'OPENAI_API_URL',
  google: 'GOOGLE_API_URL',
  openrouter: 'OPENROUTER_API_URL',
  elevenlabs: 'ELEVENLABS_API_URL',
  groq: 'GROQ_API_URL',
}

export const PROVIDER_DEFAULT_API_URL: Readonly<Record<AiKeyProvider, string>> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  elevenlabs: 'https://api.elevenlabs.io',
  groq: 'https://api.groq.com/openai/v1',
}

export const apiBaseUrl = (provider: AiKeyProvider, env: Env) =>
  (env[PROVIDER_API_URL_ENV[provider]]?.trim() || PROVIDER_DEFAULT_API_URL[provider]).replace(/\/+$/, '')

function authHeaders(provider: AiKeyProvider, secret: string): Record<string, string> {
  switch (provider) {
    case 'anthropic':
      return { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }
    case 'google':
      return { 'x-goog-api-key': secret }
    case 'elevenlabs':
      return { 'xi-api-key': secret }
    default:
      return { authorization: `Bearer ${secret}` }
  }
}

/** Endpoint barato e autenticado de cada provedor (nenhum gasta tokens). */
const PROBE_PATH: Readonly<Record<AiKeyProvider, string>> = {
  anthropic: '/models?limit=1',
  openai: '/models',
  google: '/models?pageSize=1',
  openrouter: '/key',
  elevenlabs: '/v1/voices',
  groq: '/models',
}

export const HTTP_TIMEOUT_MS = 10_000

export interface HttpOptions {
  fetch?: FetchFn
  env?: Env
  signal?: AbortSignal
}

async function getJson(provider: AiKeyProvider, secret: string, path: string, opts: HttpOptions): Promise<unknown> {
  const env = opts.env ?? process.env
  const fetchFn = opts.fetch ?? globalThis.fetch
  const signal = opts.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchFn(`${apiBaseUrl(provider, env)}${path}`, { method: 'GET', headers: { accept: 'application/json', ...authHeaders(provider, secret) }, signal })
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new AiKeysError('upstream', timeout ? `${provider} não respondeu a tempo` : `falha de rede ao chamar ${provider}`, { provider })
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new AiKeysError('upstream', `${provider} respondeu ${res.status}`, { provider, status: res.status })
  }
  try {
    return await res.json()
  } catch {
    throw new AiKeysError('upstream', `${provider} devolveu uma resposta inválida`, { provider })
  }
}

/** Testa a chave. Lança se o provedor recusar (a mensagem nunca contém a chave). */
export type AiKeyProbe = (input: { provider: AiKeyProvider; secret: string; signal?: AbortSignal }) => Promise<void>

export function httpKeyProbe(opts: Omit<HttpOptions, 'signal'> = {}): AiKeyProbe {
  return async ({ provider, secret, signal }) => {
    await getJson(provider, secret, PROBE_PATH[provider], { ...opts, ...(signal ? { signal } : {}) })
  }
}

export interface ModelItem {
  id: string
  name: string
  context_length: number | null
}

const OPENROUTER_MODEL = /^[^/\s]+\/[^\s]+$/

/** Catálogo da OpenRouter (`GET <base>/models` → `{ data: [...] }`), só ids no formato `fornecedor/modelo` (AC-T38-06). */
export async function fetchOpenRouterModels(secret: string, opts: HttpOptions = {}): Promise<ModelItem[]> {
  const body = (await getJson('openrouter', secret, '/models', opts)) as { data?: unknown }
  const data = Array.isArray(body?.data) ? body.data : []
  const items: ModelItem[] = []
  for (const m of data as Record<string, unknown>[]) {
    const id = typeof m?.id === 'string' ? m.id : ''
    if (!OPENROUTER_MODEL.test(id)) continue
    items.push({
      id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name : id,
      context_length: typeof m.context_length === 'number' ? m.context_length : null,
    })
  }
  return items
}

export interface VoiceItem {
  id: string
  name: string
  category: string | null
  preview_url: string | null
}

/** Vozes da conta ElevenLabs (`GET <base>/v1/voices` → `{ voices: [...] }` ou array). */
export async function fetchElevenLabsVoices(secret: string, opts: HttpOptions = {}): Promise<VoiceItem[]> {
  const body = (await getJson('elevenlabs', secret, '/v1/voices', opts)) as { voices?: unknown } | unknown[]
  const list = Array.isArray(body) ? body : Array.isArray((body as { voices?: unknown })?.voices) ? ((body as { voices: unknown[] }).voices) : []
  const items: VoiceItem[] = []
  for (const v of list as Record<string, unknown>[]) {
    const id = typeof v?.voice_id === 'string' ? v.voice_id : typeof v?.id === 'string' ? v.id : ''
    if (!id) continue
    items.push({
      id,
      name: typeof v.name === 'string' ? v.name : id,
      category: typeof v.category === 'string' ? v.category : null,
      preview_url: typeof v.preview_url === 'string' ? v.preview_url : null,
    })
  }
  return items
}
