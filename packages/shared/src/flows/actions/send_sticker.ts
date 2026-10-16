import { z } from 'zod'
import { mediaSource, requiredText } from './common'

// Figurinha JPG/PNG/WebP até 2 MB (06 §3.6).
export const sendStickerConfig = z.object({
  sticker_name: requiredText,
  sticker_url: z.string().optional(),
  media_source: mediaSource.optional(),
})
