// DTO de usuário no fio (snake_case). Espelha `crm.users` (T01) sem `password_hash`.
import * as z from 'zod'
import { idSchema } from '../ids'
import { SYSTEM_ROLES } from '../permissions/resolve'

export const LOCALES = ['pt-BR', 'en', 'es'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'pt-BR'

export const localeSchema = z.enum(LOCALES)
export const systemRoleSchema = z.enum(SYSTEM_ROLES)

export const emailSchema = z.email().max(254).transform((e) => e.trim().toLowerCase())
export const PASSWORD_MIN_LENGTH = 8
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(200)

export const userSchema = z.object({
  id: idSchema,
  email: z.email(),
  name: z.string(),
  system_role: systemRoleSchema,
  locale: localeSchema,
  avatar_url: z.string().nullable(),
  last_company_id: idSchema.nullable(),
  created_at: z.iso.datetime({ offset: true }),
})
export type User = z.infer<typeof userSchema>

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  locale: localeSchema.optional(),
})
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
