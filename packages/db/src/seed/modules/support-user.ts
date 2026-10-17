// Usuário de suporte do harness E2E (T54): `system_role = support`, sem empresa (pede acesso pela tela
// `/support/access`; spec 16 §3.7). Mesma senha do seed-base; id fixo para os testes. Idempotente.
import { users } from '../../schema/index.js'
import { SEED_PASSWORD } from '../base.js'
import type { SeedModule } from '../index.js'

export const SEED_SUPPORT_USER = {
  id: '00000000-0000-4000-8000-000000000a05',
  email: 'support@demo.test',
  name: 'Sofia Suporte',
  systemRole: 'support' as const,
} as const

export const supportUserSeed: SeedModule = {
  name: 'support-user',
  order: 20,
  run: async ({ db, passwordHash }) => {
    await db
      .insert(users)
      .values({ ...SEED_SUPPORT_USER, passwordHash: await passwordHash(SEED_PASSWORD), lastCompanyId: null })
      .onConflictDoNothing()
  },
}
