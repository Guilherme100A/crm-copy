// Apoio da T128 (banco-modelo por hash das migrações). Contrato com o Forja (brief, "Entrega do operário"):
// @crm/db/testing: createTempDatabase({ migrate, set }) → { name, url, drop, template?: { name, created } },
//   ensureTemplateDatabase / cloneTemplateDatabase(nome, { baseUrl, set, folders, cache }) → { name, created, cloneMs },
//   dropTemplateDatabases(baseUrl, nomes), templateDatabaseName(set, folders); CRM_TEST_TEMPLATE=0 desliga.
// scripts/e2e/template-db.mjs: currentTemplateNames(), cloneTemplateDatabase (JS puro, usada pelo serve.mjs).
// scripts/e2e/orphans.mjs: cleanupOrphanDatabases({ ..., currentTemplates, match }) → kept[{ reason: 'current' | ... }].
// SEGURANÇA: Postgres compartilhado. Só criamos/apagamos bancos `crm_acc_t128_<tag>_*` e modelos de hash único desta
// execução (pasta `wa` copiada com um comentário de marca no último .sql). O modelo do hash atual nunca é apagado aqui.
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rootPath } from '../helpers/exec'
import { DEFAULT_DATABASE_URL, ident, lit, sql, sqlOk } from '../helpers/pg'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any

export const BASE = DEFAULT_DATABASE_URL
export const TAG = `t128_${process.pid}_${Date.now().toString(36)}`
export const tmp = mkdtempSync(join(tmpdir(), 'crm-t128-'))

export const templateDbMod = async (): Promise<Any> => import(pathToFileURL(rootPath('scripts', 'e2e', 'template-db.mjs')).href)
export const orphansMod = async (): Promise<Any> => import(pathToFileURL(rootPath('scripts', 'e2e', 'orphans.mjs')).href)

let seq = 0
/** Nome de banco descartável desta suíte (prefixo de teste, coberto pela limpeza de órfãos). */
export const accName = (what: string) => `crm_acc_${TAG}_${what}_${(seq++).toString(36)}`

export const dbExists = (name: string) => sqlOk(BASE, `SELECT count(*) FROM pg_database WHERE datname = ${lit(name)};`)[0]?.[0] === '1'

/** { exists, template, allowConn } do pg_database. */
export function dbFlags(name: string) {
  const r = sqlOk(BASE, `SELECT datistemplate, datallowconn FROM pg_database WHERE datname = ${lit(name)};`)[0]
  return r ? { exists: true, template: r[0] === 't', allowConn: r[1] === 't' } : { exists: false, template: false, allowConn: false }
}

export const dropDb = (name: string) => sql(BASE, `DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE);`)

/**
 * Cópia da pasta de migrações `wa` com um comentário único no último `.sql`: hash novo (modelo novo) sem tocar nas
 * migrações reais nem no modelo atual.
 */
export function waFolderCopy(variant: string): string {
  const dst = join(tmp, `wa-${variant}`)
  cpSync(rootPath('packages', 'db', 'drizzle', 'wa'), dst, { recursive: true })
  const last = readdirSync(dst)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .at(-1)!
  const p = join(dst, last)
  writeFileSync(p, `${readFileSync(p, 'utf8')}\n-- AC T128 ${TAG} ${variant}\n`)
  return dst
}

/** Tabelas, colunas e índices de `crm` e `public` (o "schema" do AC-T128-01), ordenados. */
export function schemaSnapshot(url: string) {
  const tables = sqlOk(
    url,
    `SELECT table_schema || '.' || table_name FROM information_schema.tables
      WHERE table_schema IN ('crm','public') AND table_type = 'BASE TABLE' ORDER BY 1;`,
  ).map((r) => r[0])
  const columns = sqlOk(
    url,
    `SELECT table_schema || '.' || table_name || '.' || column_name, data_type, udt_name, is_nullable, coalesce(column_default, '<null>'), ordinal_position::text
       FROM information_schema.columns WHERE table_schema IN ('crm','public') ORDER BY 1;`,
  ).map((r) => r.join(' | '))
  const indexes = sqlOk(url, `SELECT schemaname || '.' || indexname, indexdef FROM pg_indexes WHERE schemaname IN ('crm','public') ORDER BY 1;`).map((r) =>
    r.join(' | '),
  )
  return { tables, columns, indexes }
}

/** Linhas de controle das migrações (drizzle.__drizzle_migrations do `wa` e crm.__drizzle_migrations). */
export function migrationRows(url: string) {
  return sqlOk(
    url,
    `SELECT 'wa', count(*)::text FROM drizzle.__drizzle_migrations UNION ALL SELECT 'crm', count(*)::text FROM crm.__drizzle_migrations;`,
  ).map((r) => r.join('='))
}

export const journalEntries = (set: 'wa' | 'crm') =>
  (JSON.parse(readFileSync(rootPath('packages', 'db', 'drizzle', set, 'meta', '_journal.json'), 'utf8')).entries as unknown[]).length

export const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
