import { text, uuid } from 'drizzle-orm/pg-core'
import { users } from './base.js'
import { crm, updatedAt } from './schema.js'

// Dados de perfil fora das tabelas-base (T15): WhatsApp pessoal e o código do afiliado que indicou o cadastro.
// `referred_by_code` não é único (vários cadastros pelo mesmo afiliado); `users.referral_code` é o código do próprio usuário.
export const userProfiles = crm.table('user_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  personalWhatsapp: text('personal_whatsapp'),
  referredByCode: text('referred_by_code'),
  updatedAt: updatedAt(),
})
