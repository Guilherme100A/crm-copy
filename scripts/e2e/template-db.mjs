#!/usr/bin/env node
// Banco-modelo das migrações para o harness E2E e a limpeza de órfãos (T128). A criação do modelo (lock, migração) é
// a de `packages/db/src/testing/template.ts`, carregada com o tsx só quando o modelo falta. Em JS puro aqui: o hash
// (a limpeza de órfãos sabe, sem tsx, quais modelos são os atuais; as duas cópias são comparadas em
// packages/db/src/testing/template.unit.test.ts) e o clone de um modelo que já existe. Regras em docs/testing.md.
//
// CLI: `node scripts/e2e/template-db.mjs` lista os modelos atuais (nome e se existem);
//      `--rebuild` remove os modelos do hash atual e recria o do conjunto `all` (força a recriação);
//      `--drop` só remove os do hash atual. DATABASE_URL = servidor (padrão 127.0.0.1:5432).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const requireFromDb = createRequire(join(ROOT, 'packages', 'db', 'package.json'))

export const TEMPLATE_PREFIX = 'crm_tpl_'
export const TEMPLATE_SETS = ['all', 'wa', 'crm']
// Mesma ordem de `migrationSets` (packages/db/src/client.ts): `crm` pode referenciar `public.*`, nunca o contrário.
const ORDER = ['wa', 'crm']

const normalize = (text) => text.replace(/\r\n/g, '\n')

/** Pastas de migração do checkout `root`. */
export function migrationFolders(root = ROOT) {
  return { wa: join(root, 'packages', 'db', 'drizzle', 'wa'), crm: join(root, 'packages', 'db', 'drizzle', 'crm') }
}

/** Igual a `migrationsHash` de template.ts: journal + `.sql` (nome e conteúdo) de cada pasta do conjunto. */
export function migrationsHash(set = 'all', folders = migrationFolders()) {
  const h = createHash('sha256')
  for (const s of set === 'all' ? ORDER : [set]) {
    const folder = folders[s]
    h.update(`set:${s}\n`)
    const journal = join(folder, 'meta', '_journal.json')
    h.update(existsSync(journal) ? normalize(readFileSync(journal, 'utf8')) : '<sem journal>')
    h.update('\n')
    const files = existsSync(folder)
      ? readdirSync(folder)
          .filter((f) => f.endsWith('.sql'))
          .sort()
      : []
    for (const f of files) h.update(`file:${f}\n${normalize(readFileSync(join(folder, f), 'utf8'))}\n`)
  }
  return h.digest('hex')
}

export function templateDatabaseName(set = 'all', folders = migrationFolders()) {
  return `${TEMPLATE_PREFIX}${set}_${migrationsHash(set, folders).slice(0, 12)}`
}

/** Nomes dos modelos do hash atual deste checkout (um por conjunto): a limpeza de órfãos nunca os remove. */
export function currentTemplateNames(root = ROOT) {
  const folders = migrationFolders(root)
  return TEMPLATE_SETS.map((s) => templateDatabaseName(s, folders))
}

let templateModule
/** template.ts via tsx (carregado uma vez, só quando alguém clona). */
async function loadTemplateModule() {
  if (!templateModule) {
    const { tsImport } = await import(
      pathToFileURL(createRequire(join(ROOT, 'package.json')).resolve('tsx/esm/api')).href
    )
    templateModule = await tsImport(
      pathToFileURL(join(ROOT, 'packages', 'db', 'src', 'testing', 'template.ts')).href,
      import.meta.url,
    )
  }
  return templateModule
}

const quoteIdent = (n) => `"${n.replace(/"/g, '""')}"`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Cria `name` clonado do modelo do conjunto. Devolve `{ name: <modelo>, created, cloneMs }`.
 * Caminho rápido em JS puro quando o modelo já existe (carregar template.ts pelo tsx custa ~1 s): clone com nova
 * tentativa em 55006 até `retryMs`. Modelo ausente ou sumido no meio (3D000) → template.ts cria/migra e clona.
 */
export async function cloneTemplateDatabase(name, { baseUrl, set = 'all', retryMs = 15_000 } = {}) {
  if (!baseUrl) throw new Error('baseUrl obrigatório')
  const tpl = templateDatabaseName(set)
  const u = new URL(baseUrl)
  u.pathname = '/postgres'
  const pg = requireFromDb('pg')
  const c = new pg.Client({ connectionString: u.toString() })
  await c.connect()
  try {
    const { rows } = await c.query('select datistemplate from pg_database where datname = $1', [tpl])
    if (rows[0]?.datistemplate) {
      const deadline = Date.now() + retryMs
      let wait = 50
      for (;;) {
        const t0 = Date.now()
        try {
          await c.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(tpl)}`)
          return { name: tpl, created: false, cloneMs: Date.now() - t0 }
        } catch (err) {
          if (err.code === '3D000') break
          if (err.code !== '55006' || Date.now() > deadline) throw err
          await sleep(wait)
          wait = Math.min(wait * 2, 500)
        }
      }
    }
  } finally {
    await c.end()
  }
  const mod = await loadTemplateModule()
  return mod.cloneTemplateDatabase(name, { baseUrl, set, retryMs })
}

/** Remove os modelos (padrão: os do hash atual) — a próxima chamada recria. */
export async function dropTemplateDatabases(baseUrl, names = currentTemplateNames()) {
  const mod = await loadTemplateModule()
  return mod.dropTemplateDatabases(baseUrl, names)
}

async function existing(baseUrl, names) {
  const pg = requireFromDb('pg')
  const c = new pg.Client({ connectionString: baseUrl })
  await c.connect()
  try {
    const { rows } = await c.query('select datname from pg_database where datname = any($1)', [names])
    return new Set(rows.map((r) => r.datname))
  } finally {
    await c.end()
  }
}

async function cli(argv) {
  const baseUrl = process.env.DATABASE_URL || 'postgres://wsm:wsm@127.0.0.1:5432/crm'
  const names = currentTemplateNames()
  if (argv.includes('--drop') || argv.includes('--rebuild')) {
    const dropped = await dropTemplateDatabases(baseUrl, names)
    process.stdout.write(`removidos: ${dropped.join(', ') || '(nenhum)'}\n`)
  }
  if (argv.includes('--rebuild')) {
    const mod = await loadTemplateModule()
    const t0 = Date.now()
    const r = await mod.ensureTemplateDatabase({ baseUrl, set: 'all' })
    process.stdout.write(`recriado: ${r.name} (${Date.now() - t0} ms)\n`)
  }
  const have = await existing(baseUrl, names)
  for (const n of names) process.stdout.write(`${n}\t${have.has(n) ? 'existe' : 'ausente'}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`${err.message}\n`)
      process.exit(1)
    },
  )
}
