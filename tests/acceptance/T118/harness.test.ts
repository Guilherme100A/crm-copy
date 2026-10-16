// AC-T118-01..03 — harness E2E sem travar, portas por worktree e timeouts dos vitest (contrato combinado com o Fole):
// scripts/e2e/ports.mjs: e2ePorts(root, env) → { api, web }, normalizeRoot, readServerInfo, isOwnServerRunning;
// serve.mjs: E2E_PORTS_ROOT (finge outro root no cálculo das portas), E2E_SERVER_INFO (onde gravar o e2e-server.json).
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { ROOT, rootPath } from '../helpers/exec'
import { dbUrl, lit, sql } from '../helpers/pg'
import { http, startServe, type ServeProc } from '../T17/serve'

const ports = async (): Promise<any> => import(pathToFileURL(rootPath('scripts', 'e2e', 'ports.mjs')).href)
const tmp = mkdtempSync(join(tmpdir(), 'crm-t118-'))
const procs: ServeProc[] = []

afterAll(async () => {
  for (const p of procs) await p.stop().catch(() => p.kill())
  rmSync(tmp, { recursive: true, force: true })
})

describe('T118 — build sem travar', () => {
  it('AC-T118-01 sem apps/web/dist, serve.mjs (stdin em pipe aberto, como o Playwright) faz o build e fica pronto em ≤ 180 s', async () => {
    const dist = rootPath('apps', 'web', 'dist')
    const backup = rootPath('apps', 'web', `dist.t118-${process.pid}`)
    const had = existsSync(dist)
    if (had) renameSync(dist, backup)
    try {
      const t0 = Date.now()
      const p = await startServe({ E2E_API_PORT: '0', E2E_WEB_PORT: '0', E2E_SERVER_INFO: join(tmp, 'ac01.json') }, 180_000)
      procs.push(p)
      expect(Date.now() - t0).toBeLessThanOrEqual(180_000)
      expect(p.info.web, p.output()).toBe('up')
      expect(existsSync(join(dist, 'index.html')), 'o build não gerou apps/web/dist/index.html').toBe(true)
      const page = await fetch(p.info.webUrl)
      expect(page.status).toBe(200)
      expect((await http(p.info.apiUrl, 'GET', '/health')).status).toBe(200)
      const stopped = await p.stop()
      expect(stopped, `serve.mjs não encerrou com 'q':\n${p.output()}`).not.toBeNull()
      expect(stopped!.code).toBe(0)
    } finally {
      if (existsSync(backup)) {
        if (existsSync(dist)) rmSync(backup, { recursive: true, force: true })
        else renameSync(backup, dist)
      }
    }
  }, 300_000)
})

