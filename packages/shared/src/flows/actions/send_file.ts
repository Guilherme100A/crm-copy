import { z } from 'zod'
import { mediaSource, requiredText } from './common'

// Arquivo/documento até 30 MB (06 §3.6).
export const sendFileConfig = z.object({
  file_name: requiredText,
  file_url: z.string().optional(),
  media_source: mediaSource.optional(),
})
