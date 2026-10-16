// Seed-base do harness E2E (T17): admin da plataforma, "Empresa Demo" e owner/admin/member com senha conhecida.
// Ids fixos: são os mesmos depois de cada `/__e2e/reset`, para os testes poderem referenciá-los.
import { companies, companyMembers, users } from '../schema/index.js'
import type { SeedContext } from './index.js'

export const SEED_PASSWORD = 'Senha-e2e-123'

export const SEED_COMPANY = {
  id: '00000000-0000-4000-8000-00000000c001',
  name: 'Empresa Demo',
  slug: 'empresa-demo',
} as const

export const SEED_USERS = {
  platformAdmin: { id: '00000000-0000-4000-8000-000000000a01', email: 'platform@demo.test', name: 'Admin da Plataforma', role: 'member' as const, systemRole: 'platform_admin' as const },
  owner: { id: '00000000-0000-4000-8000-000000000a02', email: 'owner@demo.test', name: 'Olivia Owner', role: 'owner' as const, systemRole: 'user' as const },
  admin: { id: '00000000-0000-4000-8000-000000000a03', email: 'admin@demo.test', name: 'Alan Admin', role: 'admin' as const, systemRole: 'user' as const },
  member: { id: '00000000-0000-4000-8000-000000000a04', email: 'member@demo.test', name: 'Maria Member', role: 'member' as const, systemRole: 'user' as const },
} as const

/** Tudo o que os testes precisam saber do seed-base. */
export const SEED_BASE = { password: SEED_PASSWORD, company: SEED_COMPANY, users: SEED_USERS } as const

export async function seedBase(ctx: SeedContext): Promise<void> {
  const { db } = ctx
  const passwordHash = await ctx.passwordHash(SEED_PASSWORD)
  await db.insert(companies).values({ id: SEED_COMPANY.id, name: SEED_COMPANY.name, slug: SEED_COMPANY.slug })
  const all = Object.values(SEED_USERS)
  await db.insert(users).values(
    all.map((u) => ({ id: u.id, email: u.email, name: u.name, passwordHash, systemRole: u.systemRole, lastCompanyId: SEED_COMPANY.id })),
  )
  await db.insert(companyMembers).values(all.map((u) => ({ companyId: SEED_COMPANY.id, userId: u.id, role: u.role })))
}
