import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyPassword } from '@crm/node-kit'
import { createDb, type Database } from '../client.js'
import { companies, companyMembers, users } from '../schema/index.js'
import { createTempDatabase, type TempDatabase } from '../testing.js'
import { listSeedModules, registerSeedModule, resetAndSeed, resetDatabase, runSeeds, SEED_BASE, type SeedModule } from './index.js'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 2 })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

describe('seed-base', () => {
  it('admin da plataforma, Empresa Demo e owner/admin/member com a senha conhecida', async () => {
    await resetAndSeed(db, { modules: [] })
    const [co] = await db.select().from(companies)
    expect(co).toMatchObject({ id: SEED_BASE.company.id, name: 'Empresa Demo', slug: 'empresa-demo' })
    const rows = await db
      .select({ email: users.email, systemRole: users.systemRole, hash: users.passwordHash, role: companyMembers.role, lastCompanyId: users.lastCompanyId })
      .from(users)
      .innerJoin(companyMembers, eq(companyMembers.userId, users.id))
    const by = Object.fromEntries(rows.map((r) => [r.email, r]))
    expect(by['platform@demo.test']).toMatchObject({ systemRole: 'platform_admin' })
    expect(by['owner@demo.test']).toMatchObject({ role: 'owner', systemRole: 'user', lastCompanyId: SEED_BASE.company.id })
    expect(by['admin@demo.test']).toMatchObject({ role: 'admin' })
    expect(by['member@demo.test']).toMatchObject({ role: 'member' })
    for (const r of rows) expect(await verifyPassword(r.hash, SEED_BASE.password)).toBe(true)
  })

  it('resetDatabase esvazia as tabelas e mantém as migrations', async () => {
    await resetAndSeed(db, { modules: [] })
    const tables = await resetDatabase(db)
    expect(tables.some((t) => t.includes('users'))).toBe(true)
    expect(tables.some((t) => t.includes('__drizzle_migrations'))).toBe(false)
    expect(await db.select().from(users)).toEqual([])
    // seed de novo depois do reset: mesmos ids
    await runSeeds(db, { modules: [] })
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, SEED_BASE.users.owner.email))
    expect(owner!.id).toBe(SEED_BASE.users.owner.id)
  })
})

describe('AC-T17-05 seeds de módulo', () => {
  it('ordem determinística (order, depois nome), igual em toda execução', async () => {
    const ran: string[] = []
    const mod = (name: string, order?: number): SeedModule => ({ name, order, run: () => void ran.push(name) })
    const offs = [mod('zeta'), mod('alpha', 200), mod('beta', 10), mod('gamma'), mod('aaa', 10)].map((m) => registerSeedModule(m))
    try {
      expect(listSeedModules().map((m) => m.name)).toEqual(['aaa', 'beta', 'gamma', 'zeta', 'alpha'])
      for (let i = 0; i < 2; i++) {
        ran.length = 0
        const { applied } = await resetAndSeed(db)
        expect(applied).toEqual(['base', 'aaa', 'beta', 'gamma', 'zeta', 'alpha'])
        expect(ran).toEqual(['aaa', 'beta', 'gamma', 'zeta', 'alpha'])
      }
    } finally {
      for (const off of offs) off()
    }
    expect(listSeedModules()).toEqual([])
  })

  it('nome repetido ou reservado → erro; módulo recebe db e passwordHash', async () => {
    const off = registerSeedModule({ name: 'dup', run: () => undefined })
    try {
      expect(() => registerSeedModule({ name: 'dup', run: () => undefined })).toThrow(/já registrado/)
      expect(() => registerSeedModule({ name: 'base', run: () => undefined })).toThrow()
    } finally {
      off()
    }
    let hash = ''
    await resetDatabase(db)
    await runSeeds(db, { modules: [{ name: 'x', run: async (ctx) => void (hash = await ctx.passwordHash('abc12345')) }] })
    expect(await verifyPassword(hash, 'abc12345')).toBe(true)
  })
})
