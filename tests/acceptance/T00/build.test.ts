import { describe, expect, it } from 'vitest'
import { exec, fileExists, readText, tail } from '../helpers/exec'

describe('T00 — install e build', () => {
  it('AC-T00-01 pnpm install seguido de pnpm -r build termina com exit 0', () => {
    const install = exec('pnpm install', { timeoutMs: 900_000 })
    expect(install.code, tail(install)).toBe(0)

    const build = exec('pnpm -r build', { timeoutMs: 900_000 })
    expect(build.code, tail(build)).toBe(0)
  }, 1_800_000)

  it('AC-T00-01 o repositório fixa Node 22 (.nvmrc = 22) e o build roda num Node >= 22.12', () => {
    expect(fileExists('.nvmrc'), '.nvmrc não existe').toBe(true)
    expect(readText('.nvmrc').trim().replace(/^v/, '')).toMatch(/^22(\.|$)/)

    const r = exec('node -p process.versions.node')
    expect(r.code, tail(r)).toBe(0)
    const [major, minor] = r.stdout.trim().split('.').map(Number)
    expect(major! > 22 || (major === 22 && minor! >= 12), `node ${r.stdout.trim()} < 22.12`).toBe(true)
  })
})
