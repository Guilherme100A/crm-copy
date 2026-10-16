import { z } from 'zod'
import { requiredText } from './common'

// Remove o card do quadro, em qualquer etapa.
export const removeKanbanCardConfig = z.object({
  crm_id: requiredText,
  crm_name: z.string().optional(),
})
