// AC-T01-05: as migrations `crm` aplicadas num banco que já tem as tabelas public.* do ai-manager
// não alteram nenhuma tabela `public` (nem o journal de migrations do ai-manager).
// Fixture: SQL das migrations 0000..0007 do ai-manager (cópia somente leitura em fixtures/ai-manager-public).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTempDb, dropTempDb, sqlOk, tableNames, type TempDb } from '../helpers'
import { BASE_TABLES, loadDb, migrate, type DbModule } from './support'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'ai-manager-public')

/** Aplica as migrations do ai-manager e simula o journal do drizzle dele (schema `drizzle`, padrão do drizzle-kit). */
function seedAiManager(url: string) {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) sqlOk(url, readFileSync(join(FIXTURES, f), 'utf8').replace(/--> statement-breakpoint/g, ''))
  sqlOk(
    url,
    `CREATE SCHEMA IF NOT EXISTS drizzle;
     CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
     INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
       SELECT md5(n::text), 1700000000000 + n FROM generate_series(0, ${files.length - 1}) n;
     INSERT INTO public.contacts (name, phone, consent, consent_source) VALUES ('Contato fixture', '+5599900000001', true, 'manual');`,
  )
}

/** Fotografia estrutural + dados de tudo que pertence a public e ao journal do ai-manager. */
function snapshot(url: string): Record<string, string[]> {
  const q = (s: string) => sqlOk(url, s).map((r) => r.join('|'))
  const tables = tableNames(url, 'public')
  return {
    tables: tables,
    columns: q(`SELECT table_name, column_name, data_type, udt_name, is_nullable, coalesce(column_default,''), ordinal_position
                  FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 7;`),
    constraints: q(`SELECT c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid)
                      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' ORDER BY 1, 2;`),
    indexes: q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2;`),
    triggers: q(`SELECT event_object_table, trigger_name, action_statement FROM information_schema.triggers WHERE trigger_schema = 'public' ORDER BY 1, 2;`),
    enums: q(`SELECT t.typname, e.enumlabel, e.enumsortorder FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
                JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' ORDER BY 1, 3;`),
    relations: q(`SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner), coalesce(c.relacl::text,''), coalesce(obj_description(c.oid),'')
                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY 1;`),
    functions: q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' ORDER BY 1, 2;`),
    data: tables.map(
      (t) => `${t}:${sqlOk(url, `SELECT count(*) || ':' || coalesce(md5(string_agg(x::text, ',' ORDER BY x::text)), '') FROM public."${t}" x;`)[0]![0]}`,
    ),
    aiManagerJournal: q(`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id;`),
  }
}

let mod: DbModule
let db: TempDb
let before: Record<string, string[]>

beforeAll(async () => {
  mod = await loadDb()
  db = createTempDb('crm_acc_t01')
  seedAiManager(db.url)
  before = snapshot(db.url)
})

afterAll(() => dropTempDb(db))

describe('migrations crm sobre um banco do ai-manager', () => {
  it('AC-T01-05 pré-condição: banco com as tabelas public.* do ai-manager', () => {
    for (const t of ['sessions', 'session_credentials', 'contacts', 'messages', 'audit_logs', 'webhooks', 'proxies']) {
      expect(before.tables).toContain(t)
    }
  })

  it('AC-T01-05 runMigrations({ set: "crm" }) cria crm.* e não altera nenhuma tabela public', async () => {
    await migrate(mod, db.url, 'crm')
    const tables = tableNames(db.url, 'crm')
    for (const t of BASE_TABLES) expect(tables, `crm.${t} ausente`).toContain(t)
    const after = snapshot(db.url)
    for (const key of Object.keys(before)) expect(after[key], `public alterado (${key})`).toEqual(before[key])
  })

  it('AC-T01-05 reaplicar set "crm" sobre o banco do ai-manager continua sem tocar public', async () => {
    await migrate(mod, db.url, 'crm')
    const after = snapshot(db.url)
    for (const key of Object.keys(before)) expect(after[key], `public alterado (${key})`).toEqual(before[key])
  })
})
