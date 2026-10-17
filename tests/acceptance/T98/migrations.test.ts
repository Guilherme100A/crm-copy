// AC-T98-03: as migrations `crm` aplicadas num banco com o schema do ai-manager (fixture de `public.*` entregue em
// packages/wa-gateway-rpc/src/profiles/ai-manager/fixtures/public) não alteram as tabelas `public` — estrutura,
// dados e o controle de migrations do ai-manager (drizzle.__drizzle_migrations).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTempDb, dropTempDb, sqlOk, tableNames, type TempDb } from '../helpers'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const FIXTURE = join(ROOT, 'packages/wa-gateway-rpc/src/profiles/ai-manager/fixtures/public')
// Cópia independente das migrations do ai-manager mantida pelos testers (T01).
const REFERENCE = join(ROOT, 'tests/acceptance/T01/fixtures/ai-manager-public')

function snapshot(url: string): Record<string, string[]> {
  const q = (s: string) => sqlOk(url, s).map((r) => r.join('|'))
  const tables = tableNames(url, 'public')
  return {
    tables,
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
    data: tables.map((t) => `${t}:${sqlOk(url, `SELECT count(*) || ':' || coalesce(md5(string_agg(x::text, ',' ORDER BY x::text)), '') FROM public."${t}" x;`)[0]![0]}`),
    aiManagerJournal: q(`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id;`),
  }
}

async function withDb<T>(url: string, fn: (db: any, mod: any) => Promise<T>): Promise<T> {
  const mod: any = await import('@crm/db')
  const db = mod.createDb(url, { max: 2 })
  try {
    return await fn(db, mod)
  } finally {
    await db.$client.end().catch(() => {})
  }
}

let tmp: TempDb
let before: Record<string, string[]>

beforeAll(async () => {
  tmp = createTempDb('crm_acc_t98')
  // Schema do ai-manager como ele mesmo aplica: drizzle migrator com a tabela padrão (drizzle.__drizzle_migrations).
  await withDb(tmp.url, (db, mod) => mod.runMigrations(db, { set: 'wa', folders: { wa: FIXTURE } }))
  sqlOk(
    tmp.url,
    `INSERT INTO public.contacts (name, phone, consent, consent_source) VALUES ('Contato fixture T98', '+5599900000098', true, 'manual');
     INSERT INTO public.sessions (name) VALUES ('Sessão do ai-manager');`,
  )
  before = snapshot(tmp.url)
}, 180_000)

afterAll(() => dropTempDb(tmp), 120_000)

describe('AC-T98-03 migrations crm sobre o banco do ai-manager', () => {
  it('AC-T98-03 a fixture de public.* é o schema do ai-manager (mesmas 8 migrations da cópia de referência)', () => {
    const norm = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
    const ref = readdirSync(REFERENCE).filter((f) => f.endsWith('.sql')).sort()
    const mine = readdirSync(FIXTURE).filter((f) => f.endsWith('.sql')).sort()
    expect(mine).toEqual(ref)
    expect(mine).toHaveLength(8)
    for (const f of ref) expect(norm(join(FIXTURE, f)), f).toBe(norm(join(REFERENCE, f)))
    for (const t of ['sessions', 'session_credentials', 'contacts', 'messages', 'proxies', 'session_limits']) expect(before.tables).toContain(t)
    expect(before.aiManagerJournal).toHaveLength(8)
    expect(tableNames(tmp.url, 'crm')).toEqual([])
  })

  it('AC-T98-03 runMigrations({ set: "crm" }) cria crm.* e não altera nada em public nem o controle do ai-manager', async () => {
    await withDb(tmp.url, (db, mod) => mod.runMigrations(db, { set: 'crm' }))
    expect(tableNames(tmp.url, 'crm')).toEqual(expect.arrayContaining(['companies', 'users']))
    const after = snapshot(tmp.url)
    for (const key of Object.keys(before)) expect(after[key], `public alterado (${key})`).toEqual(before[key])
  })

  it('AC-T98-03 reaplicar "crm" continua sem tocar public', async () => {
    await withDb(tmp.url, (db, mod) => mod.runMigrations(db, { set: 'crm' }))
    const after = snapshot(tmp.url)
    for (const key of Object.keys(before)) expect(after[key], `public alterado (${key})`).toEqual(before[key])
  })

  it('AC-T98-03 controle: o snapshot detecta uma mudança em public', () => {
    sqlOk(tmp.url, `ALTER TABLE public.contacts ADD COLUMN t98_probe text;`)
    try {
      expect(snapshot(tmp.url).columns).not.toEqual(before.columns)
    } finally {
      sqlOk(tmp.url, `ALTER TABLE public.contacts DROP COLUMN t98_probe;`)
    }
  })
})
