#!/usr/bin/env node
// Harness E2E (T17; SPEC 3.10): banco descartável migrado + seed, API (fakes, E2E=1, worker in-process) e web
// (`vite preview` com proxy /api, quando apps/web existir). Imprime as URLs em linhas KEY=VALUE e por fim E2E_READY.
// Encerrar: "q" + Enter, fechar o stdin, Ctrl+C ou SIGTERM → derruba os filhos e remove o banco (exit 0).
//
// Portas (T118): derivadas do caminho do worktree (scripts/e2e/ports.mjs), para worktrees em paralelo não colidirem;
// porta derivada ocupada → erro claro (nunca cai noutra porta e fala com o servidor errado). Ao ficar pronto grava
// a identidade em test-results/e2e-server.json (o Playwright só reaproveita servidor deste worktree) e a apaga ao sair.
// Nenhum filho herda o stdin deste processo (ele é lido aqui; herdá-lo travava o build da web no Windows).
//
// Env opcionais: E2E_API_PORT / E2E_WEB_PORT (0 = porta livre), E2E_PORTS_ROOT (outro root só para as portas),
// E2E_SERVER_INFO (onde gravar a identidade), E2E_IGNORE_STDIN=1 (não lê o stdin; rodar em segundo plano),
// DATABASE_URL (servidor base), E2E_SKIP_WEB=1, E2E_WEB_BUILD=0.
//
// Redis (T122): db próprio do worktree (2..15, pelo mesmo hash das portas; reservado com a chave e2e:harness:owner,
// e o próximo livre se outro worktree vivo já o tiver), stream wsm:events:e2e-<hash> e prefixo de filas
// crm-e2e-<hash>. E2E_REDIS_URL = exatamente aquele Redis (db incluso, sem reserva); WA_EVENTS_STREAM e
// CRM_QUEUE_PREFIX sobrescrevem os nomes. O efetivo vai para o e2e-server.json ("redis") e o stdout.
//
// T124: E2E_RESET_TIMEOUT_MS (padrão 60000; vai à API e ao e2e-server.json em reset_timeout_ms). Ao subir, apaga os
// bancos de teste órfãos (crm_e2e_/crm_test_/crm_acc_ sem conexão e mais antigos que E2E_ORPHAN_MIN_AGE_MIN, padrão
// 30), preservando os de harnesses vivos; E2E_ORPHAN_CLEANUP=0 desliga. Resultado em "orphans" e E2E_ORPHANS_DROPPED.
//
// T128: o banco nasce clonado do banco-modelo das migrações (scripts/e2e/template-db.mjs, docs/testing.md) e a API
// aplica só o seed; o reset (/__e2e/reset) esvazia as tabelas e reaplica o seed nesse mesmo banco. Saem
// E2E_DATABASE_TEMPLATE (modelo usado) e E2E_DATABASE_READY_MS (banco criado + seed, até o /health). A limpeza de órfãos
// também remove modelos de hash antigo. CRM_TEST_TEMPLATE=0 = banco vazio + todas as migrações (como antes).
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { e2ePorts, e2eRedis, isOwnServerRunning, maskRedisUrl, normalizeRoot, readServerInfo, serverInfoPath } from './ports.mjs'
import { claimRedisDb, liveHarnessDatabases } from './redis-claim.mjs'
import { cleanupOrphanDatabases, orphanMinAgeMs } from './orphans.mjs'
import { cloneTemplateDatabase } from './template-db.mjs'

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

