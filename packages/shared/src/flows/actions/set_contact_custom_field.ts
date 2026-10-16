import { z } from 'zod'
import { requiredText } from './common'

// Manipulador: define ou faz conta sobre um campo personalizado do contato.
export const setContactCustomFieldConfig = z
  .object({
    field_name: requiredText,
    operation: z.enum(['set_value', 'add', 'subtract', 'multiply', 'divide']),
    value_type: z.enum(['text', 'number']).optional(),
    value: z.union([z.string(), z.number()]),
  })
  .superRefine((c, ctx) => {
    if (c.operation !== 'set_value' && c.value_type === 'text') ctx.addIssue({ code: 'custom', message: 'operação matemática exige número', path: ['value_type'] })
  })
