// Portas do harness E2E por worktree (T118): vários worktrees testando na mesma máquina não disputam portas.
// web = 20000 + 2·(sha256(root) mod 10000) (par em 20000–39998); api = web + 1. Env têm prioridade:
// E2E_WEB_PORT / E2E_API_PORT ('0' = porta livre) e E2E_PORTS_ROOT (outro root só para o cálculo).
// O serve.mjs grava a identidade do servidor em <root>/test-results/e2e-server.json; o Playwright só reaproveita
// um servidor já de pé quando ele é deste worktree (isOwnServerRunning).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PORT_BASE = 20000
export const PORT_SLOTS = 10000

/** Caminho absoluto, com `/`, minúsculo e sem `/` final (C:\\A\\b\\ e c:/a/b viram o mesmo). */
export function normalizeRoot(path) {
  return resolve(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Portas derivadas do root (sem olhar env). */
export function derivedPorts(root) {
  const h = createHash('sha256').update(normalizeRoot(root)).digest()
  const web = PORT_BASE + 2 * (h.readUInt32BE(0) % PORT_SLOTS)
  return { web, api: web + 1 }
}

const envPort = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`porta inválida: ${value}`)
  return n
}

/** `{ api, web }` do harness deste worktree; env sobrescreve (0 = porta livre, resolvida pelo serve.mjs). */
export function e2ePorts(root = REPO_ROOT, env = process.env) {
  const base = derivedPorts(env.E2E_PORTS_ROOT || root)
  return { api: envPort(env.E2E_API_PORT) ?? base.api, web: envPort(env.E2E_WEB_PORT) ?? base.web }
}

/** Onde o serve.mjs grava a identidade do servidor (E2E_SERVER_INFO sobrescreve). */
export function serverInfoPath(root = REPO_ROOT, env = process.env) {
  return env.E2E_SERVER_INFO ? resolve(env.E2E_SERVER_INFO) : join(root, 'test-results', 'e2e-server.json')
}

/** Identidade gravada pelo serve.mjs, ou `null`. */
export function readServerInfo(root = REPO_ROOT, env = process.env) {
  const path = serverInfoPath(root, env)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: o processo existe, mas é de outro usuário.
    return err?.code === 'EPERM'
  }
}

/** Há um harness deste worktree de pé (arquivo existe, root confere e o processo vive)? */
export function isOwnServerRunning(root = REPO_ROOT, env = process.env) {
  const info = readServerInfo(root, env)
  return !!info && info.root === normalizeRoot(root) && isPidAlive(info.pid)
}

// ---------------------------------------------------------------- Redis por worktree (T122)
// Dois harnesses no mesmo Redis db dividiam o stream `wsm:events`/grupo `crm` (eventos perdidos) e o reset de um
// apagava as chaves do outro. Cada worktree usa um db próprio (2..15; 0 é o padrão e 1 é dos testes vitest), um
// stream e um prefixo de filas próprios. Env têm prioridade: E2E_REDIS_URL (exatamente essa URL, db incluso),
// WA_EVENTS_STREAM e CRM_QUEUE_PREFIX.

export const REDIS_DB_FIRST = 2
export const REDIS_DB_SLOTS = 14
export const DEFAULT_REDIS_HOST = 'redis://127.0.0.1:6379'

const rootHash = (root) => createHash('sha256').update(normalizeRoot(root)).digest()

/** db candidato do root (2..15) e o sufixo curto do worktree (8 hex). */
export function derivedRedis(root) {
  const h = rootHash(root)
  return { db: REDIS_DB_FIRST + (h.readUInt32BE(4) % REDIS_DB_SLOTS), suffix: h.toString('hex').slice(0, 8) }
}

/** URL com o db trocado (mantém host, porta e credenciais). */
export function withRedisDb(url, db) {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}

/** db de uma URL `redis://…/<n>` (0 sem caminho). */
export function redisDbOf(url) {
  const n = Number(new URL(url).pathname.replace(/^\//, '') || '0')
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/** URL sem a senha (para logs e o e2e-server.json). */
export function maskRedisUrl(url) {
  const u = new URL(url)
  if (u.password) u.password = '***'
  return u.toString()
}

/** `{ url, db, stream, queuePrefix, source }` do harness deste worktree (o db pode mudar na reserva do serve.mjs). */
export function e2eRedis(root = REPO_ROOT, env = process.env) {
  const base = derivedRedis(env.E2E_PORTS_ROOT || root)
  const explicit = env.E2E_REDIS_URL && String(env.E2E_REDIS_URL).trim()
  const url = explicit ? String(explicit).trim() : withRedisDb(env.E2E_REDIS_HOST || DEFAULT_REDIS_HOST, base.db)
  return {
    url,
    db: redisDbOf(url),
    stream: env.WA_EVENTS_STREAM || `wsm:events:e2e-${base.suffix}`,
    queuePrefix: env.CRM_QUEUE_PREFIX || `crm-e2e-${base.suffix}`,
    source: explicit ? 'env' : 'derived',
  }
}

/** Ordem de tentativa dos dbs a partir do candidato (cíclica em 2..15). */
export function redisDbCandidates(first) {
  const start = Math.min(Math.max(first, REDIS_DB_FIRST), REDIS_DB_FIRST + REDIS_DB_SLOTS - 1) - REDIS_DB_FIRST
  return Array.from({ length: REDIS_DB_SLOTS }, (_, i) => REDIS_DB_FIRST + ((start + i) % REDIS_DB_SLOTS))
}