/** Confere que a porta está livre (0 = escolhe uma livre) e devolve a porta real. Ocupada → erro claro. */
async function reservePort(port, label) {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const envName = label === 'api' ? 'E2E_API_PORT' : 'E2E_WEB_PORT'
        reject(new Error(`porta ${port} (${label}) ocupada: outro harness deste worktree já está de pé ou há colisão; encerre-o ou defina ${envName}`))
      } else reject(err)
    })
    srv.listen(port, '127.0.0.1', () => {
      const { port: real } = srv.address()
      srv.close(() => resolve(real))
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

/** Timeout do `POST /__e2e/reset` (T124): `E2E_RESET_TIMEOUT_MS`, padrão 60000. */
function resetTimeoutFromEnv(env = process.env) {
  const raw = env.E2E_RESET_TIMEOUT_MS
  const n = raw === undefined || String(raw).trim() === '' ? 60_000 : Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`E2E_RESET_TIMEOUT_MS inválido: ${raw}`)
  return n
}

async function main() {
  const baseUrl = process.env.DATABASE_URL || 'postgres://wsm:wsm@127.0.0.1:5432/crm'
  const redisPlan = e2eRedis(ROOT)
  let redisUrl = redisPlan.url
  let redisDb = redisPlan.db
  let releaseRedis = async () => undefined
  let orphans = { dropped: [], kept: [] }
  const resetTimeoutMs = resetTimeoutFromEnv()
  const dbName = `crm_e2e_${randomBytes(5).toString('hex')}`
  const ports = e2ePorts(ROOT)
  const infoPath = serverInfoPath(ROOT)
  const apiPort = await reservePort(ports.api, 'api')
  const apiUrl = `http://127.0.0.1:${apiPort}`

  const children = []
  let dbCreated = false
  let dbTemplate = null
  let finished = false
  const cleanup = async (code) => {
    if (finished) return
    finished = true
    // A identidade só é removida se for deste processo (não apaga a de outro harness de pé).
    if (readServerInfo(ROOT)?.pid === process.pid) rmSync(infoPath, { force: true })
    await releaseRedis()
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
  if (process.env.E2E_IGNORE_STDIN !== '1') {
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      if (chunk.trim() === 'q') void cleanup(0)
    })
    process.stdin.on('end', () => void cleanup(0))
    process.stdin.resume()
  }

  try {
    if (redisPlan.source === 'derived') {
      const claim = await claimRedisDb(redisPlan.url, redisPlan.db, ROOT, process.pid, undefined, { database: dbName })
      redisUrl = claim.url
      redisDb = claim.db
      releaseRedis = claim.release
      if (claim.db !== redisPlan.db) log(`Redis db ${redisPlan.db} já é de outro harness vivo; usando o db ${claim.db}`)
    }
    // T124: bancos de teste órfãos (execuções mortas) caem antes de criar o deste harness; os de harnesses vivos ficam.
    if (process.env.E2E_ORPHAN_CLEANUP !== '0') {
      try {
        const protect = [dbName, ...(await liveHarnessDatabases(redisUrl).catch(() => []))]
        orphans = await cleanupOrphanDatabases({ baseUrl, minAgeMs: orphanMinAgeMs(), protect })
        if (orphans.dropped.length) log(`bancos órfãos removidos: ${orphans.dropped.join(', ')}`)
      } catch (err) {
        log(`limpeza de bancos órfãos falhou: ${err.message}`)
      }
    }
    // T128: clone do banco-modelo das migrações (criado e migrado uma vez por hash); a API só confere as migrações
    // (nenhuma pendente) e aplica o seed. CRM_TEST_TEMPLATE=0 → banco vazio e a API roda todas as migrações.
    const dbT0 = Date.now()
    if (process.env.CRM_TEST_TEMPLATE !== '0') {
      const tpl = await cloneTemplateDatabase(dbName, { baseUrl, set: 'all' })
      dbTemplate = tpl.name
      log(`banco ${dbName} clonado de ${tpl.name}${tpl.created ? ' (modelo criado agora)' : ''} em ${tpl.cloneMs} ms`)
    } else {
      await admin(baseUrl, `CREATE DATABASE "${dbName}"`)
    }
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
      E2E_RESET_TIMEOUT_MS: String(resetTimeoutMs),
      WA_EVENTS_STREAM: redisPlan.stream,
      CRM_QUEUE_PREFIX: redisPlan.queuePrefix,
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
    // Banco pronto para uso = criado + migrações conferidas + seed (feitos pela API antes do /health).
    const dbReadyMs = Date.now() - dbT0

    let webUrl = ''
    if (process.env.E2E_SKIP_WEB !== '1' && webAvailable()) {
      const webPort = await reservePort(ports.web, 'web')
      const webEnv = { ...process.env, E2E: '1', E2E_API_URL: apiUrl }
      if (process.env.E2E_WEB_BUILD !== '0' && !existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'))) {
        log('apps/web/dist ausente: build da web')
        // stdin 'ignore': herdar o stdin (que este processo lê) deixava o pnpm parado sem lançar o vite (T118).
        const b = spawnSync('pnpm', ['--filter', '@crm/web', 'build'], { cwd: ROOT, env: webEnv, stdio: ['ignore', 'inherit', 'inherit'], shell: IS_WIN })
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

    mkdirSync(dirname(infoPath), { recursive: true })
    const info = {
      root: normalizeRoot(ROOT),
      api_url: apiUrl,
      web_url: webUrl,
      api_port: apiPort,
      web_port: webUrl ? Number(new URL(webUrl).port) : null,
      database: dbName,
      database_template: dbTemplate,
      reset_timeout_ms: resetTimeoutMs,
      orphans: { dropped: orphans.dropped, kept: orphans.kept, min_age_min: orphanMinAgeMs() / 60_000 },
      redis: { url: maskRedisUrl(redisUrl), db: redisDb, stream: redisPlan.stream, queue_prefix: redisPlan.queuePrefix, source: redisPlan.source },
      pid: process.pid,
      started_at: new Date().toISOString(),
    }
    // Dois harnesses no mesmo checkout (um com E2E_*_PORT): não sobrescreve a identidade de outro servidor vivo.
    const current = readServerInfo(ROOT)
    if (current && current.pid !== process.pid && isOwnServerRunning(ROOT)) {
      log(`${infoPath} já é do servidor pid ${current.pid}; identidade deste harness não gravada`)
    } else {
      writeFileSync(infoPath, `${JSON.stringify(info, null, 2)}\n`)
    }
    out(`E2E_API_URL=${apiUrl}`)
    out(`E2E_WEB_URL=${webUrl}`)
    out(`E2E_WEB=${webUrl ? 'up' : 'absent'}`)
    out(`E2E_DATABASE=${dbName}`)
    out(`E2E_DATABASE_TEMPLATE=${dbTemplate ?? ''}`)
    out(`E2E_DATABASE_READY_MS=${dbReadyMs}`)
    out(`E2E_ORPHANS_DROPPED=${orphans.dropped.length}`)
    out(`E2E_REDIS_URL=${maskRedisUrl(redisUrl)}`)
    out(`E2E_WA_EVENTS_STREAM=${redisPlan.stream}`)
    out(`E2E_SERVER_INFO=${infoPath}`)
    out('E2E_READY')
  } catch (err) {
    log(err.message)
    await cleanup(1)
  }
}

main().catch((err) => {
  // Falhas antes do banco existir (porta ocupada, porta inválida): mensagem clara, sem stack.
  log(err.message)
  process.exit(1)
})
