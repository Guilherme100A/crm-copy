import { z } from 'zod'
import { requiredText } from './common'

export const removeTagsConfig = z.object({
  action: z.literal('remove').optional(),
  tags: z.array(requiredText).min(1),
})
