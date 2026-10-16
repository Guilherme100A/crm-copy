// T124: limpeza de bancos órfãos com Postgres real. Só toca bancos criados por este teste (match), para não afetar
// os de outros worktrees no servidor compartilhado. Roda pelo vitest do @crm/api.
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupOrphanDatabases, isOrphanCandidate, orphanMinAgeMs } from './orphans.mjs'

const pg = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'db', 'package.json'))('pg')
const BASE = process.env.DATABASE_URL || 'postgres://wsm:wsm@127.0.0.1:5432/crm'
const tag = randomBytes(3).toString('hex')
const names = { idle: `crm_test_t124u_${tag}_idle`, active: `crm_test_t124u_${tag}_active`, kept: `crm_e2e_t124u_${tag}_prot`, other: `crmx_t124u_${tag}` }

async function admin(text) {
  const c = new pg.Client({ connectionString: BASE })
  await c.connect()
  try {
    return await c.query(text)
  } finally {
    await c.end()
  }
}
function withDb(name) {
  const u = new URL(BASE)
  u.pathname = `/${name}`
  return u.toString()
}
const exists = async (name) => (await admin(`select 1 from pg_database where datname = '${name}'`)).rows.length === 1
let holder

beforeAll(async () => {
  for (const n of Object.values(names)) await admin(`CREATE DATABASE "${n}"`)
  holder = new pg.Client({ connectionString: withDb(names.active) })
  await holder.connect()
}, 60_000)
afterAll(async () => {
  await holder?.end()
  for (const n of Object.values(names)) await admin(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`)
}, 60_000)

describe('cleanupOrphanDatabases', () => {
  const match = new RegExp(`_t124u_${tag}`)

  it('candidatos só com os prefixos de teste; idade mínima do env', () => {
    for (const n of ['crm_e2e_abc', 'crm_test_abc', 'crm_acc_abc']) expect(isOrphanCandidate(n), n).toBe(true)
    for (const n of ['crm', 'postgres', 'wsm', 'wsm_test_1', 'crm_e2e_', 'crmx_test', 'template1', 'crm_test_x"y']) expect(isOrphanCandidate(n), n).toBe(false)
    expect(orphanMinAgeMs({})).toBe(30 * 60_000)
    expect(orphanMinAgeMs({ E2E_ORPHAN_MIN_AGE_MIN: '0' })).toBe(0)
    expect(() => orphanMinAgeMs({ E2E_ORPHAN_MIN_AGE_MIN: '-1' })).toThrow()
  })

  it('recentes ficam; antigos sem conexão caem; com conexão, protegidos e fora do prefixo ficam', async () => {
    const recent = await cleanupOrphanDatabases({ baseUrl: BASE, match })
    expect(recent.dropped).toEqual([])
    expect(recent.kept.find((k) => k.name === names.idle)?.reason).toBe('recent')

    const dry = await cleanupOrphanDatabases({ baseUrl: BASE, match, minAgeMs: 0, dryRun: true, protect: [names.kept] })
    expect(dry.dropped).toEqual([names.idle])
    expect(await exists(names.idle)).toBe(true)

    const res = await cleanupOrphanDatabases({ baseUrl: BASE, match, minAgeMs: 0, protect: [names.kept] })
    expect(res.dropped).toEqual([names.idle])
    expect(Object.fromEntries(res.kept.map((k) => [k.name, k.reason]))).toEqual({ [names.active]: 'active', [names.kept]: 'protected' })
    expect(await exists(names.idle)).toBe(false)
    expect(await exists(names.active)).toBe(true)
    expect(await exists(names.kept)).toBe(true)
    expect(await exists(names.other)).toBe(true)
    expect(await exists('crm')).toBe(true)
  }, 60_000)
})
