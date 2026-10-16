import { describe, expect, it } from 'vitest'
import { readText, repoFiles } from '../helpers/exec'

// SPEC 1.4 nº 11 + regra F-WA-BOUNDARY: Baileys só nos diretórios do engine que falam com o socket.
const ALLOWED = ['packages/wa-engine/src/transport/', 'packages/wa-engine/src/antiban/', 'packages/wa-engine/src/auth-state/', 'packages/wa-engine/src/media/']
const BAILEYS_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](@whiskeysockets\/baileys|baileys|baileys-antiban)(?:\/[^'"]*)?['"]/

const isCode = (f: string) => /\.(c|m)?[jt]sx?$/.test(f)
const isTestOrSpec = (f: string) => f.startsWith('tests/') || f.startsWith('spec/') || /\.(unit\.)?test\.[cm]?[jt]sx?$/.test(f) || /\.e2e\.[jt]s$/.test(f)
const isVendored = (f: string) => f.includes('node_modules/') || f.includes('/dist/')

describe('T07 — fronteira do Baileys', () => {
  it('AC-T07-06 nenhum arquivo de produto fora dos diretórios permitidos do engine importa Baileys', () => {
    const offenders = repoFiles()
      .filter((f) => isCode(f) && !isTestOrSpec(f) && !isVendored(f))
      .filter((f) => !ALLOWED.some((d) => f.startsWith(d)))
      .filter((f) => BAILEYS_IMPORT.test(readText(f)))
    expect(offenders).toEqual([])
  })

  it('AC-T07-06 o transporte do engine é quem importa Baileys (a regra não passa por vacuidade)', () => {
    const inTransport = repoFiles().filter((f) => f.startsWith('packages/wa-engine/src/transport/') && isCode(f) && !isTestOrSpec(f))
    expect(inTransport.length, 'packages/wa-engine/src/transport vazio').toBeGreaterThan(0)
    expect(inTransport.some((f) => BAILEYS_IMPORT.test(readText(f))), 'nenhum arquivo do transporte importa Baileys').toBe(true)
  })

  it('AC-T07-06 a detecção pega import estático, dinâmico e subpath', () => {
    // Amostras montadas em partes: o literal contíguo dispararia a regra F-TEST-NO-REAL-WA neste arquivo.
    const PKG = '@whiskeysockets' + '/baileys'
    const ANTIBAN = 'baileys' + '-antiban'
    for (const src of [
      `import { makeWASocket } from '${PKG}'`,
      `const m = await import('${PKG}')`,
      `import type { WAMessage } from '${PKG}/lib/Types'`,
      `import { x } from '${ANTIBAN}'`,
      `import '${PKG}'`,
    ])
      expect(BAILEYS_IMPORT.test(src), src).toBe(true)
    expect(BAILEYS_IMPORT.test("import { WaGateway } from '@crm/wa-port'")).toBe(false)
  })
})
