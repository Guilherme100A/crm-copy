// Retrato do schema `public` (tabelas, colunas, enums, constraints e índices) via information_schema/pg_catalog.
// Usado para provar que as migrations `wa` produzem exatamente o schema do ai-manager (AC-T06-01).
import pg from 'pg'

export interface PublicSchemaSnapshot {
  tables: string[]
  columns: { table: string; column: string; type: string; nullable: boolean; default: string | null }[]
  enums: { name: string; values: string[] }[]
  constraints: { table: string; name: string; definition: string }[]
  indexes: { table: string; name: string; definition: string }[]
}

export async function snapshotPublicSchema(url: string): Promise<PublicSchemaSnapshot> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const q = async <T extends pg.QueryResultRow>(text: string) => (await client.query<T>(text)).rows
    const tables = await q<{ t: string }>(
      `select table_name t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    )
    const columns = await q<{ table: string; column: string; type: string; nullable: string; default: string | null }>(
      `select table_name "table", column_name "column",
              case when data_type = 'USER-DEFINED' then udt_name when data_type = 'ARRAY' then udt_name else data_type end "type",
              is_nullable nullable, column_default "default"
         from information_schema.columns where table_schema = 'public' order by 1, 2`,
    )
    const enums = await q<{ name: string; values: string[] }>(
      `select t.typname "name", array_agg(e.enumlabel order by e.enumsortorder)::text[] "values"
         from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' group by t.typname order by 1`,
    )
    const constraints = await q<{ table: string; name: string; definition: string }>(
      `select conrelid::regclass::text "table", conname "name", pg_get_constraintdef(oid) "definition"
         from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`,
    )
    const indexes = await q<{ table: string; name: string; definition: string }>(
      `select tablename "table", indexname "name", indexdef "definition" from pg_indexes where schemaname = 'public' order by 1, 2`,
    )
    return {
      tables: tables.map((r) => r.t),
      columns: columns.map((c) => ({ ...c, nullable: c.nullable === 'YES' })),
      enums,
      constraints,
      indexes,
    }
  } finally {
    await client.end()
  }
}
