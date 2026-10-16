import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTableName, is } from 'drizzle-orm'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as db from './index.js'
import { MIGRATION_SETS, hasMigrations, migrationSets } from './client.js'
import { randomDatabaseName, withDatabase } from './testing.js'

const crmTables = (Object.values(db) as unknown[]).filter((v): v is PgTable => is(v, PgTable))

describe('schema crm', () => {
  it('as 8 tabelas-base ficam no schema crm', () => {
    // Outras tarefas acrescentam tabelas ao crm (SPEC 2.4): a base precisa estar presente, não ser a lista inteira.
    const names = crmTables.filter((t) => getTableConfig(t).schema === 'crm').map((t) => getTableName(t))
    expect(names).toEqual(expect.arrayContaining([...db.CRM_BASE_TABLES]))
  })

  it('nenhuma tabela do CRM fica em public', () => {
    expect(crmTables.filter((t) => getTableConfig(t).schema === undefined)).toEqual([])
  })

  it('company_members tem o índice parcial de owner único', () => {
    const idx = getTableConfig(db.companyMembers).indexes.find((i) => i.config.name === 'company_members_one_owner_uq')
    expect(idx?.config.unique).toBe(true)
    expect(idx?.config.where).toBeDefined()
  })
})

describe('conjuntos de migrations', () => {
  it("'all' aplica wa antes de crm", () => {
    expect(migrationSets('all')).toEqual(['wa', 'crm'])
    expect(migrationSets('crm')).toEqual(['crm'])
  })

  it('o controle do crm fica no schema crm; o do wa no padrão do ai-manager', () => {
    expect(MIGRATION_SETS.crm.migrationsSchema).toBe('crm')
    expect(MIGRATION_SETS.wa.migrationsSchema).toBe('drizzle')
    expect(MIGRATION_SETS.crm.lockKey).not.toBe(MIGRATION_SETS.wa.lockKey)
  })

  it('hasMigrations: pasta ausente ou journal vazio não conta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-db-'))
    try {
      expect(hasMigrations(join(dir, 'nada'))).toBe(false)
      mkdirSync(join(dir, 'meta'))
      writeFileSync(join(dir, 'meta', '_journal.json'), '{"version":"7","dialect":"postgresql","entries":[]}')
      expect(hasMigrations(dir)).toBe(false)
      expect(hasMigrations(MIGRATION_SETS.crm.folder)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a migration inicial do crm cria o schema de forma idempotente e não toca em public', () => {
    const sql = readFileSync(join(MIGRATION_SETS.crm.folder, '0000_t01_base.sql'), 'utf8')
    expect(sql.startsWith('CREATE SCHEMA IF NOT EXISTS "crm";')).toBe(true)
    expect(sql).not.toMatch(/"public"\./)
  })
})

describe('testing helpers', () => {
  it('randomDatabaseName usa o prefixo crm_test', () => {
    expect(randomDatabaseName()).toMatch(/^crm_test_[0-9a-f]{12}$/)
  })

  it('withDatabase troca só o nome do banco', () => {
    expect(withDatabase('postgres://u:p@127.0.0.1:5432/crm?sslmode=disable', 'x')).toBe('postgres://u:p@127.0.0.1:5432/x?sslmode=disable')
  })
})
