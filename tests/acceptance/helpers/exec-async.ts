// Execução ASSÍNCRONA de comandos (para rodar suítes em paralelo, T126). Complementa `exec.ts` (síncrono).
// A saída vai para um arquivo de log (suítes completas geram muito texto) e o resultado traz o caminho.
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ROOT } from './exec'

export interface AsyncExecResult {
  cmd: string
  code: number
  ms: number
  timedOut: boolean
  logFile: string
  /** Conteúdo do log (stdout + stderr intercalados). */
  output: () => string
}

export interface AsyncExecOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  logFile: string
}

/**
 * Ambiente "limpo" para um vitest filho: remove o que a execução atual do vitest injeta (VITEST_*, prefixos de fila,
 * NODE_OPTIONS, TEST e NODE_ENV=test), para que o filho calcule os próprios valores como numa execução normal de `pnpm test`.
 */
export function childTestEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^VITEST/.test(k) && k !== 'VITEST_MAX_WORKERS') continue
    if (['CRM_QUEUE_PREFIX', 'WA_QUEUE_PREFIX', 'NODE_ENV', 'NODE_OPTIONS', 'TEST', 'VITE_CJS_IGNORE_WARNING'].includes(k)) continue
    env[k] = v
  }
  return {
    ...env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? '4',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://wsm:wsm@127.0.0.1:5432/crm',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1',
    ANTIBAN_MODE: 'passthrough',
    WA_GATEWAY: 'fake',
    WA_TRANSPORT: 'fake',
    AI_MODE: 'fake',
    MAIL_TRANSPORT: 'memory',
    APP_NAME: 'CRM',
    ...extra,
  }
}

/** Roda um comando via shell, sem lançar; resolve quando termina (ou estoura o tempo e mata a árvore). */
export function execAsync(cmd: string, opts: AsyncExecOptions): Promise<AsyncExecResult> {
  mkdirSync(dirname(opts.logFile), { recursive: true })
  const log = createWriteStream(opts.logFile)
  log.write(`$ ${cmd}\n`)
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: opts.cwd ?? ROOT, shell: true, env: opts.env ?? childTestEnv(), windowsHide: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, opts.timeoutMs ?? 1_800_000)
    child.stdout?.on('data', (d) => log.write(d))
    child.stderr?.on('data', (d) => log.write(d))
    child.on('close', (code) => {
      clearTimeout(timer)
      const ms = Date.now() - started
      log.end(`\n[exit ${code ?? 'null'}${timedOut ? ' (timeout)' : ''} em ${ms} ms]\n`, () =>
        resolve({
          cmd,
          code: code ?? 1,
          ms,
          timedOut,
          logFile: opts.logFile,
          output: () => readFileSync(opts.logFile, 'utf8'),
        }),
      )
    })
  })
}

function killTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* já terminou */
      }
    }
  }
}

/** Últimas N linhas do log (mensagens de asserção). */
export const tailOf = (r: AsyncExecResult, n = 60) => `$ ${r.cmd} (exit ${r.code}${r.timedOut ? ', timeout' : ''})\n${r.output().split('\n').slice(-n).join('\n')}`
