import { z } from 'zod'
import { requiredText } from './common'

export const setDepartmentConfig = z.object({
  department_id: requiredText,
  department_name: z.string().optional(),
  department_color: z.string().optional(),
})
