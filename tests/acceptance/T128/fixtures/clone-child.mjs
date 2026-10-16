// Processo filho do AC-T128-02: carrega @crm/db/testing (packages/db/src/testing.ts) pelo tsx, avisa READY, espera o
// arquivo de largada e chama cloneTemplateDatabase(<clone>, { baseUrl, set: 'wa', folders: { wa } }). Imprime RESULT=<json>.
// Uso: node clone-child.mjs <root> <baseUrl> <pastaWa> <nomeDoClone> <arquivoDeLargada>
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, baseUrl, waFolder, cloneName, goFile] = process.argv.slice(2)
const { tsImport } = await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('tsx/esm/api')).href)
const mod = await tsImport(pathToFileURL(join(root, 'packages', 'db', 'src', 'testing.ts')).href, import.meta.url)
process.stdout.write('READY\n')
while (!existsSync(goFile)) await new Promise((r) => setTimeout(r, 20))
try {
  const r = await mod.cloneTemplateDatabase(cloneName, { baseUrl, set: 'wa', folders: { wa: waFolder } })
  process.stdout.write(`RESULT=${JSON.stringify({ ok: true, ...r })}\n`)
  process.exit(0)
} catch (err) {
  process.stdout.write(`RESULT=${JSON.stringify({ ok: false, code: err?.code ?? null, message: String(err?.message ?? err) })}\n`)
  process.exit(1)
}
