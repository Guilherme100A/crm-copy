import { z } from 'zod'
import { seconds } from './common'

const mediaItem = z.object({
  url: z.string().optional(),
  media_url: z.string().optional(),
  caption: z.string().optional(),
  view_once: z.boolean().optional(),
})

// Mídia (imagem/vídeo/áudio) por arquivo, URL ou áudio gerado por IA (06 §3.6).
export const sendMultiMediaConfig = z
  .object({
    media_type: z.enum(['image', 'video', 'audio']),
    media_source: z.enum(['file', 'url', 'ai']),
    messages: z.array(mediaItem).optional(),
    media_url: z.string().optional(),
    uazapi_video_type: z.enum(['video', 'videoplay', 'ptv']).optional(),
    audio_forward: z.boolean().optional(),
    typing_delay_seconds: seconds.optional(),
    ai_audio_text: z.string().optional(),
    elevenlabs_voice_id: z.string().optional(),
    elevenlabs_model_id: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.media_source === 'ai') {
      if (c.media_type !== 'audio') ctx.addIssue({ code: 'custom', message: 'mídia por IA só para áudio', path: ['media_source'] })
      if (!c.ai_audio_text?.trim()) ctx.addIssue({ code: 'custom', message: 'texto do áudio obrigatório', path: ['ai_audio_text'] })
      return
    }
    const hasItem = (c.messages ?? []).some((m) => (m.url ?? m.media_url)?.trim())
    if (!c.media_url?.trim() && !hasItem) ctx.addIssue({ code: 'custom', message: 'informe a mídia', path: ['media_url'] })
  })
