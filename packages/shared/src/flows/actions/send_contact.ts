import { z } from 'zod'
import { requiredText } from './common'

// Cartão de contato; nome e telefone aceitam variáveis (06 §3.6).
export const sendContactConfig = z.object({
  contact_name: requiredText,
  contact_phone: requiredText,
})
