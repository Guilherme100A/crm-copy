import { z } from 'zod'
import { numberOrTemplate, requiredText } from './common'

export const createKanbanCardConfig = z.object({
  crm_id: requiredText,
  crm_name: z.string().optional(),
  crm_column_id: requiredText,
  crm_column_name: z.string().optional(),
  crm_column_conversion_goal: z.boolean().optional(),
  // Só quando a coluna é meta de conversão; aceita variável.
  value: numberOrTemplate.optional(),
})
