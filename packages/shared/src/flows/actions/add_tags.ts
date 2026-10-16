import { z } from 'zod'
import { requiredText } from './common'

// Etiquetas pelo nome; ≥ 1 (06 §3.6).
export const addTagsConfig = z.object({
  action: z.literal('add').optional(),
  tags: z.array(requiredText).min(1),
})
