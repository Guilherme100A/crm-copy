import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATION_SETS } from './client.js'
import { CRM_BASE_TABLES, createDb, runMigrations } from './index.js'
import { createTempDatabase, type TempDatabase } from './testing.js'

const crmJournalEntries = () =>
  (JSON.parse(readFileSync(join(MIGRATION_SETS.crm.folder, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }).entries.length

// Postgres real (SPEC 3.10): DATABASE_URL aponta para um banco existente no servidor de testes.

async function query<T extends pg.QueryResultRow>(url: string, text: string, values: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    return (await c.query<T>(text, values)).rows
  } finally {
    await c.end()
  }
}

const tablesIn = async (url: string, schema: string) =>
  (
    await query<{ table_name: string }>(
      url,
      `select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by 1`,
      [schema],
    )
  ).map((r) => r.table_name)

// Retrato do schema public: colunas, constraints e índices.
const publicSnapshot = (url: string) =>
  query(
    url,
    `select 'col' k, table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') v
       from information_schema.columns where table_schema = 'public'
     union all select 'con', conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
       from pg_constraint where connamespace = 'public'::regnamespace
     union all select 'idx', indexdef from pg_indexes where schemaname = 'public'
     order by 1, 2`,
  )

describe('runMigrations (Postgres real)', () => {
  const temps: TempDatabase[] = []
  const temp = async (migrate = false) => {
    const t = await createTempDatabase({ migrate })
    temps.push(t)
    return t
  }

  afterAll(async () => {
    for (const t of temps) await t.drop()
  })

  it("set 'crm' cria as 8 tabelas e grava o controle em crm.__drizzle_migrations", async () => {
    const t = await temp()
    const db = createDb(t.url, { max: 2 })
    try {
      await runMigrations(db, { set: 'crm' })
    } finally {
      await db.$client.end()
    }
    const tables = await tablesIn(t.url, 'crm')
    // Outras tarefas acrescentam tabelas ao crm (SPEC 2.4): a base e o controle precisam estar presentes.
    expect(tables).toEqual(expect.arrayContaining([...CRM_BASE_TABLES, '__drizzle_migrations']))
    expect(await tablesIn(t.url, 'public')).toEqual([])
    const [ctl] = await query<{ n: string }>(t.url, `select count(*) n from crm.__drizzle_migrations`)
    expect(Number(ctl?.n)).toBeGreaterThan(0)
    const drizzleSchema = await query(t.url, `select 1 from information_schema.schemata where schema_name = 'drizzle'`)
    expect(drizzleSchema).toEqual([])
  })

  it("set 'all' duas vezes e duas chamadas concorrentes não falham", async () => {
    const t = await temp()
    await runMigrations(t.url, { set: 'all' })
    await runMigrations({ url: t.url, set: 'all' })
    await Promise.all([runMigrations(t.url, { set: 'all' }), runMigrations(t.url, { set: 'all' })])
    const [ctl] = await query<{ n: string }>(t.url, `select count(*) n from crm.__drizzle_migrations`)
    // Idempotência: cada migration do journal aplicada exatamente uma vez, apesar das 4 execuções.
    expect(Number(ctl?.n)).toBeGreaterThanOrEqual(1)
    expect(Number(ctl?.n)).toBe(crmJournalEntries())
  })

  it('concorrência num banco vazio: só uma aplica, a outra espera o lock', async () => {
    const t = await temp()
    await Promise.all([runMigrations(t.url, { set: 'all' }), runMigrations(t.url, { set: 'all' }), runMigrations(t.url)])
    expect(await tablesIn(t.url, 'crm')).toContain('companies')
  })

  describe('restrições', () => {
    let t: TempDatabase
    beforeAll(async () => {
      t = await temp(true)
    })

    it('users.email é único sem diferenciar maiúsculas', async () => {
      await query(t.url, `insert into crm.users (email, password_hash, name) values ('Ana@Ex.com', 'h', 'Ana')`)
      await expect(
        query(t.url, `insert into crm.users (email, password_hash, name) values ('ana@ex.COM', 'h', 'Ana 2')`),
      ).rejects.toMatchObject({ code: '23505' })
    })

    it('um owner por empresa e um vínculo por (empresa, usuário)', async () => {
      const [c] = await query<{ id: string }>(t.url, `insert into crm.companies (name, slug) values ('A', 'a') returning id`)
      const users = await query<{ id: string }>(
        t.url,
        `insert into crm.users (email, password_hash, name) values ('u1@x', 'h', 'u1'), ('u2@x', 'h', 'u2') returning id`,
      )
      const [u1, u2] = users.map((u) => u.id)
      await query(t.url, `insert into crm.company_members (company_id, user_id, role) values ($1, $2, 'owner')`, [c!.id, u1])
      await expect(
        query(t.url, `insert into crm.company_members (company_id, user_id, role) values ($1, $2, 'owner')`, [c!.id, u2]),
      ).rejects.toMatchObject({ code: '23505' })
      await query(t.url, `insert into crm.company_members (company_id, user_id, role) values ($1, $2, 'admin')`, [c!.id, u2])
      await expect(
        query(t.url, `insert into crm.company_members (company_id, user_id, role) values ($1, $2, 'member')`, [c!.id, u1]),
      ).rejects.toMatchObject({ code: '23505' })
    })

    it('defaults de companies e users', async () => {
      const [c] = await query<{ time_zone: string; active: boolean; settings: unknown }>(
        t.url,
        `insert into crm.companies (name, slug) values ('B', 'b') returning time_zone, active, settings`,
      )
      expect(c).toEqual({ time_zone: 'America/Sao_Paulo', active: true, settings: {} })
      const [u] = await query<{ system_role: string; locale: string }>(
        t.url,
        `insert into crm.users (email, password_hash, name) values ('d@x', 'h', 'd') returning system_role, locale`,
      )
      expect(u).toEqual({ system_role: 'user', locale: 'pt-BR' })
    })
  })

  it('createTempDatabase({ migrate: true }) devolve banco migrado e drop() remove com conexões abertas', async () => {
    const t = await createTempDatabase({ migrate: true })
    const db = createDb(t.url, { max: 1 })
    // O DROP ... WITH (FORCE) derruba as conexões abertas: o Pool emite 'error' no cliente ocioso.
    db.$client.on('error', () => undefined)
    const held = new pg.Client({ connectionString: t.url })
    await held.connect()
    held.on('error', () => undefined)
    try {
      expect(await tablesIn(t.url, 'crm')).toContain('users')
      await db.$client.query('select 1')
      await t.drop()
      const base = process.env.DATABASE_URL ?? 'postgres://wsm:wsm@127.0.0.1:5432/crm'
      expect(await query(base, `select 1 from pg_database where datname = $1`, [t.name])).toEqual([])
      await t.drop()
    } finally {
      await held.end().catch(() => undefined)
      await db.$client.end().catch(() => undefined)
    }
  })

  it('migrations crm não alteram tabelas public pré-existentes (banco do ai-manager)', async () => {
    const t = await temp()
    // Recorte do schema public do ai-manager (inclui um audit_logs homônimo).
    await query(
      t.url,
      `create type session_status as enum ('NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED');
       create table sessions (id uuid primary key default gen_random_uuid(), name text not null, status session_status not null default 'NEW');
       create table contacts (id uuid primary key default gen_random_uuid(), phone text not null unique, opt_out boolean not null default false);
       create table audit_logs (id bigserial primary key, action text not null, created_at timestamptz not null default now());
       create index audit_logs_created_idx on audit_logs (created_at);
       insert into contacts (phone) values ('+5511999999999');`,
    )
    const before = await publicSnapshot(t.url)
    await runMigrations(t.url, { set: 'crm' })
    expect(await publicSnapshot(t.url)).toEqual(before)
    expect(await tablesIn(t.url, 'public')).toEqual(['audit_logs', 'contacts', 'sessions'])
    expect(await query(t.url, `select phone from public.contacts`)).toEqual([{ phone: '+5511999999999' }])
    // Aplica todas as migrations crm (cada tarefa acrescenta uma): sob carga passava do timeout padrão de 5 s (T24).
  }, 30_000)
})
