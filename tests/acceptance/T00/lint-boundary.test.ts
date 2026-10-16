import { randomBytes } from 'node:crypto'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ensureInstalled, exec, rootPath, tail } from '../helpers/exec'
import { FORBIDDEN_IN_CORE } from './contract'

const LINT = 'pnpm --filter @crm/core lint'

// O AC exige um arquivo em packages/core/src: o teste cria uma sonda temporária e a remove ao final.
const probes: string[] = []
function writeProbe(source: string): string {
  const name = `t00-probe-${randomBytes(4).toString('hex')}.ts`
  const abs = rootPath('packages', 'core', 'src', name)
  writeFileSync(abs, source)
  probes.push(abs)
  return name
}

describe('T00 — ESLint no-restricted-imports em @crm/core', () => {
  beforeAll(() => {
    const r = ensureInstalled()
    if (r) expect(r.code, tail(r)).toBe(0)
  }, 900_000)

  afterEach(() => {
    for (const p of probes.splice(0)) if (existsSync(p)) rmSync(p, { force: true })
  })

  it('AC-T00-04 controle: pnpm --filter @crm/core lint passa sem import proibido', () => {
    const r = exec(LINT)
    expect(r.code, tail(r)).toBe(0)
  })

  it('AC-T00-04 controle: arquivo em packages/core/src com import permitido não quebra o lint', () => {
    writeProbe(`import { join } from 'node:path'\n\nexport const probe = join('a', 'b')\n`)
    const r = exec(LINT)
    expect(r.code, tail(r)).toBe(0)
  })

  for (const mod of FORBIDDEN_IN_CORE) {
    it(`AC-T00-04 import de "${mod}" em packages/core/src faz o lint falhar com no-restricted-imports`, () => {
      const name = writeProbe(`import * as forbidden from '${mod}'\n\nexport const probe = forbidden\n`)
      const r = exec(LINT)
      expect(r.code, `lint deveria falhar com import de ${mod}\n${tail(r)}`).not.toBe(0)
      expect(r.output, tail(r, 60)).toContain(name)
      expect(r.output, tail(r, 60)).toMatch(/no-restricted-imports/)
    })
  }
})
