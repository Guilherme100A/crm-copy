// Gera ai-manager-public.json: aplica as migrations 0000..0007 do ai-manager (somente leitura) num banco
// descartável e extrai de information_schema/pg_enum as tabelas, colunas (nome, tipo, nulidade) e enums de `public`.
// Uso (raiz do repo): pnpm exec tsx tests/acceptance/T06/fixtures/extract-ai-manager-schema.ts [<dir das migrations>]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTempDb, dropTempDb, sqlOk } from '../../helpers/pg'
import { publicSchema } from '../schema-snapshot'

const dir = process.argv[2] ?? 'C:/Users/green/Downloads/leonas/ai-manager/packages/db/drizzle'
const files = readdirSync(dir).filter((f) => /^000[0-7]_.*\.sql$/.test(f)).sort()
const db = createTempDb('crm_fix_t06')
try {
  for (const f of files) sqlOk(db.url, readFileSync(join(dir, f), 'utf8').replace(/--> statement-breakpoint/g, ''))
  const out = { source: `ai-manager packages/db/drizzle ${files.join(', ')}`, ...publicSchema(db.url) }
  writeFileSync(fileURLToPath(new URL('./ai-manager-public.json', import.meta.url)), `${JSON.stringify(out, null, 2)}\n`)
  process.stdout.write(`ok: ${out.tables.length} tabelas, ${Object.keys(out.enums).length} enums\n`)
} finally {
  dropTempDb(db)
}
