// AC-T121-02: carrega cada apps/*/vitest.config.ts e packages/*/vitest.config.ts NESTE processo e imprime
// o test.env de fila de cada um (JSON numa linha). Rodar duas vezes deve dar prefixos diferentes (por execução).
// Uso: pnpm exec tsx tests/acceptance/T121/fixtures/print-prefixes.ts
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
const out: Record<string, { CRM_QUEUE_PREFIX?: string; WA_QUEUE_PREFIX?: string; error?: string }> = {}
for (const group of ['apps', 'packages']) {
  for (const name of readdirSync(join(ROOT, group))) {
    const file = join(ROOT, group, name, 'vitest.config.ts')
    if (!existsSync(file)) continue
    try {
      const mod: any = await import(pathToFileURL(file).href)
      let cfg = mod.default
      if (typeof cfg === 'function') cfg = await cfg({ mode: 'test', command: 'serve' })
      const env = cfg?.test?.env ?? {}
      out[`${group}/${name}`] = { CRM_QUEUE_PREFIX: env.CRM_QUEUE_PREFIX, WA_QUEUE_PREFIX: env.WA_QUEUE_PREFIX }
    } catch (e) {
      out[`${group}/${name}`] = { error: String((e as Error).message ?? e).slice(0, 300) }
    }
  }
}
process.stdout.write(`PREFIXES ${JSON.stringify(out)}\n`)
