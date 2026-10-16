// wa-worker de verdade como processo filho, para suítes que precisam do lado WhatsApp real (T29, T46…). Não é arquivo de teste. Caixa-preta: o wa-worker roda como PROCESSO FILHO
// (apps/wa-worker/src/main.ts via tsx) e é exercitado só por HTTP (POST /internal/rpc, /internal/fake/*)
// e pelo stream de eventos no Redis. Isolamento (SPEC 3.10): banco descartável, Redis db 1 com stream e
// prefixo aleatórios, porta livre, INTERNAL_TOKEN e CREDENTIALS_KEY aleatórios, WA_TRANSPORT=fake.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from '../helpers/exec'
import { createTempDb, dropTempDb, type TempDb } from '../helpers/pg'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
export const rand = (n = 4) => randomBytes(n).toString('hex')
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 20_000, what = 'condição'): Promise<T> {
  const end = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v as T
    } catch (e) {
      last = e
    }
    await sleep(100)
  }
  throw new Error(`timeout (${timeoutMs} ms) esperando ${what}${last ? `: ${String((last as Error).message ?? last)}` : ''}`)
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

/** Ambiente compartilhado entre boots do mesmo "deploy" (mesmo banco, Redis, stream, prefixo e chaves). */
export interface WorkerEnv {
  db: TempDb
  vars: Record<string, string>
  token: string
  stream: string
  prefix: string
  storageDir: string
  cleanup(): void
}

export function newWorkerEnv(): WorkerEnv {
  const db = createTempDb('crm_acc_waw')
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-waw-storage-'))
  const token = `waw-${rand(16)}`
  const stream = `waw:${rand()}:wsm:events`
  const prefix = `waw${rand()}`
  return {
    db,
    token,
    stream,
    prefix,
    storageDir,
    vars: {
      DATABASE_URL: db.url,
      REDIS_URL,
      INTERNAL_TOKEN: token,
      CREDENTIALS_KEY: randomBytes(32).toString('base64'),
      WA_TRANSPORT: 'fake',
      WA_EVENTS_STREAM: stream,
      WA_QUEUE_PREFIX: prefix,
      WA_RPC_HOST: '127.0.0.1',
      STORAGE_DIR: storageDir,
      ANTIBAN_MODE: 'passthrough',
      LOG_LEVEL: 'warn',
      NODE_ENV: 'test',
    },
    cleanup: () => {
      dropTempDb(db)
      rmSync(storageDir, { recursive: true, force: true })
    },
  }
}

export interface Worker {
  url: string
  proc: ChildProcess
  output: () => string
  exited: Promise<number | null>
  /** Desliga pelo mesmo caminho do SIGTERM (POST /internal/fake/shutdown) e espera o processo sair. */
  shutdown(timeoutMs?: number): Promise<number | null>
  kill(): void
}

/** Sobe o wa-worker como processo filho e espera o servidor interno responder. */
export async function startWorker(env: WorkerEnv): Promise<Worker> {
  const port = await freePort()
  let out = ''
  const proc = spawn('pnpm exec tsx apps/wa-worker/src/main.ts', {
    cwd: ROOT,
    shell: true,
    env: { ...process.env, ...env.vars, WA_RPC_PORT: String(port), NODE_OPTIONS: '--conditions=development', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout?.on('data', (d) => (out += String(d)))
  proc.stderr?.on('data', (d) => (out += String(d)))
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)))
  const url = `http://127.0.0.1:${port}`
  let dead = false
  void exited.then(() => (dead = true))
  // espera o servidor interno; se o processo morrer no boot, falha na hora com a saída dele
  const deadline = Date.now() + 90_000
  for (;;) {
    if (dead) throw new Error(`wa-worker saiu no boot (exit ${proc.exitCode})\n--- saída ---\n${out.slice(-3000)}`)
    const ok = await fetch(`${url}/internal/fake/boot`, { headers: { authorization: `Bearer ${env.token}` } })
      .then((r) => r.ok)
      .catch(() => false)
    if (ok) break
    if (Date.now() > deadline) {
      proc.kill()
      throw new Error(`wa-worker não respondeu em 90 s\n--- saída ---\n${out.slice(-3000)}`)
    }
    await sleep(200)
  }
  const w: Worker = {
    url,
    proc,
    output: () => out,
    exited,
    async shutdown(timeoutMs = 30_000) {
      if (dead) return proc.exitCode
      await fetch(`${url}/internal/fake/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${env.token}` } }).catch(() => undefined)
      const code = await Promise.race([exited, sleep(timeoutMs).then(() => 'timeout' as const)])
      if (code === 'timeout') {
        w.kill()
        throw new Error(`wa-worker não saiu em ${timeoutMs} ms após shutdown\n${out.slice(-2000)}`)
      }
      return code
    },
    kill() {
      if (dead) return
      if (process.platform === 'win32' && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: true })
      else proc.kill('SIGKILL')
    },
  }
  return w
}

export interface RpcResponse {
  status: number
  body: any
}

export async function rpc(w: Worker, env: WorkerEnv, target: string, method: string, args: unknown[] = [], token: string | null = env.token): Promise<RpcResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const r = await fetch(`${w.url}/internal/rpc`, { method: 'POST', headers, body: JSON.stringify({ target, method, args }) })
  const text = await r.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: r.status, body }
}

/** RPC que precisa dar certo: devolve `result` ou lança com o erro serializado. */
export async function call(w: Worker, env: WorkerEnv, target: string, method: string, ...args: unknown[]): Promise<any> {
  const r = await rpc(w, env, target, method, args)
  if (r.status !== 200 || r.body?.error) throw new Error(`${target}.${method} → ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.result
}

export async function fake(w: Worker, env: WorkerEnv, path: string, body?: unknown, method = 'POST'): Promise<RpcResponse> {
  const r = await fetch(`${w.url}/internal/fake/${path}`, {
    method,
    headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  })
  const text = await r.text()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: r.status, body: parsed }
}

export async function newRedis(): Promise<any> {
  const k: any = await import('@crm/node-kit')
  return k.redisConnection({ url: REDIS_URL })
}

/** Eventos do stream validados por parseWaEvent. */
export async function streamEvents(redis: any, stream: string): Promise<any[]> {
  const { parseWaEvent }: any = await import('@crm/wa-port')
  const rows: Array<[string, string[]]> = await redis.xrange(stream, '-', '+')
  return rows.map(([, flat]) => parseWaEvent(JSON.parse(flat[flat.indexOf('event') + 1]!)))
}

export const phone = () => `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}`
export const jidOf = (e164: string) => `${e164.replace(/\D/g, '')}@s.whatsapp.net`

/** Cria a sessão, gera QR e abre a conexão fake; devolve o id quando `sessions.get` diz WARMING. */
export async function connectedSession(w: Worker, env: WorkerEnv): Promise<string> {
  const s = await call(w, env, 'sessions', 'create', { name: `waw-${rand(3)}` })
  await call(w, env, 'sessions', 'startQr', s.id)
  await waitFor(async () => (await fake(w, env, `sessions/${s.id}/qr`, {})).status === 200, 20_000, 'transporte fake criado')
  const open = await fake(w, env, `sessions/${s.id}/open`)
  if (open.status !== 200) throw new Error(`open → ${open.status} ${JSON.stringify(open.body)}`)
  await waitFor(async () => (await call(w, env, 'sessions', 'get', s.id)).status === 'WARMING', 20_000, 'sessão WARMING')
  return s.id
}
