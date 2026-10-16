// DTO de membro da empresa no fio (snake_case). Espelha `crm.company_members` (T01) + dados do usuário.
import * as z from 'zod'
import { idSchema } from '../ids'
import { COMPANY_ROLES } from '../permissions/defaults'

export const companyRoleSchema = z.enum(COMPANY_ROLES)

export const memberSchema = z.object({
  id: idSchema,
  company_id: idSchema,
  user_id: idSchema,
  role: companyRoleSchema,
  /** Lista explícita; `null` = matriz padrão do papel. */
  permission_keys: z.array(z.string()).nullable(),
  user: z.object({ name: z.string(), email: z.email() }),
  created_at: z.iso.datetime({ offset: true }),
})
export type Member = z.infer<typeof memberSchema>

export const updateMemberRoleSchema = z.object({
  role: z.enum(['admin', 'member']),
})
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>

export const updateMemberPermissionsSchema = z.object({
  permission_keys: z.array(z.string()).nullable(),
})
export type UpdateMemberPermissionsInput = z.infer<typeof updateMemberPermissionsSchema>
