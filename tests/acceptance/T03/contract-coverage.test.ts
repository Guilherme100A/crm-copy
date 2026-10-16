// Meta-checagem da suíte de contrato: roda contract-fake.test.ts em subprocesso (reporter JSON) para
// confirmar que ela cobre send, cancel, sessions, downloadMedia e eventos, e que falha com gateway sabotado.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exec, tail } from '../helpers/exec'

const tmp = mkdtempSync(join(tmpdir(), 'crm-t03-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

interface Row {
  fullName: string
  status: string
}

function runSuite(sabotage: boolean): { rows: Row[]; out: string } {
  const file = join(tmp, `${sabotage ? 'sab' : 'ok'}.json`)
  const r = exec(
    `pnpm exec vitest run --config tests/acceptance/vitest.config.ts --reporter=json --outputFile="${file}" tests/acceptance/T03/contract-fake.test.ts`,
    { env: { T03_SABOTAGE: sabotage ? '1' : '0' }, timeoutMs: 280_000 },
  )
  let json: any
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`vitest não gerou relatório JSON\n${tail(r)}`)
  }
  const rows: Row[] = (json.testResults ?? []).flatMap((f: any) => f.assertionResults ?? [])
  return { rows, out: tail(r) }
}

const AREAS: Array<[string, RegExp]> = [
  ['send', /\bsend|envi/i],
  ['cancel', /cancel/i],
  ['sessions', /sess/i],
  ['downloadMedia', /download|m[ií]dia|media/i],
  ['eventos', /event|emit|assin|subscri/i],
]

describe('T03 — cobertura da suíte de contrato', () => {
  it('AC-T03-04 a suíte passa contra o FakeWaGateway e cobre send, cancel, sessions, downloadMedia e eventos', () => {
    const { rows, out } = runSuite(false)
    const names = rows.map((t) => `${t.status} ${t.fullName}`).join('\n')
    expect(rows.length, out).toBeGreaterThanOrEqual(AREAS.length)
    expect(rows.filter((t) => t.status !== 'passed').map((t) => t.fullName), names).toEqual([])
    for (const [area, re] of AREAS) {
      const hit = rows.filter((t) => re.test(t.fullName.replace(/AC-T03-04 suíte de contrato de @crm\/wa-port contra o FakeWaGateway/, '')))
      expect(hit.length, `nenhum teste da suíte cobre "${area}":\n${names}`).toBeGreaterThan(0)
    }
  })

  it('AC-T03-04 a suíte não é vazia: falha com um gateway sabotado (send/cancel/sessions/downloadMedia quebrados)', () => {
    const { rows, out } = runSuite(true)
    const failed = rows.filter((t) => t.status === 'failed').map((t) => t.fullName)
    expect(failed.length, `a suíte deveria detectar o gateway quebrado\n${out}`).toBeGreaterThanOrEqual(3)
  })
})
