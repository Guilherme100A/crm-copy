// Portas de voz: TTS (ex.: ElevenLabs) e STT (ex.: Groq Whisper). Adapters reais em T12.

export const TTS_FORMATS = ['mp3', 'ogg_opus', 'wav', 'pcm'] as const
export type TtsFormat = (typeof TTS_FORMATS)[number]

export const TTS_MIME: Readonly<Record<TtsFormat, string>> = {
  mp3: 'audio/mpeg',
  ogg_opus: 'audio/ogg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
}

export interface TtsRequest {
  text: string
  voiceId: string
  format: TtsFormat
  /** Modelo do provedor (padrão do adapter se ausente). */
  model?: string
  signal?: AbortSignal
}

export interface TtsResult {
  audio: Uint8Array
  mime: string
  /** Caracteres cobrados (base de custo do TTS). */
  chars: number
}

export interface TtsProvider {
  synthesize(req: TtsRequest): Promise<TtsResult>
}

export interface SttRequest {
  audio: Uint8Array
  mime: string
  /** ISO 639-1 (ex.: `pt`). */
  language?: string
  signal?: AbortSignal
}

export interface SttResult {
  text: string
  /** Duração do áudio em segundos (base de custo do STT). */
  seconds: number
  language?: string
}

export interface SttProvider {
  transcribe(req: SttRequest): Promise<SttResult>
}
