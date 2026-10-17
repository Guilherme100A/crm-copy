// Regras puras da aba Vozes (07 §3.7): 1–3 amostras de até 10 MB em formatos de áudio aceitos, nome de 1 a 100
// caracteres, e o mapeamento dos erros do servidor (`details.error_code`) para as chaves i18n `voices.errors.*`.
import { HttpError } from '@/lib/http'
import { VOICE_MAX_SAMPLES, VOICE_SAMPLE_MAX_BYTES } from './api'

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.webm', '.flac']
const AUDIO_MIME_RE = /^audio\/(mpeg|mp3|wav|x-wav|wave|vnd\.wave|ogg|opus|mp4|x-m4a|m4a|aac|x-aac|webm|flac|x-flac)$/i

export interface SampleLike {
  name: string
  size: number
  type: string
}

/** Mesma regra do servidor: extensão OU mime (sem `;codecs`). */
export function isAudioFile(f: Pick<SampleLike, 'name' | 'type'>): boolean {
  const ext = /\.[^.]+$/.exec(f.name.toLowerCase())?.[0] ?? ''
  return AUDIO_EXTENSIONS.includes(ext) || AUDIO_MIME_RE.test(f.type.split(';')[0]!.trim())
}

export type SampleError = 'count' | 'tooLarge' | 'unsupported' | 'empty'

export function sampleError(files: SampleLike[]): SampleError | null {
  if (files.length < 1 || files.length > VOICE_MAX_SAMPLES) return 'count'
  for (const f of files) {
    if (!f.size) return 'empty'
    if (f.size > VOICE_SAMPLE_MAX_BYTES) return 'tooLarge'
    if (!isAudioFile(f)) return 'unsupported'
  }
  return null
}

/** Junta as amostras novas às atuais até o máximo de 3; `overflow` diz se alguma ficou de fora. */
export function addSamples<T>(current: T[], incoming: T[]): { files: T[]; overflow: boolean } {
  const files = [...current, ...incoming].slice(0, VOICE_MAX_SAMPLES)
  return { files, overflow: current.length + incoming.length > VOICE_MAX_SAMPLES }
}

export type VoiceFormError = SampleError | 'name'

export function voiceFormError(name: string, files: SampleLike[]): VoiceFormError | null {
  const n = name.trim()
  if (!n || n.length > 100) return 'name'
  return sampleError(files)
}

export type VoiceErrorKey =
  | 'notConfigured'
  | 'quota'
  | 'count'
  | 'tooLarge'
  | 'unsupported'
  | 'empty'
  | 'name'
  | 'language'
  | 'upstream'
  | 'notFound'
  | 'generic'

const CODES: Record<string, VoiceErrorKey> = {
  provider_not_configured: 'notConfigured',
  audios_count: 'count',
  too_large: 'tooLarge',
  unsupported_audio: 'unsupported',
  audio_empty: 'empty',
  name_required: 'name',
  language_invalid: 'language',
}

export function voiceErrorKey(err: unknown): VoiceErrorKey {
  if (!(err instanceof HttpError)) return 'generic'
  const code = (err.details as { error_code?: unknown } | undefined)?.error_code
  if (typeof code === 'string' && CODES[code]) return CODES[code]
  if (err.code === 'QUOTA_EXCEEDED') return 'quota'
  if (err.code === 'UPSTREAM_ERROR') return 'upstream'
  if (err.code === 'PAYLOAD_TOO_LARGE') return 'tooLarge'
  if (err.status === 404) return 'notFound'
  return 'generic'
}

/** Tamanho legível (KB/MB). */
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
