// TtsProvider sobre a API REST da ElevenLabs (STACK E §2): POST /v1/text-to-speech/{voice_id}.
// `fetch` injetável (testes nunca chamam a API real). Erros HTTP viram LlmUpstreamError sem a chave.
import { LlmUpstreamError } from '../port/errors'
import { TTS_MIME, type TtsFormat, type TtsProvider, type TtsRequest, type TtsResult } from '../port/voice'

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io'
/** ~75 ms e metade do preço; `eleven_turbo_*` estão deprecados (STACK E §2.3). */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5'

/** Formato da porta → `output_format` da ElevenLabs. O PTT final ainda passa pelo ffmpeg (`toPttOgg`). */
export const ELEVENLABS_OUTPUT_FORMAT: Readonly<Record<TtsFormat, string>> = {
  ogg_opus: 'opus_48000_64',
  mp3: 'mp3_44100_128',
  wav: 'wav_44100',
  pcm: 'pcm_44100',
}

export interface ElevenLabsTtsOptions {
  apiKey: string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  /** Modelo padrão (o pedido pode trocar). */
  model?: string
  /** ISO 639-1; ignorado pelos modelos `multilingual_v2` (não é enviado). Default `pt`. */
  languageCode?: string
}

export class ElevenLabsTts implements TtsProvider {
  private readonly fetchFn: typeof globalThis.fetch
  private readonly baseUrl: string
  private readonly model: string
  private readonly languageCode: string

  constructor(private readonly opts: ElevenLabsTtsOptions) {
    if (!opts.apiKey) throw new TypeError('ElevenLabsTts exige apiKey')
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.baseUrl = (opts.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/+$/, '')
    this.model = opts.model ?? ELEVENLABS_DEFAULT_MODEL
    this.languageCode = opts.languageCode ?? 'pt'
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const model = req.model ?? this.model
    const url = new URL(`${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}`)
    url.searchParams.set('output_format', ELEVENLABS_OUTPUT_FORMAT[req.format])
    const body: Record<string, unknown> = { text: req.text, model_id: model }
    if (!model.includes('multilingual_v2')) body.language_code = this.languageCode

    let res: Response
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'xi-api-key': this.opts.apiKey, 'content-type': 'application/json', accept: TTS_MIME[req.format] },
        body: JSON.stringify(body),
        ...(req.signal ? { signal: req.signal } : {}),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      throw new LlmUpstreamError('elevenlabs indisponível', { provider: 'elevenlabs', retryable: true }, { cause: sanitize(err) })
    }
    if (!res.ok) throw httpError('elevenlabs', res.status)
    return { audio: new Uint8Array(await res.arrayBuffer()), mime: TTS_MIME[req.format], chars: [...req.text].length }
  }
}

/** 401/403 (chave), 429 (limite) e 5xx → LlmUpstreamError; o corpo da resposta nunca entra na mensagem. */
export function httpError(provider: string, status: number): LlmUpstreamError {
  const retryable = status === 429 || status >= 500
  const what = status === 401 || status === 403 ? 'credencial recusada' : status === 429 ? 'limite de taxa' : status >= 500 ? 'erro do provedor' : 'requisição recusada'
  return new LlmUpstreamError(`${provider}: ${what} (HTTP ${status})`, { provider, status, retryable })
}

function sanitize(err: unknown): Error {
  return new Error(err instanceof Error ? err.name : 'fetch failed')
}
