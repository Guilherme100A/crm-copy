// AC-T98-03: no modo extensão o CRM aplica SÓ o conjunto `crm` sobre o banco do ai-manager. Num banco com o schema
// do ai-manager (fixture `fixtures/public`: as migrations dele, aplicadas como ele aplica, em `drizzle.__drizzle_migrations`),
// as migrations `crm` não alteram nada em `public` nem o controle de migrations do ai-manager.
import { fileURLToPath } from 'node:url'
import { createDb, runMigrations, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'

const FIXTURE = fileURLToPath(new URL('./fixtures/public', import.meta.url))

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ prefix: 'crm_test_t98' })
  db = createDb(tmp.url, { max: 2 })
  await runMigrations(db, { set: 'wa', folders: { wa: FIXTURE } })
}, 120_000)

afterAll(async () => {
  // Pool fechado ANTES do drop (57P01, docs/licoes.md).
  await db?.$client.end()
  await tmp?.drop()
}, 60_000)

const rows = async (sql: string) => (await db.$client.query(sql)).rows as Record<string, unknown>[]

/** Tudo o que define `public`: tabelas, colunas, constraints, índices, enums, sequências, views, funções e triggers. */
async function snapshotPublic() {
  return {
    tables: await rows(
      `select table_name, table_type from information_schema.tables where table_schema = 'public' order by 1`,
    ),
    columns: await rows(
      `select table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default, character_maximum_length, numeric_precision
         from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`,
    ),
    constraints: await rows(
      `select c.conrelid::regclass::text as rel, c.conname, c.contype, pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public' order by 1, 2`,
    ),
    indexes: await rows(
      `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`,
    ),
    enums: await rows(
      `select t.typname, e.enumlabel, e.enumsortorder from pg_type t join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' order by 1, 3`,
    ),
    sequences: await rows(
      `select sequence_name, data_type, start_value, increment from information_schema.sequences where sequence_schema = 'public' order by 1`,
    ),
    functions: await rows(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1, 2`,
    ),
    triggers: await rows(
      `select event_object_table, trigger_name, action_statement from information_schema.triggers where trigger_schema = 'public' order by 1, 2`,
    ),
    grants: await rows(
      `select table_name, grantee, privilege_type from information_schema.table_privileges where table_schema = 'public' order by 1, 2, 3`,
    ),
    aiManagerMigrations: await rows(`select hash, created_at from drizzle.__drizzle_migrations order by id`),
  }
}

it('AC-T98-03: migrations crm sobre o schema do ai-manager não alteram tabelas public', async () => {
  const before = await snapshotPublic()
  // A fixture é o banco do ai-manager: as tabelas WhatsApp dele e as 8 migrations registradas no controle padrão.
  expect(before.tables.map((t) => t.table_name)).toEqual(
    expect.arrayContaining(['sessions', 'session_credentials', 'proxies', 'session_limits', 'messages', 'contacts']),
  )
  expect(before.aiManagerMigrations).toHaveLength(8)

  await runMigrations(db, { set: 'crm' })

  const after = await snapshotPublic()
  expect(after).toEqual(before)
  // O CRM ficou todo em `crm`, com o controle de migrations próprio.
  const crm = await rows(`select count(*)::int as n from information_schema.tables where table_schema = 'crm'`)
  expect(Number(crm[0]!.n)).toBeGreaterThan(10)
  const crmMigrations = await rows(`select count(*)::int as n from crm.__drizzle_migrations`)
  expect(Number(crmMigrations[0]!.n)).toBeGreaterThan(0)

  // Reaplicar é idempotente e continua sem tocar `public`.
  await runMigrations(db, { set: 'crm' })
  expect(await snapshotPublic()).toEqual(before)

  // Controle: o snapshot enxerga uma mudança de verdade em `public`.
  await db.$client.query(`alter table public.contacts add column t98_probe text`)
  expect(await snapshotPublic()).not.toEqual(before)
}, 120_000)
