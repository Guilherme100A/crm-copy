import { z } from 'zod'
import { requiredText } from './common'

// Mensagem a um número interno (equipe). `phone` sem DDI; `country_code` = DDI.
export const sendNotificationConfig = z.object({
  name: requiredText,
  phone: z.string().regex(/^\d{8,13}$/, 'telefone inválido'),
  country_code: z
    .string()
    .regex(/^\d{1,4}$/)
    .optional(),
  message: requiredText,
})