describe('T118 — portas por worktree', () => {
  it('AC-T118-02 e2ePorts deriva portas estáveis do caminho do worktree, diferentes entre worktrees, e o env tem prioridade', async () => {
    const { e2ePorts, normalizeRoot } = await ports()
    const a = e2ePorts('C:/Users/x/leonas-crm-wt/T118', {})
    const b = e2ePorts('C:/Users/x/leonas-crm-wt/T119', {})
    expect(a).toEqual(e2ePorts('C:/Users/x/leonas-crm-wt/T118', {}))
    expect(a.web).not.toBe(b.web)
    for (const p of [a, b]) {
      expect(p.web).toBeGreaterThanOrEqual(1024)
      expect(p.web).toBeLessThanOrEqual(65535)
      expect(p.api).not.toBe(p.web)
    }
    // mesmo caminho em outra grafia → mesmas portas
    expect(normalizeRoot('C:\\Users\\X\\leonas-crm-wt\\T118\\')).toBe(normalizeRoot('c:/users/x/leonas-crm-wt/T118'))
    expect(e2ePorts('C:\\Users\\X\\leonas-crm-wt\\T118\\', {})).toEqual(e2ePorts('c:/users/x/leonas-crm-wt/T118', {}))
    expect(e2ePorts('C:/qualquer', { E2E_WEB_PORT: '45001', E2E_API_PORT: '45002' })).toEqual({ web: 45001, api: 45002 })
    // o worktree real tem portas derivadas do seu caminho
    expect(e2ePorts(ROOT, {})).toEqual(e2ePorts(normalizeRoot(ROOT), {}))
  })

  it('AC-T118-02 dois worktrees sobem o harness ao mesmo tempo em portas diferentes e cada um fala com o seu servidor', async () => {
    const { e2ePorts } = await ports()
    const roots = [`C:/t118-sim/wt-a-${process.pid}`, `C:/t118-sim/wt-b-${process.pid}`]
    const infos = roots.map((_, i) => join(tmp, `ac02-${i}.json`))
    const [pa, pb] = await Promise.all(
      roots.map((r, i) => startServe({ E2E_PORTS_ROOT: r, E2E_SERVER_INFO: infos[i]! }, 240_000)),
    )
    procs.push(pa!, pb!)
    const expected = roots.map((r) => e2ePorts(r, {}))
    const got = [pa!, pb!].map((p) => ({ web: Number(new URL(p.info.webUrl).port), api: Number(new URL(p.info.apiUrl).port) }))
    expect(got).toEqual(expected)
    expect(got[0]!.web).not.toBe(got[1]!.web)
    expect(pa!.info.database).not.toBe(pb!.info.database)

    // arquivo de identidade de cada um
    const files = infos.map((f) => JSON.parse(readFileSync(f, 'utf8')))
    expect(files.map((f) => f.database)).toEqual([pa!.info.database, pb!.info.database])
    expect(files.map((f) => f.web_port)).toEqual(got.map((g) => g.web))

    // um cadastro pela web de A só aparece no banco de A
    const email = `t118-${process.pid}-${Date.now()}@example.test`
    const reg = await http(pa!.info.webUrl, 'POST', '/api/auth/register', { name: 'Usuária T118', email, password: 'Senha-t118-123', password_confirmation: 'Senha-t118-123' })
    expect(reg.status, reg.text).toBeLessThan(300)
    const count = (db: string) => sql(dbUrl(db), `SELECT count(*) FROM crm.users WHERE email = ${lit(email)};`).rows[0]?.[0]
    expect(count(pa!.info.database)).toBe('1')
    expect(count(pb!.info.database)).toBe('0')

    for (const p of [pa!, pb!]) expect((await p.stop())?.code).toBe(0)
    for (const f of infos) expect(existsSync(f), `${f} não foi apagado ao sair`).toBe(false)
  }, 420_000)

  it('AC-T118-02 a porta derivada ocupada por outro processo faz o serve.mjs falhar com mensagem clara', async () => {
    const { e2ePorts } = await ports()
    const root = `C:/t118-sim/busy-${process.pid}`
    const { web } = e2ePorts(root, {})
    const { createServer } = await import('node:net')
    const blocker = createServer().listen(web, '127.0.0.1')
    await new Promise((r) => blocker.once('listening', r))
    try {
      await expect(startServe({ E2E_PORTS_ROOT: root, E2E_SERVER_INFO: join(tmp, 'busy.json') }, 120_000)).rejects.toThrow(
        new RegExp(String(web)),
      )
    } finally {
      blocker.close()
    }
  }, 180_000)
})

describe('T118 — timeouts dos vitest', () => {
  const workspaces = ['apps', 'packages'].flatMap((d) => readdirSync(rootPath(d), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${d}/${e.name}`))

  it('AC-T118-03 todo app e package tem vitest.config.ts com testTimeout ≥ 30000 e hookTimeout ≥ 60000', async () => {
    expect(workspaces.length).toBeGreaterThanOrEqual(12)
    const bad: string[] = []
    for (const ws of workspaces) {
      const file = rootPath(ws, 'vitest.config.ts')
      if (!existsSync(file)) {
        bad.push(`${ws}: sem vitest.config.ts`)
        continue
      }
      const mod: any = await import(pathToFileURL(file).href)
      let cfg = mod.default
      if (typeof cfg === 'function') cfg = await cfg({ command: 'serve', mode: 'test' })
      const test = cfg?.test ?? {}
      if (!(Number(test.testTimeout) >= 30_000)) bad.push(`${ws}: testTimeout=${test.testTimeout}`)
      if (!(Number(test.hookTimeout) >= 60_000)) bad.push(`${ws}: hookTimeout=${test.hookTimeout}`)
    }
    expect(bad).toEqual([])
  })
})
