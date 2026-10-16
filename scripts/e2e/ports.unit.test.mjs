// Portas por worktree e identidade do servidor do harness E2E (T118). Roda pelo vitest do @crm/api.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  derivedPorts,
  e2ePorts,
  isOwnServerRunning,
  isPidAlive,
  normalizeRoot,
  readServerInfo,
  REPO_ROOT,
  serverInfoPath,
} from './ports.mjs'

const tmps = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-e2e-ports-'))
  tmps.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('normalizeRoot', () => {
  it('unifica separador, caixa e barra final', () => {
    const dir = tmp()
    const n = normalizeRoot(dir)
    expect(n).not.toMatch(/\\/)
    expect(n).toBe(n.toLowerCase())
    expect(normalizeRoot(`${dir}/`)).toBe(n)
    expect(normalizeRoot(dir.toUpperCase())).toBe(n)
  })
})

describe('derivedPorts', () => {
  it('é determinística, par na faixa 20000–39998 e api = web + 1', () => {
    const a = derivedPorts('/x/leonas-crm-wt/T118')
    expect(derivedPorts('/x/leonas-crm-wt/T118')).toEqual(a)
    expect(a.web % 2).toBe(0)
    expect(a.web).toBeGreaterThanOrEqual(20000)
    expect(a.web).toBeLessThanOrEqual(39998)
    expect(a.api).toBe(a.web + 1)
  })

  it('worktrees diferentes caem em portas diferentes', () => {
    const roots = Array.from({ length: 20 }, (_, i) => `/x/leonas-crm-wt/T${100 + i}`)
    const webs = new Set(roots.map((r) => derivedPorts(r).web))
    expect(webs.size).toBe(roots.length)
  })

  it('o mesmo caminho em grafias diferentes dá a mesma porta', () => {
    const dir = tmp()
    expect(derivedPorts(dir.toUpperCase())).toEqual(derivedPorts(`${dir}/`))
  })
})

describe('e2ePorts', () => {
  it('sem env usa as portas derivadas do root', () => {
    expect(e2ePorts('/x/a', {})).toEqual(derivedPorts('/x/a'))
    expect(e2ePorts(undefined, {})).toEqual(derivedPorts(REPO_ROOT))
  })

  it('E2E_WEB_PORT / E2E_API_PORT sobrescrevem (0 = porta livre)', () => {
    expect(e2ePorts('/x/a', { E2E_WEB_PORT: '4100', E2E_API_PORT: '0' })).toEqual({ web: 4100, api: 0 })
    expect(e2ePorts('/x/a', { E2E_API_PORT: '' })).toEqual(derivedPorts('/x/a'))
  })

  it('E2E_PORTS_ROOT troca o root só do cálculo', () => {
    expect(e2ePorts('/x/a', { E2E_PORTS_ROOT: '/x/b' })).toEqual(derivedPorts('/x/b'))
  })

  it('porta inválida é erro', () => {
    expect(() => e2ePorts('/x/a', { E2E_WEB_PORT: 'abc' })).toThrow(/porta inválida/)
    expect(() => e2ePorts('/x/a', { E2E_API_PORT: '70000' })).toThrow(/porta inválida/)
  })
})

describe('identidade do servidor', () => {
  const write = (root, info) => {
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results', 'e2e-server.json'), JSON.stringify(info))
  }

  it('serverInfoPath: test-results/e2e-server.json do root ou E2E_SERVER_INFO', () => {
    const root = tmp()
    expect(serverInfoPath(root, {})).toBe(join(root, 'test-results', 'e2e-server.json'))
    const custom = join(root, 'outro.json')
    expect(serverInfoPath(root, { E2E_SERVER_INFO: custom })).toBe(custom)
  })

  it('readServerInfo: null sem arquivo ou com JSON inválido', () => {
    const root = tmp()
    expect(readServerInfo(root, {})).toBeNull()
    mkdirSync(join(root, 'test-results'))
    writeFileSync(join(root, 'test-results', 'e2e-server.json'), '{quebrado')
    expect(readServerInfo(root, {})).toBeNull()
  })

  it('isOwnServerRunning: só com root igual e pid vivo', () => {
    const root = tmp()
    expect(isOwnServerRunning(root, {})).toBe(false)
    write(root, { root: normalizeRoot(root), pid: process.pid })
    expect(isOwnServerRunning(root, {})).toBe(true)
    write(root, { root: normalizeRoot(tmp()), pid: process.pid })
    expect(isOwnServerRunning(root, {})).toBe(false)
    write(root, { root: normalizeRoot(root), pid: 2 ** 22 + 12345 })
    expect(isOwnServerRunning(root, {})).toBe(false)
  })

  it('isOwnServerRunning respeita E2E_SERVER_INFO', () => {
    const root = tmp()
    const custom = join(tmp(), 'srv.json')
    writeFileSync(custom, JSON.stringify({ root: normalizeRoot(root), pid: process.pid }))
    expect(isOwnServerRunning(root, { E2E_SERVER_INFO: custom })).toBe(true)
    expect(isOwnServerRunning(root, {})).toBe(false)
  })

  it('isPidAlive', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(undefined)).toBe(false)
  })
})
