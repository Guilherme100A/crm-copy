import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { verifyPassword } from '@crm/node-kit'
import { createDb, type Database } from '../../client.js'
import { companyMembers, users } from '../../schema/index.js'
import { createTempDatabase, type TempDatabase } from '../../testing.js'
import { runSeeds, SEED_PASSWORD } from '../index.js'
import { SEED_SUPPORT_USER, supportUserSeed } from './support-user.js'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 2 })
}, 60_000)
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

describe('seed do usuário de suporte (T54)', () => {
  it('cria support@demo.test (system_role support, sem empresa) com a senha do seed; idempotente', async () => {
    await runSeeds(db, { modules: [supportUserSeed] })
    await supportUserSeed.run({ db, passwordHash: async () => 'x' })
    const rows = await db.select().from(users).where(eq(users.email, SEED_SUPPORT_USER.email))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(SEED_SUPPORT_USER.id)
    expect(rows[0]!.systemRole).toBe('support')
    expect(rows[0]!.lastCompanyId).toBeNull()
    expect(await verifyPassword(rows[0]!.passwordHash, SEED_PASSWORD)).toBe(true)
    expect(await db.select().from(companyMembers).where(eq(companyMembers.userId, SEED_SUPPORT_USER.id))).toEqual([])
  })
})
