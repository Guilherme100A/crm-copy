import { z } from 'zod'
import { requiredText } from './common'

// Data de criação do contato: "dd/MM/aaaa HH:mm:ss" (fuso da empresa), ISO 8601 ou variáveis.
export const setCreatedAtConfig = z.object({
  operation: z.literal('set_value'),
  value: requiredText,
})
