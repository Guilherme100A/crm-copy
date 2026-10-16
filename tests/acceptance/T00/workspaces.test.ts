import { beforeAll, describe, expect, it } from 'vitest'
import { ensureInstalled, exec, extractJson, fileExists, readJson, rootPath, tail } from '../helpers/exec'
import { REQUIRED_SCRIPTS, WORKSPACES } from './contract'

const norm = (p: string) => p.split('\\').join('/').replace(/\/$/, '').toLowerCase()

describe('T00 — workspaces', () => {
  beforeAll(() => {
    const r = ensureInstalled()
    if (r) expect(r.code, tail(r)).toBe(0)
  }, 900_000)

  it('AC-T00-02 pnpm reconhece os 12 workspaces @crm/* nos diretórios da SPEC 3.1', () => {
    const r = exec('pnpm -r ls --depth -1 --json')
    expect(r.code, tail(r)).toBe(0)
    const pkgs = extractJson<Array<{ name?: string; path: string }>>(r.stdout)
    for (const ws of WORKSPACES) {
      const found = pkgs.find((p) => p.name === ws.name)
      expect(found, `workspace ${ws.name} não listado por pnpm -r ls`).toBeTruthy()
      expect(norm(found!.path)).toBe(norm(rootPath(ws.dir)))
    }
  })

  it('AC-T00-02 nenhum workspace fora do escopo @crm/* (nomes neutros)', () => {
    const r = exec('pnpm -r ls --depth -1 --json')
    expect(r.code, tail(r)).toBe(0)
    const pkgs = extractJson<Array<{ name?: string; path: string }>>(r.stdout)
    const others = pkgs.filter((p) => norm(p.path) !== norm(rootPath()) && !p.name?.startsWith('@crm/'))
    expect(others.map((p) => `${p.name} (${p.path})`)).toEqual([])
  })

  for (const ws of WORKSPACES) {
    it(`AC-T00-02 ${ws.dir}/package.json se chama ${ws.name} e tem scripts ${REQUIRED_SCRIPTS.join('/')}`, () => {
      const file = `${ws.dir}/package.json`
      expect(fileExists(file), `${file} não existe`).toBe(true)
      const pkg = readJson<{ name?: string; scripts?: Record<string, string> }>(file)
      expect(pkg.name).toBe(ws.name)
      for (const s of REQUIRED_SCRIPTS) {
        expect(typeof pkg.scripts?.[s], `${file} sem script "${s}"`).toBe('string')
        expect(pkg.scripts![s]!.trim().length, `${file} script "${s}" vazio`).toBeGreaterThan(0)
      }
    })
  }
})
