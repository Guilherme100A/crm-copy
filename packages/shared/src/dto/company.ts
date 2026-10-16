// DTO de empresa no fio (snake_case). Espelha `crm.companies` (T01).
import * as z from 'zod'
import { idSchema } from '../ids'

export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo'

export const companySlugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use letras minúsculas, números e hífens')

export const timeZoneSchema = z.string().min(1).refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return true
    } catch {
      return false
    }
  },
  { message: 'Fuso horário IANA inválido' },
)

export const companySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  slug: companySlugSchema,
  active: z.boolean(),
  time_zone: timeZoneSchema,
  settings: z.record(z.string(), z.unknown()),
  deactivated_at: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
})
export type Company = z.infer<typeof companySchema>

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: companySlugSchema.optional(),
  time_zone: timeZoneSchema.default(DEFAULT_TIME_ZONE),
})
export type CreateCompanyInput = z.infer<typeof createCompanySchema>

export const updateCompanySchema = createCompanySchema.partial()
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>
