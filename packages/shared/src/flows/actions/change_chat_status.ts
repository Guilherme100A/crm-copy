import { z } from 'zod'

// Valores em português, como na referência (06 §3.6).
export const CHAT_STATUS_VALUES = ['Aguardando', 'Atendimento', 'Resolvidos'] as const

export const changeChatStatusConfig = z.object({
  chat_status: z.enum(CHAT_STATUS_VALUES),
})
