import { z } from 'zod'
import { requiredText, seconds } from './common'

// Nó Mensagem — texto com variáveis `{...}` e formatação WhatsApp (06 §3.6).
export const sendMessageConfig = z.object({
  message_text: requiredText,
  typing_delay_seconds: seconds.optional(),
  vary_text_with_ai: z.boolean().optional(),
  ai_integration_id: z.string().nullish(),
  delete_on_label_enabled: z.boolean().optional(),
  delete_on_label_id: z.string().nullish(),
  delete_on_label_name: z.string().nullish(),
})
