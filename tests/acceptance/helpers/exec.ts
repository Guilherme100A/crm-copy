// Execução de comandos de shell e leitura de arquivos a partir da raiz do repositório.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

export const rootPath = (...parts: string[]) => join(ROOT, ...parts)

export const toPosix = (p: string) => p.split('\\').join('/')

export interface ExecResult {
  cmd: string
  code: number
  stdout: string
  stderr: string
  /** stdout + stderr, útil em mensagens de falha */
  output: string
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  input?: string
}

/** Roda um comando via shell e nunca lança: devolve exit code e saídas. */
export function exec(cmd: string, opts: ExecOptions = {}): ExecResult {
  const res = spawnSync(cmd, {
    cwd: opts.cwd ?? ROOT,
    shell: true,
    encoding: 'utf8',
    input: opts.input,
    timeout: opts.timeoutMs ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...opts.env },
  })
  const stdout = res.stdout ?? ''
  const stderr = `${res.stderr ?? ''}${res.error ? `\n[exec error] ${res.error.message}` : ''}`
  return { cmd, code: res.status ?? 1, stdout, stderr, output: `${stdout}\n${stderr}` }
}

/** Últimas N linhas da saída, para mensagens de asserção legíveis. */
export const tail = (r: ExecResult, n = 40) => `$ ${r.cmd} (exit ${r.code})\n${r.output.split('\n').slice(-n).join('\n')}`

/** Garante `node_modules` na raiz (testes que dependem de binários do workspace podem rodar em qualquer ordem). */
export function ensureInstalled(): ExecResult | null {
  if (existsSync(rootPath('node_modules', '.modules.yaml'))) return null
  return exec('pnpm install', { timeoutMs: 900_000 })
}

export function readText(rel: string): string {
  return readFileSync(rootPath(rel), 'utf8')
}

export const fileExists = (rel: string) => existsSync(rootPath(rel))

export function readJson<T = any>(rel: string): T {
  return JSON.parse(readText(rel)) as T
}

/** Parse de JSON com comentários e vírgulas finais (tsconfig). */
export function parseJsonc<T = any>(text: string): T {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inStr = false
    } else if (c === '"') {
      inStr = true
      out += c
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && n === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as T
}

/** Extrai o primeiro valor JSON (objeto/array) de uma saída que pode ter ruído antes/depois. */
export function extractJson<T = any>(text: string): T {
  const start = text.search(/[[{]/)
  if (start < 0) throw new Error(`nenhum JSON na saída:\n${text.slice(0, 500)}`)
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  const end = text.lastIndexOf(close)
  return JSON.parse(text.slice(start, end + 1)) as T
}

/** Arquivos do repositório (rastreados + não rastreados não ignorados), caminhos POSIX relativos à raiz. */
export function repoFiles(): string[] {
  const r = exec('git ls-files -z --cached --others --exclude-standard')
  if (r.code !== 0) throw new Error(tail(r))
  return [...new Set(r.stdout.split('\0').map((s) => s.trim()).filter(Boolean))].filter((f) => existsSync(rootPath(f)))
}
