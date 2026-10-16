// SttProvider sobre a API da Groq (compatível com OpenAI, STACK E §3): POST /audio/transcriptions,
// `whisper-large-v3-turbo` com `language: 'pt'` (sem ele áudios curtos saem em outro idioma). `fetch` injetável.
import { httpError } from '../elevenlabs/tts'
import { LlmUpstreamError } from '../port/errors'
import type { SttProvider, SttRequest, SttResult } from '../port/voice'

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
export const GROQ_DEFAULT_MODEL = 'whisper-large-v3-turbo'
export const GROQ_DEFAULT_LANGUAGE = 'pt'

export interface GroqSttOptions {
  apiKey: string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  model?: string
}

const EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
}

export class GroqStt implements SttProvider {
  private readonly fetchFn: typeof globalThis.fetch
  private readonly baseUrl: string
  private readonly model: string

  constructor(private readonly opts: GroqSttOptions) {
    if (!opts.apiKey) throw new TypeError('GroqStt exige apiKey')
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.baseUrl = (opts.baseUrl ?? GROQ_BASE_URL).replace(/\/+$/, '')
    this.model = opts.model ?? GROQ_DEFAULT_MODEL
  }

  async transcribe(req: SttRequest): Promise<SttResult> {
    const mime = req.mime.split(';')[0]!.trim().toLowerCase()
    const language = req.language ?? GROQ_DEFAULT_LANGUAGE
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(req.audio)], { type: mime }), `audio.${EXT[mime] ?? 'ogg'}`)
    form.append('model', this.model)
    form.append('language', language)
    // verbose_json traz a duração (base de custo do STT).
    form.append('response_format', 'verbose_json')
    form.append('temperature', '0')

    let res: Response
    try {
      res = await this.fetchFn(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        ...(req.signal ? { signal: req.signal } : {}),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      throw new LlmUpstreamError('groq indisponível', { provider: 'groq', retryable: true })
    }
    if (!res.ok) throw httpError('groq', res.status)
    const json = (await res.json()) as { text?: unknown; duration?: unknown; language?: unknown }
    if (typeof json.text !== 'string') throw new LlmUpstreamError('groq: resposta sem texto', { provider: 'groq', status: res.status })
    const out: SttResult = { text: json.text.trim(), seconds: typeof json.duration === 'number' ? json.duration : 0 }
    out.language = typeof json.language === 'string' ? normalizeLanguage(json.language) : language
    return out
  }
}

const LANGUAGE_NAMES: Record<string, string> = { portuguese: 'pt', english: 'en', spanish: 'es' }

/** verbose_json devolve o idioma por extenso (`portuguese`); a porta usa ISO 639-1. */
function normalizeLanguage(value: string): string {
  const v = value.toLowerCase()
  return LANGUAGE_NAMES[v] ?? v
}
