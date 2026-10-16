// AC-T121-02: as configs de teste definem um CRM_QUEUE_PREFIX único por execução.
// - Aceitação: lido do ambiente dentro deste teste.
// - Apps/packages: cada vitest.config.ts carregado em DOIS processos separados (fixtures/print-prefixes.ts):
//   todo app/package define o prefixo e os valores mudam de uma execução para outra.
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exec, rootPath, tail } from '../helpers/exec'

const PATTERN = /^crm-t-[\w-]+$/

function configs(): string[] {
  const out: string[] = []
  for (const g of ['apps', 'packages'])
    for (const n of readdirSync(rootPath(g))) if (existsSync(join(rootPath(g), n, 'vitest.config.ts'))) out.push(`${g}/${n}`)
  return out
}

function runPrinter(): Record<string, { CRM_QUEUE_PREFIX?: string; WA_QUEUE_PREFIX?: string; error?: string }> {
  const r = exec('pnpm exec tsx tests/acceptance/T121/fixtures/print-prefixes.ts', { timeoutMs: 240_000 })
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('PREFIXES '))
  if (!line) throw new Error(`sem saída do carregador de configs\n${tail(r)}`)
  return JSON.parse(line.slice('PREFIXES '.length))
}

describe('T121 — prefixo único por execução nas configs de teste (AC-T121-02)', () => {
  it('AC-T121-02 a suíte de aceitação roda com CRM_QUEUE_PREFIX e WA_QUEUE_PREFIX próprios desta execução', () => {
    const crm = process.env.CRM_QUEUE_PREFIX
    expect(crm, 'CRM_QUEUE_PREFIX ausente no ambiente da aceitação').toBeTruthy()
    expect(crm).not.toBe('crm')
    expect(crm).toMatch(PATTERN)
    expect(process.env.WA_QUEUE_PREFIX).toBeTruthy()
    expect(process.env.WA_QUEUE_PREFIX).not.toBe('wsm')
  })

  it('AC-T121-02 todo apps/* e packages/* define CRM_QUEUE_PREFIX no test.env, diferente a cada execução', () => {
    const expected = configs()
    expect(expected.length).toBeGreaterThanOrEqual(12)
    const first = runPrinter()
    const second = runPrinter()
    for (const ws of expected) {
      const a = first[ws]
      const b = second[ws]
      expect(a?.error, `${ws}: falhou ao carregar a config`).toBeUndefined()
      expect(a?.CRM_QUEUE_PREFIX, `${ws}: sem CRM_QUEUE_PREFIX`).toMatch(PATTERN)
      expect(a?.CRM_QUEUE_PREFIX, `${ws}: prefixo repetido entre execuções`).not.toBe(b?.CRM_QUEUE_PREFIX)
      expect(a?.WA_QUEUE_PREFIX, `${ws}: sem WA_QUEUE_PREFIX`).toBeTruthy()
    }
  })
})
