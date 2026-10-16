// AC-T05-02 — createLogger (pino) com redação profunda, inclusive em child loggers. Observa o stdout real de um processo.
import { beforeAll, describe, expect, it } from 'vitest'
import { exec, rootPath, tail, type ExecResult } from '../helpers/exec'

const SECRETS = [
  'PASSWORD-AC-1', 'APIKEY-AC-1', 'CREDS-ME-ID-1', 'CREDS-NOISE-1',
  'PASSWORD-DEEP', 'TOKEN-DEEP', 'SECRET-DEEP', 'APIKEY-DEEP', 'CREDS-DEEP', 'KEYS-DEEP', 'NOISEKEY-DEEP',
  'SIGNEDIDENTITY-DEEP', 'AUTHORIZATION-DEEP', 'COOKIE-DEEP',
  'PASSWORD-ARRAY', 'TOKEN-ARRAY',
  'TOKEN-BINDING', 'APIKEY-BINDING', 'PASSWORD-CHILD', 'SECRET-CHILD',
  'AUTHORIZATION-GRANDCHILD', 'COOKIE-GRANDCHILD', 'SIGNEDIDENTITY-GRANDCHILD',
  'SECRET-ERROR',
]

let run: ExecResult
let lines: Array<Record<string, any>> = []
const byMsg = (msg: string) => lines.find((l) => l.msg === msg)

describe('T05 — logger com redação', () => {
  beforeAll(() => {
    const probe = rootPath('tests', 'acceptance', 'T05', 'fixtures', 'log-probe.ts')
    const entry = rootPath('packages', 'node-kit', 'src', 'index.ts')
    run = exec(`pnpm exec tsx "${probe}" "${entry}"`, { env: { LOG_LEVEL: 'info' }, timeoutMs: 120_000 })
    lines = run.stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('{'))
      .flatMap((l) => {
        try {
          return [JSON.parse(l)]
        } catch {
          return []
        }
      })
  })

  it('AC-T05-02 o logger escreve JSON no stdout com os campos não sensíveis', () => {
    expect(run.code, tail(run)).toBe(0)
    for (const m of ['case-ac', 'case-deep', 'case-array', 'case-child', 'case-grandchild', 'case-error'])
      expect(byMsg(m), `linha "${m}" ausente:\n${tail(run)}`).toBeTruthy()
    expect(run.stdout).toContain('VISIBLE-AC')
    expect(run.stdout).toContain('VISIBLE-DEEP')
    expect(run.stdout).toContain('VISIBLE-CHILD')
  })

  it("AC-T05-02 { user: { password, apiKey }, creds: {...} } não aparece no output", () => {
    const line = byMsg('case-ac')
    expect(line, tail(run)).toBeTruthy()
    expect(JSON.stringify(line)).not.toMatch(/PASSWORD-AC-1|APIKEY-AC-1|CREDS-ME-ID-1|CREDS-NOISE-1/)
    expect(line?.user?.password).not.toBe('PASSWORD-AC-1')
    expect(line?.user?.apiKey).not.toBe('APIKEY-AC-1')
  })

  it('AC-T05-02 redação em qualquer profundidade e em arrays (password, token, secret, apiKey, creds, keys, noiseKey, signedIdentityKey, authorization, cookie)', () => {
    for (const m of ['case-deep', 'case-array', 'case-error']) {
      expect(byMsg(m), `linha "${m}" ausente:\n${tail(run)}`).toBeTruthy()
      const s = JSON.stringify(byMsg(m))
      for (const secret of SECRETS) expect(s, `${m} vazou ${secret}`).not.toContain(secret)
    }
  })

  it('AC-T05-02 child e neto: bindings e objeto do log redigidos', () => {
    for (const m of ['case-child', 'case-grandchild']) {
      expect(byMsg(m), `linha "${m}" ausente:\n${tail(run)}`).toBeTruthy()
      const s = JSON.stringify(byMsg(m))
      for (const secret of SECRETS) expect(s, `${m} vazou ${secret}`).not.toContain(secret)
    }
  })

  it('AC-T05-02 nenhum valor sensível em todo o output (stdout + stderr)', () => {
    expect(run.code, tail(run)).toBe(0)
    for (const secret of SECRETS) expect(run.output, `vazou ${secret}`).not.toContain(secret)
  })
})
