// AC-T01-01 e AC-T01-02: runMigrations em banco vazio, controle de migrations no schema `crm`,
// idempotência e concorrência (advisory lock).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTempDb, dropTempDb, sqlOk, tableNames, columns, type TempDb } from '../helpers'
import { BASE_TABLES, REQUIRED_COLUMNS, loadDb, migrate, migrationTables, rowCount, withDb, type DbModule } from './support'

let mod: DbModule
const temps: TempDb[] = []
const fresh = () => {
  const t = createTempDb('crm_acc_t01')
  temps.push(t)
  return t
}

beforeAll(async () => {
  mod = await loadDb()
})

afterAll(() => {
  for (const t of temps) dropTempDb(t)
})

describe('runMigrations({ set: "crm" }) num banco vazio', () => {
  let db: TempDb

  beforeAll(async () => {
    db = fresh()
    await migrate(mod, db.url, 'crm')
  })

  it('AC-T01-01 cria o schema crm com as 8 tabelas-base', () => {
    const schemas = sqlOk(db.url, `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'crm';`)
    expect(schemas.length, 'schema crm não foi criado').toBe(1)
    const tables = tableNames(db.url, 'crm')
    for (const t of BASE_TABLES) expect(tables, `tabela crm.${t} ausente; existentes: ${tables.join(', ')}`).toContain(t)
  })

  it('AC-T01-01 tabelas-base têm as colunas do contrato (companies, users, company_members)', () => {
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
      const names = columns(db.url, table).map((c) => c.name)
      for (const col of required) expect(names, `crm.${table}.${col} ausente`).toContain(col)
    }
    const members = columns(db.url, 'company_members')
    const perms = members.find((c) => c.name === 'permission_keys')!
    expect(perms.udtName, 'permission_keys deve ser text[]').toBe('_text')
    expect(perms.nullable, 'permission_keys deve aceitar null').toBe(true)
    const settings = columns(db.url, 'companies').find((c) => c.name === 'settings')!
    expect(settings.udtName).toBe('jsonb')
  })

  it('AC-T01-01 grava o controle de migrations dentro do schema crm (não em public)', () => {
    const ctl = migrationTables(db.url)
    const inCrm = ctl.filter((t) => t.schema === 'crm')
    expect(inCrm.length, `nenhuma tabela de controle de migrations em crm; encontradas: ${JSON.stringify(ctl)}`).toBeGreaterThan(0)
    expect(ctl.filter((t) => t.schema !== 'crm'), 'controle de migrations fora do schema crm').toEqual([])
    expect(inCrm.some((t) => rowCount(db.url, 'crm', t.table) > 0), 'controle de migrations vazio').toBe(true)
  })

  it('AC-T01-01 não cria nenhuma tabela em public', () => {
    expect(tableNames(db.url, 'public')).toEqual([])
  })
})

describe('runMigrations({ set: "all" }) repetido e concorrente', () => {
  it('AC-T01-02 duas execuções seguidas de set "all" terminam sem erro e não reaplicam migrations', async () => {
    const db = fresh()
    await migrate(mod, db.url, 'all')
    const ctl = migrationTables(db.url)
    const before = ctl.map((t) => rowCount(db.url, t.schema, t.table))
    await migrate(mod, db.url, 'all')
    expect(ctl.map((t) => rowCount(db.url, t.schema, t.table)), 'segunda execução reaplicou migrations').toEqual(before)
    for (const t of BASE_TABLES) expect(tableNames(db.url, 'crm')).toContain(t)
  })

  it('AC-T01-02 chamadas concorrentes de set "all" (conexões distintas) não falham', async () => {
    const reference = fresh()
    await migrate(mod, reference.url, 'all')
    const refCounts = migrationTables(reference.url).map((t) => `${t.schema}.${t.table}=${rowCount(reference.url, t.schema, t.table)}`)

    const db = fresh()
    const runs = await Promise.allSettled(
      Array.from({ length: 4 }, () => withDb(mod, db.url, (d) => mod.runMigrations(d, { set: 'all' }))),
    )
    const failures = runs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason?.message ?? r.reason))
    expect(failures, `execuções concorrentes falharam:\n${failures.join('\n')}`).toEqual([])
    for (const t of BASE_TABLES) expect(tableNames(db.url, 'crm')).toContain(t)
    const counts = migrationTables(db.url).map((t) => `${t.schema}.${t.table}=${rowCount(db.url, t.schema, t.table)}`)
    expect(counts, 'concorrência duplicou registros de migrations').toEqual(refCounts)
  })

  it('AC-T01-02 set "crm" seguido de set "all" no mesmo banco não falha', async () => {
    const db = fresh()
    await migrate(mod, db.url, 'crm')
    await migrate(mod, db.url, 'all')
    await migrate(mod, db.url, 'crm')
  })
})
