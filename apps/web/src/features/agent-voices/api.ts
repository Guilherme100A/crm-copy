// API das vozes da conta (T80; 07 §3.7, §6): criação multipart com 1–3 amostras, prévia (áudio binário), manter e
// excluir. A lista usa o `voicesQuery()` dos agentes (chave `[...AGENTS_KEY, 'voices']`, lida também pelo seletor de
// voz das Configurações): toda mudança invalida essa chave.
import { AGENTS_KEY, type VoiceDto } from '@/features/agents/api'
import { activeCompany, api, buildUrl, COMPANY_HEADER, CSRF_HEADER, CSRF_VALUE, HttpError, type ApiErrorBody } from '@/lib/http'
import { apiUrl } from '@/lib/base'

export const VOICES_KEY = [...AGENTS_KEY, 'voices'] as const
export const VOICE_LANGS = ['pt', 'en', 'es', 'hi'] as const
export type VoiceLang = (typeof VOICE_LANGS)[number]
export const VOICE_MAX_SAMPLES = 3
export const VOICE_SAMPLE_MAX_BYTES = 10 * 1024 * 1024
export const VOICE_ACCEPT = '.mp3,.wav,.ogg,.oga,.m4a,.aac,.webm,.flac,audio/*'

export interface RemoveVoiceResult {
  deleted: boolean
  removed_from_agents: { id: string; name: string }[]
  warning: string | null
}

const enc = encodeURIComponent

export const voicesApi = {
  create: async (input: { name: string; language: VoiceLang; audios: File[] }) => {
    const form = new FormData()
    form.append('name', input.name)
    form.append('language', input.language)
    for (const f of input.audios) form.append('audios', f, f.name)
    return (await api.post<{ voice: VoiceDto }>('/api/ai-voices', form)).voice
  },
  keep: async (id: string) => (await api.post<{ voice: VoiceDto }>(`/api/ai-voices/${enc(id)}/keep`)).voice,
  remove: (id: string) => api.delete<RemoveVoiceResult>(`/api/ai-voices/${enc(id)}`),
  /** Prévia: o servidor devolve `audio/mpeg` (o cliente JSON não serve), lido como Blob. */
  preview: async (id: string, fetchFn: typeof fetch = (i, init) => globalThis.fetch(i, init)): Promise<Blob> => {
    const headers: Record<string, string> = { Accept: 'audio/*, application/json', [CSRF_HEADER]: CSRF_VALUE }
    const company = activeCompany()
    if (company) headers[COMPANY_HEADER] = company
    const res = await fetchFn(apiUrl(buildUrl(`/api/ai-voices/${enc(id)}/preview`)), { method: 'POST', headers, credentials: 'same-origin' })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as ApiErrorBody
      throw new HttpError(res.status, body.error?.code ?? 'HTTP_ERROR', body.error?.message ?? res.statusText, body.error?.details)
    }
    return res.blob()
  },
}
