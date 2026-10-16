import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ROOT, ensureInstalled, exec, extractJson, parseJsonc, readJson, rootPath, tail } from '../helpers/exec'
import { WORKSPACES } from './contract'

interface TsConfig {
  extends?: string | string[]
  compilerOptions?: { strict?: boolean }
}

const readTsconfig = (abs: string) => parseJsonc<TsConfig>(readFileSync(abs, 'utf8'))
const BASE = rootPath('tsconfig.base.json')

function resolveExtends(from: string, ext: string): string | null {
  if (!ext.startsWith('.') && !ext.startsWith('/')) return null // pacote npm: fora do contrato
  const abs = resolve(dirname(from), ext)
  if (existsSync(abs)) return abs
  if (existsSync(`${abs}.json`)) return `${abs}.json`
  return null
}

/** Cadeia de `extends` (arquivos locais), começando pelo próprio tsconfig. */
function extendsChain(abs: string, seen = new Set<string>()): string[] {
  if (seen.has(abs)) return []
  seen.add(abs)
  const cfg = readTsconfig(abs)
  const exts = cfg.extends === undefined ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends]
  const chain = [abs]
  for (const e of exts) {
    const next = resolveExtends(abs, e)
    if (next) chain.push(...extendsChain(next, seen))
  }
  return chain
}

const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

describe('T00 — tsconfig base strict e engines', () => {
  beforeAll(() => {
    const r = ensureInstalled()
    if (r) expect(r.code, tail(r)).toBe(0)
  }, 900_000)

  it('AC-T00-03 tsconfig.base.json existe na raiz com compilerOptions.strict = true', () => {
    expect(existsSync(BASE), 'tsconfig.base.json não existe na raiz').toBe(true)
    expect(readTsconfig(BASE).compilerOptions?.strict).toBe(true)
  })

  it('AC-T00-03 package.json da raiz declara engines.node >=22.12', () => {
    const pkg = readJson<{ engines?: { node?: string } }>('package.json')
    const range = (pkg.engines?.node ?? '').replace(/\s+/g, '')
    expect(range, `engines.node = "${pkg.engines?.node}"`).toMatch(/^>=22\.12(\.0)?$/)
  })

  for (const ws of WORKSPACES) {
    it(`AC-T00-03 ${ws.dir}/tsconfig.json herda tsconfig.base.json sem desligar strict`, () => {
      const tsconfig = rootPath(ws.dir, 'tsconfig.json')
      expect(existsSync(tsconfig), `${ws.dir}/tsconfig.json não existe`).toBe(true)
      const chain = extendsChain(tsconfig)
      const idx = chain.findIndex((f) => same(f, BASE))
      expect(idx, `${ws.dir}/tsconfig.json não herda tsconfig.base.json (cadeia: ${chain.map((f) => relative(ROOT, f)).join(' → ')})`).toBeGreaterThan(0)
      for (const f of chain.slice(0, idx)) {
        expect(readTsconfig(f).compilerOptions?.strict, `${relative(ROOT, f)} sobrescreve strict`).not.toBe(false)
      }
    })

    it(`AC-T00-03 config efetiva de ${ws.dir} (tsc --showConfig) tem strict: true`, () => {
      let r = exec(`pnpm exec tsc --showConfig -p "${ws.dir}/tsconfig.json"`)
      if (r.code !== 0) r = exec('pnpm exec tsc --showConfig -p tsconfig.json', { cwd: rootPath(ws.dir) })
      expect(r.code, tail(r)).toBe(0)
      expect(extractJson<TsConfig>(r.stdout).compilerOptions?.strict).toBe(true)
    })
  }
})
