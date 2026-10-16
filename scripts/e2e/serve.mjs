#!/usr/bin/env node
// Harness E2E (T17; SPEC 3.10): banco descartável migrado + seed, API (fakes, E2E=1, worker in-process) e web
// (`vite preview` com proxy /api, quando apps/web existir). Imprime as URLs em linhas KEY=VALUE e por fim E2E_READY.
// Encerrar: "q" + Enter, fechar o stdin, Ctrl+C ou SIGTERM → derruba os filhos e remove o banco (exit 0).
//
// Env opcionais: E2E_API_PORT / E2E_WEB_PORT (0 = porta livre), DATABASE_URL (servidor base),
// E2E_REDIS_URL (default redis://127.0.0.1:6379/14), E2E_SKIP_WEB=1, E2E_WEB_BUILD=0.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pg = createRequire(join(ROOT, 'packages', 'db', 'package.json'))('pg')
const IS_WIN = process.platform === 'win32'
const HEALTH_TIMEOUT_MS = 60_000

const out = (line) => process.stdout.write(`${line}\n`)
const log = (msg) => process.stderr.write(`[e2e] ${msg}\n`)

function withDatabase(baseUrl, name) {
  const u = new URL(baseUrl)
  u.pathname = `/${name}`
  return u.toString()
}

async function freePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(Number(preferred) || 0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function admin(baseUrl, sql) {
  const c = new pg.Client({ connectionString: baseUrl })
  await c.connect()
  try {
    await c.query(sql)
  } finally {
    await c.end()
  }
}

async function waitHealth(url, timeoutMs, child) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`API saiu antes de ficar pronta (exit ${child.exitCode})`)
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`GET /health não respondeu em ${timeoutMs} ms`)
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

/** Encerra o filho pelo stdin ("q") e espera; se não sair a tempo, mata a árvore. */
async function stopChild(child, graceMs = 6_000) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  try {
    child.stdin?.write('q\n')
    child.stdin?.end()
  } catch {
    // stdin já fechado
  }
  const timer = new Promise((r) => setTimeout(r, graceMs, 'timeout'))
  if ((await Promise.race([exited, timer])) === 'timeout') {
    killTree(child)
    await exited
  }
}

function webAvailable() {
  const dir = join(ROOT, 'apps', 'web')
  return existsSync(dir) && readdirSync(dir).some((f) => /^vite\.config\.(m?[jt]s)$/.test(f))
}

async function main() {
  const baseUrl = process.env.DATABASE_URL || 'postgres://wsm:wsm@127.0.0.1:5432/crm'
  const redisUrl = process.env.E2E_REDIS_URL || 'redis://127.0.0.1:6379/14'
  const dbName = `crm_e2e_${randomBytes(5).toString('hex')}`
  const apiPort = await freePort(process.env.E2E_API_PORT)
  const apiUrl = `http://127.0.0.1:${apiPort}`

  const children = []
  let dbCreated = false
  let finished = false
  const cleanup = async (code) => {
    if (finished) return
    finished = true
    await Promise.all(children.map((c) => stopChild(c)))
    if (dbCreated) {
      try {
        await admin(baseUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
        log(`banco ${dbName} removido`)
      } catch (err) {
        log(`falha ao remover ${dbName}: ${err.message}`)
        code ||= 1
      }
    }
    out('E2E_STOPPED')
    process.exit(code)
  }
  process.on('SIGINT', () => void cleanup(0))
  process.on('SIGTERM', () => void cleanup(0))
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    if (chunk.trim() === 'q') void cleanup(0)
  })
  process.stdin.on('end', () => void cleanup(0))
  process.stdin.resume()

  try {
    await admin(baseUrl, `CREATE DATABASE "${dbName}"`)
    dbCreated = true

    const env = {
      ...process.env,
      E2E: '1',
      NODE_ENV: 'test',
      APP_NAME: process.env.APP_NAME || 'CRM',
      PORT: String(apiPort),
      HOST: '127.0.0.1',
      DATABASE_URL: withDatabase(baseUrl, dbName),
      REDIS_URL: redisUrl,
      CREDENTIALS_KEY: randomBytes(32).toString('base64'),
      WA_GATEWAY: 'fake',
      AI_MODE: 'fake',
      MAIL_TRANSPORT: 'memory',
      ANTIBAN_MODE: 'passthrough',
      WEB_PUBLIC_URL: process.env.WEB_PUBLIC_URL || 'http://127.0.0.1:5173',
      LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
    }
    const api = spawn(process.execPath, ['--import', 'tsx', '--conditions=development', join(ROOT, 'scripts', 'e2e', 'api.ts')], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    children.push(api)
    api.stdout.on('data', (d) => process.stderr.write(d))
    api.on('exit', (code) => {
      if (!finished) {
        log(`API saiu (exit ${code})`)
        void cleanup(1)
      }
    })
    await waitHealth(apiUrl, HEALTH_TIMEOUT_MS, api)

    let webUrl = ''
    if (process.env.E2E_SKIP_WEB !== '1' && webAvailable()) {
      const webPort = await freePort(process.env.E2E_WEB_PORT)
      const webEnv = { ...process.env, E2E: '1', E2E_API_URL: apiUrl }
      if (process.env.E2E_WEB_BUILD !== '0' && !existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'))) {
        const b = spawnSync('pnpm', ['--filter', '@crm/web', 'build'], { cwd: ROOT, env: webEnv, stdio: 'inherit', shell: IS_WIN })
        if (b.status !== 0) throw new Error('build da web falhou')
      }
      const web = spawn('pnpm', ['--filter', '@crm/web', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
        cwd: ROOT,
        env: webEnv,
        stdio: ['pipe', 'inherit', 'inherit'],
        shell: IS_WIN,
      })
      children.push(web)
      webUrl = `http://127.0.0.1:${webPort}`
      const until = Date.now() + HEALTH_TIMEOUT_MS
      for (;;) {
        try {
          if ((await fetch(webUrl, { signal: AbortSignal.timeout(1000) })).ok) break
        } catch {
          // ainda subindo
        }
        if (Date.now() > until) throw new Error('web não respondeu')
        await new Promise((r) => setTimeout(r, 250))
      }
    }

    out(`E2E_API_URL=${apiUrl}`)
    out(`E2E_WEB_URL=${webUrl}`)
    out(`E2E_WEB=${webUrl ? 'up' : 'absent'}`)
    out(`E2E_DATABASE=${dbName}`)
    out('E2E_READY')
  } catch (err) {
    log(err.message)
    await cleanup(1)
  }
}

void main()
