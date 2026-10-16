// Fotografia estrutural de `public` via information_schema (AC-T06-01): tabelas, colunas (nome, tipo, nulidade) e enums.
import { sqlOk } from '../helpers/pg'

export interface ColumnShape {
  name: string
  data_type: string
  udt_name: string
  nullable: boolean
}

export interface PublicSchema {
  tables: string[]
  columns: Record<string, ColumnShape[]>
  enums: Record<string, string[]>
}

export function publicSchema(url: string): PublicSchema {
  const tables = sqlOk(
    url,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1;`,
  ).map((r) => r[0]!)
  const columns: Record<string, ColumnShape[]> = {}
  for (const [t, name, data_type, udt_name, nullable] of sqlOk(
    url,
    `SELECT table_name, column_name, data_type, udt_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, column_name;`,
  )) {
    if (!tables.includes(t!)) continue
    ;(columns[t!] ??= []).push({ name: name!, data_type: data_type!, udt_name: udt_name!, nullable: nullable === 'YES' })
  }
  const enums: Record<string, string[]> = {}
  for (const [typ, label] of sqlOk(
    url,
    `SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder;`,
  )) {
    ;(enums[typ!] ??= []).push(label!)
  }
  return { tables, columns, enums }
}
