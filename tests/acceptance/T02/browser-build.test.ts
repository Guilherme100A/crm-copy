import { beforeAll, describe, expect, it } from 'vitest'
import { ensureInstalled, exec, extractJson, tail } from '../helpers/exec'

interface BuildResult {
  ok: boolean
  vite?: string
  nodeImports: string[]
  warnings: string[]
  exports: string[]
  checks: Record<string, unknown>
  error: string | null
}

describe('T02 — @crm/shared isomórfico (bundle Vite para browser)', () => {
  let res: BuildResult

  beforeAll(() => {
    const inst = ensureInstalled()
    if (inst) expect(inst.code, tail(inst)).toBe(0)
    // Processo separado: o Vite do build não se mistura com o do Vitest.
    const r = exec('node tests/acceptance/T02/browser-build.mjs', { timeoutMs: 300_000 })
    expect(r.code, tail(r)).toBe(0)
    res = extractJson<BuildResult>(r.stdout)
  })

  it('AC-T02-06 o bundle Vite de @crm/shared termina sem erro', () => {
    expect(res.error, res.error ?? '').toBeNull()
    expect(res.exports.length, 'o bundle não expõe nenhum export').toBeGreaterThan(0)
  })

  it('AC-T02-06 o grafo de @crm/shared não importa nenhum módulo de Node (sem polyfills)', () => {
    expect(res.nodeImports).toEqual([])
    expect(res.checks.browserExternal, 'bundle contém __vite-browser-external (import de builtin de Node)').toBe(false)
  })

  it('AC-T02-06 o bundle executa num contexto sem process/require/Buffer e as funções funcionam', () => {
    expect(res.checks.noProcess).toBe(true)
    expect(res.exports).toEqual(expect.arrayContaining(['ERROR_CODES', 'httpStatusOf', 'can', 'normalizePermissions', 'parsePhone', 'toE164']))
    expect(res.checks.httpStatusOf).toBe(404)
    expect(res.checks.parsePhone).toBe('+5511999998888')
    expect(res.checks.canOwner).toBe(true)
  })
})
