import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as port from '@crm/wa-port'
import { pkgJson, pkgSrcDir } from './support'

const FLAGS = ['nativeButtons', 'nativeCarousel', 'calls', 'labelsSync', 'businessProfile']

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

describe('T03 — capacidades e dependências', () => {
  it('AC-T03-05 defaultCapabilities() devolve todas as flags false', () => {
    const fn = (port as any).defaultCapabilities
    expect(typeof fn).toBe('function')
    const caps = fn()
    for (const f of FLAGS) expect(caps[f], `flag ${f}`).toBe(false)
    for (const [k, v] of Object.entries(caps)) expect(v, `flag ${k}`).toBe(false)
    // cada chamada é independente (alterar uma cópia não contamina o padrão)
    caps.calls = true
    expect(fn().calls).toBe(false)
  })

  it('AC-T03-05 package.json não declara dependência além de zod', () => {
    const pkg = pkgJson()
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod'])
    expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([])
    const peers = Object.keys(pkg.peerDependencies ?? {}).filter((d) => d !== 'zod' && d !== 'vitest')
    expect(peers, 'peerDependencies além de zod (vitest só para a suíte de contrato)').toEqual([])
  })

  it('AC-T03-05 o código de runtime só importa zod (ou módulos internos/node:)', () => {
    const src = pkgSrcDir()
    const files = walk(src).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !relative(src, f).split(/[\\/]/).includes('contract'),
    )
    expect(files.length).toBeGreaterThan(0)
    const bad: string[] = []
    const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(re)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? ''
        if (spec.startsWith('.') || spec.startsWith('node:') || spec === 'zod' || spec.startsWith('zod/')) continue
        bad.push(`${relative(src, f)}: ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })
})
