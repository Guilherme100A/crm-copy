// Regenera a fixture `ai-manager-public.json` aplicando as migrations ORIGINAIS do ai-manager num banco descartável.
// Uso: pnpm --filter @crm/db exec tsx src/schema/wa/fixtures/generate.ts <ai-manager>/packages/db/drizzle
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { migrateUrl } from '../../../client.js'
import { createTempDatabase } from '../../../testing.js'
import { snapshotPublicSchema } from '../introspect.js'

const folder = process.argv[2]
if (!folder) throw new Error('informe a pasta drizzle/ do ai-manager')
const temp = await createTempDatabase({ prefix: 'crm_fixture' })
try {
  await migrateUrl(temp.url, { set: 'wa', folders: { wa: folder } })
  const snapshot = await snapshotPublicSchema(temp.url)
  writeFileSync(fileURLToPath(new URL('./ai-manager-public.json', import.meta.url)), `${JSON.stringify(snapshot, null, 2)}\n`)
  process.stdout.write(`fixture: ${snapshot.tables.length} tabelas, ${snapshot.columns.length} colunas\n`)
} finally {
  await temp.drop()
}
