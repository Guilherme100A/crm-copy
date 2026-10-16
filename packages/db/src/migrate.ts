// CLI: `pnpm --filter @crm/db migrate [-- --set wa|crm|all]` (usa DATABASE_URL; padrão `all`).
import { DEFAULT_DATABASE_URL, migrateUrl, type MigrationSetOption } from './client.js'

const SETS: readonly MigrationSetOption[] = ['wa', 'crm', 'all']

function parseSet(argv: string[]): MigrationSetOption {
  const i = argv.indexOf('--set')
  const raw = i >= 0 ? argv[i + 1] : (argv.find((a) => a.startsWith('--set='))?.slice(6) ?? 'all')
  if (!SETS.includes(raw as MigrationSetOption)) throw new Error(`--set inválido: ${raw} (use wa, crm ou all)`)
  return raw as MigrationSetOption
}

try {
  const set = parseSet(process.argv.slice(2))
  await migrateUrl(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, { set })
  process.stdout.write(`migrations aplicadas (${set})\n`)
} catch (err) {
  process.stderr.write(`falha nas migrations: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
}
