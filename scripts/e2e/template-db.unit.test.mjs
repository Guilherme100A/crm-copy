// T128: clone pelo caminho rápido em JS (modelo já existe) e nomes dos modelos atuais. Roda pelo vitest do @crm/api.
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { cloneTemplateDatabase, currentTemplateNames, templateDatabaseName } from './template-db.mjs'
import { isTemplateCandidate } from './orphans.mjs'

const pg = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'db', 'package.json'))(
  'pg',
)
const BASE = process.env.DATABASE_URL || 'postgres://wsm:wsm@127.0.0.1:5432/crm'
const made = []

async function q(url, text, values) {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    return (await c.query(text, values)).rows
  } finally {
    await c.end()
  }
}
const withDb = (name) => {
  const u = new URL(BASE)
  u.pathname = `/${name}`
  return u.toString()
}

afterAll(async () => {
  for (const n of made) await q(BASE, `DROP DATABASE IF EXISTS "${n}"`)
}, 60_000)

describe('template-db.mjs', () => {
  it('nomes atuais: um por conjunto, todos reconhecidos como modelo pela limpeza', () => {
    const names = currentTemplateNames()
    expect(names).toEqual(['all', 'wa', 'crm'].map((s) => templateDatabaseName(s)))
    for (const n of names) expect(isTemplateCandidate(n), n).toBe(true)
    for (const n of ['crm_tpl_all_xyz', 'crm_tpl_foo_0123456789ab', 'crm', 'crm_test_abc'])
      expect(isTemplateCandidate(n), n).toBe(false)
  })

  it('clona o modelo do conjunto `wa`; com o modelo pronto, nenhuma migração roda (created=false)', async () => {
    const a = `crm_test_t128js_${randomBytes(3).toString('hex')}`
    const b = `crm_test_t128js_${randomBytes(3).toString('hex')}`
    made.push(a, b)
    const first = await cloneTemplateDatabase(a, { baseUrl: BASE, set: 'wa' })
    expect(first.name).toBe(templateDatabaseName('wa'))
    const second = await cloneTemplateDatabase(b, { baseUrl: BASE, set: 'wa' })
    expect(second).toMatchObject({ name: templateDatabaseName('wa'), created: false })
    const [tpl] = await q(BASE, 'select datistemplate, datallowconn from pg_database where datname = $1', [second.name])
    expect(tpl).toEqual({ datistemplate: true, datallowconn: false })
    const rows = await q(withDb(b), 'select count(*)::int as n from drizzle.__drizzle_migrations')
    expect(rows[0].n).toBeGreaterThan(0)
  }, 120_000)
})
