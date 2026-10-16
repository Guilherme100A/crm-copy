// Clonagem de voz na ElevenLabs (T80): Instant Voice Cloning e exclusão, conferidos na doc pública
// (elevenlabs.io/docs/api-reference/voices/ivc/create e /voices/delete):
//   POST {base}/v1/voices/add  multipart `name`, `files` (1+), `labels` (JSON, ex.: {"language":"pt"}) → { voice_id, requires_verification }
//   DELETE {base}/v1/voices/{voice_id} → { status: 'ok' }
// Autenticação pelo header `xi-api-key` (o mesmo do TTS da T12). A síntese da prévia usa o `ElevenLabsTts` da T12.
import { ElevenLabsTts, httpError, LlmUpstreamError, type TtsProvider } from '@crm/ai'

export interface VoiceSampleInput {
  filename: string
  mime: string
  data: Uint8Array
}

export interface VoiceCloneInput {
  name: string
  language: string
  samples: VoiceSampleInput[]
}

/** O que a T80 precisa do provedor de voz, já com a chave resolvida. */
export interface VoiceProvider {
  clone(input: VoiceCloneInput): Promise<{ voiceId: string }>
  remove(voiceId: string): Promise<void>
  tts: TtsProvider
}

export type VoiceProviderFactory = (apiKey: string) => VoiceProvider

export interface ElevenLabsVoiceOptions {
  fetch?: typeof globalThis.fetch
  /** Base sem `/v1` (default `https://api.elevenlabs.io`; ou `ELEVENLABS_API_URL`). */
  baseUrl?: string
}

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io'

export function elevenLabsVoiceProvider(opts: ElevenLabsVoiceOptions = {}): VoiceProviderFactory {
  const base = (opts.baseUrl ?? ELEVENLABS_API_BASE).replace(/\/+$/, '')
  const fetchFn = opts.fetch ?? ((input, init) => fetch(input, init))
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    let res: Response
    try {
      res = await fetchFn(url, init)
    } catch (err) {
      throw new LlmUpstreamError('elevenlabs indisponível', { provider: 'elevenlabs', retryable: true }, { cause: new Error(err instanceof Error ? err.name : 'fetch failed') })
    }
    if (!res.ok) throw httpError('elevenlabs', res.status)
    return res
  }
  return (apiKey) => ({
    async clone(input) {
      const form = new FormData()
      form.set('name', input.name)
      for (const s of input.samples) form.append('files', new Blob([new Uint8Array(s.data)], { type: s.mime }), s.filename)
      form.set('labels', JSON.stringify({ language: input.language }))
      const res = await call(`${base}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': apiKey, accept: 'application/json' }, body: form })
      const json = (await res.json().catch(() => ({}))) as { voice_id?: unknown }
      if (typeof json.voice_id !== 'string' || !json.voice_id) throw new LlmUpstreamError('elevenlabs: resposta sem voice_id', { provider: 'elevenlabs', retryable: false })
      return { voiceId: json.voice_id }
    },
    async remove(voiceId) {
      await call(`${base}/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE', headers: { 'xi-api-key': apiKey, accept: 'application/json' } })
    },
    tts: new ElevenLabsTts({ apiKey, fetch: fetchFn, baseUrl: base }),
  })
}
