#!/usr/bin/env node
// i18n:check (SPEC 3.11, T23): toda chave de `pt-BR/<módulo>.json` precisa existir em `en/` e `es/`.
// Uso: node scripts/i18n-check.mjs [--dir <diretório com pt-BR/, en/, es/>]   (padrão: src/i18n)
// Sai com 1 e lista `<língua>/<módulo>.json: <chave>` para cada chave faltante (ou arquivo ausente/JSON inválido).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REFERENCE = 'pt-BR'
export const LANGUAGES = ['en', 'es']

/** Chaves folha em dot-path (`a.b.c`). */
export function flattenKeys(obj, prefix = '') {
  const out = []
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flattenKeys(v, key))
    else out.push(key)
  }
  return out
}

function readJson(file, problems, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    problems.push(`${label}: JSON inválido (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}

/** Devolve a lista de problemas (vazia = ok). */
export function checkI18n(dir) {
  const problems = []
  const refDir = join(dir, REFERENCE)
  if (!existsSync(refDir)) return [`${REFERENCE}/: diretório de referência ausente em ${dir}`]
  const modules = readdirSync(refDir).filter((f) => f.endsWith('.json')).sort()
  for (const file of modules) {
    const ref = readJson(join(refDir, file), problems, `${REFERENCE}/${file}`)
    if (!ref) continue
    const keys = flattenKeys(ref)
    for (const lang of LANGUAGES) {
      const path = join(dir, lang, file)
      const label = `${lang}/${file}`
      if (!existsSync(path)) {
        problems.push(`${label}: arquivo ausente (${keys.length} chaves)`)
        continue
      }
      const data = readJson(path, problems, label)
      if (!data) continue
      const have = new Set(flattenKeys(data))
      for (const key of keys) if (!have.has(key)) problems.push(`${label}: ${key}`)
    }
  }
  return problems
}

function main(argv) {
  const at = argv.indexOf('--dir')
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = at >= 0 && argv[at + 1] ? resolve(argv[at + 1]) : join(here, '..', 'src', 'i18n')
  const problems = checkI18n(dir)
  if (problems.length) {
    process.stderr.write(`i18n:check falhou: ${problems.length} problema(s) em ${dir}\n${problems.map((p) => `  - ${p}`).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(`i18n:check ok (${dir})\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
