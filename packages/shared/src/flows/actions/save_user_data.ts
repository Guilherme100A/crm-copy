import { z } from 'zod'
import { requiredText } from './common'

// Salva a resposta do lead num campo (menus e Aguarda Resposta).
export const saveUserDataConfig = z.object({
  field_name: requiredText,
  save_empty: z.boolean().optional(),
})
