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
